import type { DigestCadence, EventDomain, GapFinding, OrderProjection } from './model.ts';
import type { QueryTable } from './queries.ts';
import type { DigestInput, DigestOrderRef } from './digest.ts';
import { DETECTOR_FAILED } from './detector.ts';
import { eventKind } from './eventKind.ts';
import { ageHours, isAwaitingConfirmation } from './orders.ts';

// Gathering the digest's inputs. Split from digest.ts because rendering changes
// for editorial reasons and gathering changes for schema reasons.
//
// Every search is constrained by shopId — a digest is the one artifact that
// leaves the app, so cross-tenant bleed here would be the worst possible place
// for it. The adversarial tests in test/digestData.test.ts pin that.

// How many orders to name. Enough to be actionable, few enough that the message
// stays readable and does not become a data export.
export const TOP_AWAITING = 5;

// How far outside the period to look for a webhook event that MATCHES an
// in-period reconciliation event. One day: large enough to cover the ordinary
// near-boundary case (an order created late one day and paid early the next),
// small enough that the extra rows scanned stay proportional to a day of traffic.
// See the delivery-gap comment in gatherDigestInput for why any margin is needed
// at all. This only ever widens MATCHING; it never widens what is reported.
export const MATCH_MARGIN_MS = 86_400_000;

