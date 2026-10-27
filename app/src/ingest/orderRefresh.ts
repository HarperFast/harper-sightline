import type { Expectation, GapFinding, OperationalEvent, OrderProjection } from '../domain/model.ts';
import { evaluateOrder, detectorKey, FAILED_RULE, evaluateFailedFulfillment } from '../domain/detector.ts';
import { rebuildProjection } from './projection.ts';
import { DAY_MS, RETENTION_DAYS, type SearchQuery } from '../retention/retention.ts';
import { log, metrics, M } from '../observability/observe.ts';

// Rebuilds an order's projection from its ledger events and runs the detectors
// against it. Deps-injected so it is testable without the Harper runtime; jobs.ts
// wires the real tables.

interface ReadTable {
	get(id: string): Promise<Record<string, unknown> | undefined>;
}

export interface OrderTables {
	events: { search(query: SearchQuery): AsyncIterable<Record<string, unknown>> };
	projections: ReadTable & { put(row: OrderProjection): Promise<void> };
	expectations: ReadTable & { put(row: Expectation): Promise<void> };
	findings: ReadTable & { put(row: GapFinding): Promise<void> };
}

export interface RebuiltOrder {
	projection: OrderProjection;
	evidenceEventIds: string[];
}

// The purge deletes events by receivedAt, so a stored row whose earliest event is
// near the retention cutoff may have lost events a correct rebuild can no longer
// see. The guard stands down a day before the cutoff, which also absorbs clock
// skew between the purging node and this one.
const REBUILD_GUARD_WINDOW_MS = (RETENTION_DAYS - 1) * DAY_MS;

function orderQuery(shopId: string, orderId: string, select?: string[]): SearchQuery {
	return {
		conditions: [
			{ attribute: 'shopId', value: shopId },
			{ attribute: 'resourceId', value: orderId },
		],
		operator: 'and',
		...(select ? { select } : {}),
	};
}

function evidenceIds(rows: Array<Record<string, unknown>>): string[] {
	const ids: string[] = [];
	for (const row of rows) if (typeof row.eventId === 'string') ids.push(row.eventId);
	return ids.sort();
}

function isStaleRebuild(stored: OrderProjection | undefined, rebuilt: OrderProjection, now: number): boolean {
	if ((stored?.eventCount ?? 0) <= (rebuilt.eventCount ?? 0)) return false;
	return (stored?.firstEventAt ?? 0) >= now - REBUILD_GUARD_WINDOW_MS;
}

// Returns what was written, for the detector to reuse; undefined when nothing was
// written, either because the order has no order-linked events or because a
// concurrent writer already stored a row built from more events.
export async function updateOrderProjection(
	tables: OrderTables,
	shopId: string,
	orderId: string,
	now: number,
): Promise<RebuiltOrder | undefined> {
	const rows: Array<Record<string, unknown>> = [];
	for await (const row of tables.events.search(orderQuery(shopId, orderId))) rows.push(row);
	const projection = rebuildProjection(rows as unknown as OperationalEvent[]);
	if (!projection) return undefined;

	const stored = (await tables.projections.get(projection.id)) as OrderProjection | undefined;
	if (isStaleRebuild(stored, projection, now)) {
		metrics.inc(M.projectionStaleSkipped);
		log('debug', 'projection.stale_skipped', {
			shop: shopId,
			order: orderId,
			storedCount: stored?.eventCount,
			rebuiltCount: projection.eventCount,
		});
		return undefined;
	}
	await tables.projections.put(projection);
	return { projection, evidenceEventIds: evidenceIds(rows) };
}

// The failed-attempt detector writes no expectation: it has no deadline, so the
// periodic sweep has nothing to expire and it only needs evaluating on order events.
export async function runDetectorForOrder(
	tables: OrderTables,
	shopId: string,
	orderId: string,
	now: number,
	rebuilt?: RebuiltOrder,
): Promise<void> {
	let projection = rebuilt?.projection;
	let evidenceEventIds = rebuilt?.evidenceEventIds;
	if (!projection || !evidenceEventIds) {
		projection = (await tables.projections.get(`${shopId}:${orderId}`)) as OrderProjection | undefined;
		if (!projection) return;
		const rows: Array<Record<string, unknown>> = [];
		for await (const row of tables.events.search(orderQuery(shopId, orderId, ['eventId']))) rows.push(row);
		evidenceEventIds = evidenceIds(rows);
	}

	const confirmationId = detectorKey(shopId, orderId);
	const [expectation, finding] = await Promise.all([tables.expectations.get(confirmationId), tables.findings.get(confirmationId)]);
	const result = evaluateOrder({
		projection,
		now,
		evidenceEventIds,
		prior: { expectation: expectation as Expectation | undefined, finding: finding as GapFinding | undefined },
	});
	if (result.expectation) await tables.expectations.put(result.expectation);
	if (result.finding) await tables.findings.put(result.finding);

	const failedId = detectorKey(shopId, orderId, FAILED_RULE);
	const priorFailed = (await tables.findings.get(failedId)) as GapFinding | undefined;
	const failed = evaluateFailedFulfillment({ projection, now, evidenceEventIds, prior: { finding: priorFailed } });
	if (failed.finding) await tables.findings.put(failed.finding);
}

export async function refreshOrder(tables: OrderTables, shopId: string, orderId: string, now: number): Promise<void> {
	await runDetectorForOrder(tables, shopId, orderId, now, await updateOrderProjection(tables, shopId, orderId, now));
}
