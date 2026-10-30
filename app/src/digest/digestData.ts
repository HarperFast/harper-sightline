import type { DigestCadence, EventDomain, GapFinding, OrderProjection } from '../domain/model.ts';
import type { QueryTable } from '../api/queries.ts';
import type { DigestInput, DigestOrderRef } from './digest.ts';
import { DETECTOR_FAILED } from '../domain/detector.ts';
import { eventKind, MATCH_MARGIN_MS } from '../domain/eventKind.ts';
import { ageHours, isAwaitingConfirmation } from '../domain/orders.ts';

// Gathers the digest's inputs. Every search is constrained by shopId: the digest
// is the one artifact that leaves the app (test/digestData.test.ts pins this).

// Enough to act on without becoming a data export.
export const TOP_AWAITING = 5;

// MATCH_MARGIN_MS (src/domain/eventKind.ts): this window is closed on both ends, so
// the margin widens both edges, unlike getSummary whose window ends at `now`.

export async function gatherDigestInput(
	tables: { projections: QueryTable; findings: QueryTable; events: QueryTable; deliveries: QueryTable },
	shopId: string,
	cadence: DigestCadence,
	periodStart: number,
	periodEnd: number,
	now: number,
): Promise<DigestInput> {
	// ORDERS with a failed-attempt finding detected in the period. One finding exists
	// per (order, ruleVersion), so two failed attempts on one order count once. Not a
	// subset of `ordersAwaiting`. The `status === 'unconfirmed'` gate is the same
	// definition getSummary's `findings.failedAttempts` uses.
	let failedAttemptsInPeriod = 0;
	for await (const row of tables.findings.search({ conditions: [{ attribute: 'shopId', value: shopId }] })) {
		const finding = row as unknown as GapFinding;
		const detectedAt = finding.detectedAt ?? 0;
		if (detectedAt < periodStart || detectedAt >= periodEnd) continue;
		if (finding.status !== 'unconfirmed') continue;
		if (finding.detector === DETECTOR_FAILED) failedAttemptsInPeriod++;
	}

	// Changes that reached us only through a direct Admin API check (the webhook never
	// arrived). A reconciliation row alone is not that evidence: the sweep writes a
	// synthesized event for every order it touches, so a healthy webhook is routinely
	// followed by a matching reconciliation event. A reconciliation event counts as a
	// gap only when no webhook event for the same (resourceId, kind) is found.
	//
	// Matching is best-effort: the two paths take `occurredAt` from different fields
	// (src/ingest/normalize.ts vs src/shopify/reconcile.ts), so twins can be minutes or
	// days apart in either direction and straddle a period boundary. The webhook
	// key-set is gathered over a window widened by MATCH_MARGIN_MS on each side while
	// only in-period reconciliation rows are candidates. A pair further apart than the
	// margin is still over-counted, the direction the safety bias prefers.
	const webhookKeys = new Set<string>();
	const reconciliationCandidates: Array<{ resourceId: string; kind: ReturnType<typeof eventKind> }> = [];
	for await (const row of tables.events.search({
		conditions: [
			{ attribute: 'shopId', value: shopId },
			{ attribute: 'occurredAt', value: periodStart - MATCH_MARGIN_MS, comparator: 'greater_than_equal' },
			{ attribute: 'occurredAt', value: periodEnd + MATCH_MARGIN_MS, comparator: 'less_than' },
		],
		operator: 'and',
		// Selected because the widened query returns rows outside the period.
		select: ['resourceId', 'domain', 'state', 'topic', 'source', 'occurredAt'],
	})) {
		const resourceId = typeof row.resourceId === 'string' ? row.resourceId : undefined;
		const kind = eventKind({
			domain: row.domain as EventDomain,
			state: row.state as string | undefined,
			topic: row.topic as string | undefined,
		});
		if (String(row.source) === 'reconciliation') {
			// Margin rows exist to find matches, not to widen what the digest reports.
			const occurredAt = Number(row.occurredAt);
			if (!(occurredAt >= periodStart && occurredAt < periodEnd)) continue;
			// A reconciliation event of unknown kind is never a gap candidate.
			if (resourceId !== undefined && kind !== undefined) reconciliationCandidates.push({ resourceId, kind });
		} else if (resourceId !== undefined && kind !== undefined) {
			// Margin webhook rows count toward matching: a twin just outside the period proves the webhook worked.
			webhookKeys.add(`${resourceId}:${kind}`);
		}
	}
	// Second pass over the fetched candidates, not a second query.
	let deliveryGaps = 0;
	for (const c of reconciliationCandidates) {
		if (!webhookKeys.has(`${c.resourceId}:${c.kind}`)) deliveryGaps++;
	}

	// A digest must not report "all quiet" from an incomplete pipeline; same signal as the Overview.
	let deadLettered = 0;
	for await (const _row of tables.deliveries.search({
		conditions: [
			{ attribute: 'shopId', value: shopId },
			{ attribute: 'status', value: 'dead_letter' },
		],
		operator: 'and',
		select: ['id'],
	})) {
		deadLettered++;
	}

	// Orders awaiting confirmation as of now, not the period end, using the Overview's
	// `isAwaitingConfirmation` / `ageHours` (src/domain/orders.ts). One loop yields both
	// the count and the list, so they agree by construction; the count is of orders, not
	// findings (one order can carry two).
	//
	// Unlike getSummary this scan is not bounded to the 7-day window: an order awaiting
	// longer (purge residue) is named here though absent from the Overview. That is
	// deliberate, because bounding it would drop the most overdue orders from the
	// message meant to surface them, so a disagreement means this count is higher. See
	// the equality assertion in test/digestData.test.ts.
	const awaiting: DigestOrderRef[] = [];
	for await (const row of tables.projections.search({ conditions: [{ attribute: 'shopId', value: shopId }] })) {
		const p = row as unknown as OrderProjection;
		if (!isAwaitingConfirmation(p)) continue;
		const hours = ageHours(p.paidAt, now);
		// Always defined here; keeps the `number | undefined` honest without a cast.
		if (hours === undefined) continue;
		awaiting.push({ orderName: p.orderName, orderId: p.orderId, ageHours: hours });
	}
	awaiting.sort((a, b) => b.ageHours - a.ageHours);

	return {
		shopId,
		cadence,
		periodStart,
		periodEnd,
		// Orders, not findings; topAwaiting is the first TOP_AWAITING of `awaiting`.
		ordersAwaiting: awaiting.length,
		failedAttemptsInPeriod,
		deliveryGaps,
		recorderHealthy: deadLettered === 0,
		deadLettered,
		topAwaiting: awaiting.slice(0, TOP_AWAITING),
	};
}