export async function gatherDigestInput(
	tables: { projections: QueryTable; findings: QueryTable; events: QueryTable; deliveries: QueryTable },
	shopId: string,
	cadence: DigestCadence,
	periodStart: number,
	periodEnd: number,
	now: number,
): Promise<DigestInput> {
	// Failed fulfillment attempts DETECTED in the period — Shopify recorded an
	// attempt that did not succeed. Direct evidence of a presence, so it is counted
	// on its own terms and by detection time, which is what makes it a statement
	// about this window.
	//
	// It is NOT a subset of `unconfirmed` below, and must not be presented as one.
	// This count used to be taken inside a loop that incremented `unconfirmed` for
	// every finding first, so the two figures were nested while the bodies printed
	// them as two adjacent, disjoint-looking lines — and it filed a PRESENCE (an
	// attempt Shopify recorded as failed) underneath an ABSENCE headline. The
	// `status === 'unconfirmed'` gate is kept deliberately: it is the same
	// definition getSummary's `findings.failedAttempts` uses, so the digest and the
	// Overview cannot disagree about this number either.
	let failedAttempts = 0;
	for await (const row of tables.findings.search({ conditions: [{ attribute: 'shopId', value: shopId }] })) {
		const finding = row as unknown as GapFinding;
		const detectedAt = finding.detectedAt ?? 0;
		if (detectedAt < periodStart || detectedAt >= periodEnd) continue;
		if (finding.status !== 'unconfirmed') continue;
		if (finding.detector === DETECTOR_FAILED) failedAttempts++;
	}

	// Changes that reached us only through a direct Admin API check — the webhook
	// never arrived. Evidence about OUR capture path only (see the integrity copy).
	//
	// A reconciliation-sourced row alone is NOT that evidence: reconcileShopWithToken
	// (jobs.ts) is a rolling resync, not a gap detector — it writes a synthesized
	// event for every order it touches on every sweep, unconditionally. Webhook and
	// reconciliation event ids can never collide, so a healthy webhook delivery is
	// routinely followed by a matching reconciliation event for the SAME change on
	// the next sweep, and both rows persist. Counting that pair as a gap would tell
	// a merchant their webhook failed when it did not — the exact false alarm the
	// safety bias forbids (see src/eventKind.ts). A reconciliation event counts as a
	// gap only when no webhook-sourced event for the same (resourceId, kind) is
	// found alongside it.
	//
	// Matching is BEST-EFFORT, and the reason is worth stating plainly: the two
	// paths derive `occurredAt` from DIFFERENT fields, so a webhook event and its
	// reconciliation twin do NOT carry the same instant, for any of the four kinds.
	//
	//   kind        webhook (src/normalize.ts)   reconciliation (src/reconcile.ts)
	//   paid        order updated_at             order createdAt ?? updatedAt
	//   cancelled   order updated_at             order cancelledAt
	//   fulfilled   fulfillment updated_at       order fulfilledAt ?? updatedAt
	//   refunded    refund processed_at          order updatedAt
	//
	// Two observations of one change can therefore be minutes or days apart, in
	// EITHER direction (`paid` and `cancelled` put the reconciliation twin earlier,
	// `refunded` puts it later), which is enough to split them across a period
	// boundary. So the webhook key-set is gathered over a window widened by a day on
	// each side, while only IN-PERIOD reconciliation rows are ever candidates: the
	// same single query with wider bounds, no extra round trip. That closes the
	// ordinary near-boundary case — an order created at 23:55 and paid at 00:05 the
	// next day used to produce a digest whose only content was a false claim that a
	// webhook had not arrived — without pretending the general problem is solved. A
	// pair separated by more than the margin still fails to collide and is still
	// over-counted, and over-counting a capture gap is the direction this product's
	// safety bias cares about, so this is a known residual rather than a guarantee.
	const webhookKeys = new Set<string>();
	const reconciliationCandidates: Array<{ resourceId: string; kind: ReturnType<typeof eventKind> }> = [];
	for await (const row of tables.events.search({
		conditions: [
			{ attribute: 'shopId', value: shopId },
			{ attribute: 'occurredAt', value: periodStart - MATCH_MARGIN_MS, comparator: 'greater_than_equal' },
			{ attribute: 'occurredAt', value: periodEnd + MATCH_MARGIN_MS, comparator: 'less_than' },
		],
		operator: 'and',
		// occurredAt is selected because the widened query now returns rows OUTSIDE
		// the period, and the in-period test below is what keeps the gap count
		// period-scoped.
		select: ['resourceId', 'domain', 'state', 'topic', 'source', 'occurredAt'],
	})) {
		const resourceId = typeof row.resourceId === 'string' ? row.resourceId : undefined;
		const kind = eventKind({
			domain: row.domain as EventDomain,
			state: row.state as string | undefined,
			topic: row.topic as string | undefined,
		});
		if (String(row.source) === 'reconciliation') {
			// Only the period's own reconciliation rows are candidates — the margin
			// exists to find MATCHES, never to widen what the digest reports on.
			const occurredAt = Number(row.occurredAt);
			if (!(occurredAt >= periodStart && occurredAt < periodEnd)) continue;
			// Safety bias: a reconciliation event whose kind cannot be determined is
			// never treated as a capture-gap candidate.
			if (resourceId !== undefined && kind !== undefined) reconciliationCandidates.push({ resourceId, kind });
		} else if (resourceId !== undefined && kind !== undefined) {
			// Webhook rows from the margin DO count towards matching. That is the
			// entire point: the twin whose timestamp fell just outside the period is
			// exactly the evidence that the webhook path worked.
			webhookKeys.add(`${resourceId}:${kind}`);
		}
	}
	// Second pass over the already-fetched candidates, not a second query.
	let deliveryGaps = 0;
	for (const c of reconciliationCandidates) {
		if (!webhookKeys.has(`${c.resourceId}:${c.kind}`)) deliveryGaps++;
	}

	// Recorder health, so a digest can never report "all quiet" from an incomplete
	// pipeline. Same signal the Overview uses.
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

	// The orders awaiting fulfillment confirmation, as of NOW rather than as of the
	// period end: a merchant acting on this message needs the current wait.
	// `isAwaitingConfirmation` / `ageHours` come from src/orders.ts — the single
	// definition the Overview and the worklist also use, so a digest can never
	// name a different set of orders, or a different age for one, than the app.
	//
	// This ONE loop produces both the headline count and the list beneath it, which
	// is the point. The headline used to be a count of unconfirmed GapFinding rows
	// detected in the period, rendered under an "orders awaiting" label — three
	// defects at once. Findings are not orders: `detectorKey()` is
	// `${detector}:${shopId}:${orderId}:${ruleVersion}` and both detectors run per
	// order independently, so one order past its deadline that ALSO had a failed
	// attempt produced two findings and was counted as two "orders". And the number
	// disagreed with the list printed directly below it, and with the Overview tile
	// — three populations, one label. Deriving the count from the same iteration
	// that builds the list makes number-equals-list true by construction rather
	// than by agreement, and `isAwaitingConfirmation` is what makes it agree with
	// getSummary's `orders.awaitingConfirmation` (pinned by a test that asserts the
	// two are equal on one fixture).
	//
	// One divergence from that tile remains, and it is deliberate: getSummary also
	// bounds its projection scan to the 7-day read window (`windowCondition`),
	// while this scan does not. An order still awaiting past that window — purge
	// residue, since retention normally removes it — is counted and named here but
	// absent from the Overview. Bounding it identically would mean silently
	// dropping the oldest, most overdue orders from the one message whose job is to
	// surface them, so the digest keeps the wider set.
	//
	// So when the two numbers disagree, THIS is the more complete one, and it can
	// only ever be the higher: an order that has been awaiting for ten days is still
	// awaiting, and telling the merchant so is the entire point of the message. The
	// fix for a disagreement is never to bound this scan — see the note on the
	// equality assertion in test/digestData.test.ts, which explains how to read the
	// direction of the difference.
	const awaiting: DigestOrderRef[] = [];
	for await (const row of tables.projections.search({ conditions: [{ attribute: 'shopId', value: shopId }] })) {
		const p = row as unknown as OrderProjection;
		if (!isAwaitingConfirmation(p)) continue;
		const hours = ageHours(p.paidAt, now);
		// isAwaitingConfirmation already requires p.paidAt !== undefined, so this is
		// always defined here; the check keeps the `number | undefined` honest
		// without a cast, rather than asserting past it.
		if (hours === undefined) continue;
		awaiting.push({ orderName: p.orderName, orderId: p.orderId, ageHours: hours });
	}
	awaiting.sort((a, b) => b.ageHours - a.ageHours);

	return {
		shopId,
		cadence,
		periodStart,
		periodEnd,
		// Orders, not findings — and every one of them is in `awaiting`, of which
		// topAwaiting is the first TOP_AWAITING entries.
		unconfirmed: awaiting.length,
		failedAttempts,
		deliveryGaps,
		recorderHealthy: deadLettered === 0,
		deadLettered,
		topAwaiting: awaiting.slice(0, TOP_AWAITING),
	};
}
