import type { Expectation, GapFinding, OperationalEvent, OrderProjection } from '../domain/model.ts';
import { evaluateOrder, detectorKey, FAILED_RULE, evaluateFailedFulfillment } from '../domain/detector.ts';
import { rebuildProjection } from './projection.ts';
import { DAY_MS, RETENTION_DAYS, type SearchQuery } from '../retention/retention.ts';
import { log, metrics, M } from '../observability/observe.ts';

interface ReadTable {
	get(id: string): Promise<Record<string, unknown> | null>;
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

// The purge deletes by receivedAt, so a stored row whose earliest event is near the
// cutoff may have lost events a rebuild can no longer see. The guard stands down a
// day before the cutoff, which also absorbs clock skew between nodes.
const REBUILD_GUARD_WINDOW_MS = (RETENTION_DAYS - 1) * DAY_MS;

// Keys on resourceId alone: Harper's `and` walks the low-cardinality shopId index, which grows with
// the shop's whole ledger (14 ms against 0.4 ms at 160k events). The tenant is enforced on the rows.
async function orderEvents(
	tables: OrderTables,
	shopId: string,
	orderId: string,
	select?: string[],
): Promise<Array<Record<string, unknown>>> {
	const rows: Array<Record<string, unknown>> = [];
	for await (const row of tables.events.search({
		conditions: [{ attribute: 'resourceId', value: orderId }],
		operator: 'and',
		...(select ? { select: [...select, 'shopId'] } : {}),
	})) {
		if (row.shopId === shopId) rows.push(row);
	}
	return rows;
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

// Rebuilds from all of the order's ledger events: recomputing the full state
// (commutative reducer) is order-safe, and a lost write self-heals on the next
// event. A writer that read fewer events than the stored row was built from is not
// written, which narrows but does not close the lost-update race. Returns what was
// written, for the detector to reuse; undefined when the order has no order-linked
// events or a concurrent writer stored a row built from more.
export async function updateOrderProjection(
	tables: OrderTables,
	shopId: string,
	orderId: string,
	now: number,
): Promise<RebuiltOrder | undefined> {
	const rows = await orderEvents(tables, shopId, orderId);
	const projection = rebuildProjection(rows as unknown as OperationalEvent[]);
	if (!projection) return undefined;

	const stored = ((await tables.projections.get(projection.id)) ?? undefined) as OrderProjection | undefined;
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

// The failed-attempt detector has no deadline and writes no expectation; it is only
// evaluated on order events.
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
		projection = ((await tables.projections.get(`${shopId}:${orderId}`)) ?? undefined) as OrderProjection | undefined;
		if (!projection) return;
		evidenceEventIds = evidenceIds(await orderEvents(tables, shopId, orderId, ['eventId']));
	}

	const confirmationId = detectorKey(shopId, orderId);
	const [expectation, finding] = await Promise.all([tables.expectations.get(confirmationId), tables.findings.get(confirmationId)]);
	const result = evaluateOrder({
		projection,
		now,
		evidenceEventIds,
		prior: {
			expectation: (expectation ?? undefined) as Expectation | undefined,
			finding: (finding ?? undefined) as GapFinding | undefined,
		},
	});
	if (result.expectation) await tables.expectations.put(result.expectation);
	if (result.finding) await tables.findings.put(result.finding);

	const failedId = detectorKey(shopId, orderId, FAILED_RULE);
	const priorFailed = ((await tables.findings.get(failedId)) ?? undefined) as GapFinding | undefined;
	const failed = evaluateFailedFulfillment({ projection, now, evidenceEventIds, prior: { finding: priorFailed } });
	if (failed.finding) await tables.findings.put(failed.finding);
}

export async function refreshOrder(tables: OrderTables, shopId: string, orderId: string, now: number): Promise<void> {
	await runDetectorForOrder(tables, shopId, orderId, now, await updateOrderProjection(tables, shopId, orderId, now));
}
