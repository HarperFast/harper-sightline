import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTable } from './fakeTable.ts';
import { gatherDigestInput, TOP_AWAITING } from '../src/digestData.ts';
import { getSummary, type QueryTable } from '../src/queries.ts';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.parse('2026-08-05T14:30:00Z');
const PERIOD_START = Date.parse('2026-08-04T00:00:00Z');
const PERIOD_END = Date.parse('2026-08-05T00:00:00Z');

function tables() {
	return {
		// oB (30h) is inserted before oA (100h) so insertion order CONTRADICTS the
		// sorted (oldest-first) order the assertions below expect — otherwise the
		// sort in gatherDigestInput could be deleted and the test would still pass.
		projections: new FakeTable('id', [
			{
				id: 's1:oB',
				shopId: 's1',
				orderId: 'oB',
				orderName: '#1002',
				paidAt: NOW - 30 * HOUR,
				requiresFulfillment: true,
				lastEventAt: NOW - 30 * HOUR,
			},
			{
				id: 's1:oA',
				shopId: 's1',
				orderId: 'oA',
				orderName: '#1001',
				paidAt: NOW - 100 * HOUR,
				requiresFulfillment: true,
				lastEventAt: NOW - 100 * HOUR,
			},
			{
				id: 's1:oC',
				shopId: 's1',
				orderId: 'oC',
				orderName: '#1003',
				paidAt: NOW - 5 * HOUR,
				requiresFulfillment: true,
				fulfilledAt: NOW - 4 * HOUR,
				lastEventAt: NOW - 4 * HOUR,
			},
			{
				id: 's2:oA',
				shopId: 's2',
				orderId: 'oA',
				orderName: '#9999',
				paidAt: NOW - 50 * HOUR,
				requiresFulfillment: true,
				lastEventAt: NOW - 50 * HOUR,
			},
			// The three rows below are awaiting-negative for a reason OTHER than
			// "not paid" or "already fulfilled" — the reasons `isAwaitingConfirmation`
			// (src/orders.ts) has its own clauses for. Without them, a predicate change
			// on either surface that drops one of those clauses but keeps `paidAt !==
			// undefined && fulfilledAt === undefined` is count-preserving on this
			// fixture and slips past the equality assertion below undetected. They must
			// not change any expected count in this file: all three fail
			// `isAwaitingConfirmation` for the same reason they fail the naive
			// "paid and not fulfilled" stand-in, so `ordersAwaiting` /
			// `awaitingConfirmation` stay 2 either way.
			{
				// Paid, then called off. `requiresFulfillment: true` so the ONLY reason
				// this is not awaiting is `cancelledAt`, not a missing eligibility latch.
				id: 's1:oCancelled',
				shopId: 's1',
				orderId: 'oCancelled',
				orderName: '#1004',
				paidAt: NOW - 20 * HOUR,
				requiresFulfillment: true,
				cancelledAt: NOW - 10 * HOUR,
				lastEventAt: NOW - 10 * HOUR,
			},
			{
				// A digital order: zero fulfillable units observed, so the
				// `requiresFulfillment` latch never fires and the field is left
				// `undefined` — exactly as test/orders.test.ts documents the reducer
				// actually producing it. This is the `no_fulfillment_expected` lane, and
				// it must not be mistaken for "fulfilled" or for "awaiting".
				id: 's1:oDigital',
				shopId: 's1',
				orderId: 'oDigital',
				orderName: '#1005',
				paidAt: NOW - 15 * HOUR,
				lastEventAt: NOW - 15 * HOUR,
			},
			{
				// Paid, then fully refunded before any fulfillment was observed.
				// `requiresFulfillment: true` so the ONLY reason this is not awaiting is
				// `fullyRefundedAt`.
				id: 's1:oRefunded',
				shopId: 's1',
				orderId: 'oRefunded',
				orderName: '#1006',
				paidAt: NOW - 25 * HOUR,
				requiresFulfillment: true,
				fullyRefundedAt: NOW - 8 * HOUR,
				lastEventAt: NOW - 8 * HOUR,
			},
		]),
		findings: new FakeTable('id', [
			{
				id: 'fulfillment_confirmation:s1:oA:1',
				shopId: 's1',
				orderId: 'oA',
				detector: 'fulfillment_confirmation',
				status: 'unconfirmed',
				detectedAt: PERIOD_START + HOUR,
			},
			{
				id: 'fulfillment_attempt_failed:s1:oB:1',
				shopId: 's1',
				orderId: 'oB',
				detector: 'fulfillment_attempt_failed',
				status: 'unconfirmed',
				detectedAt: PERIOD_START + 2 * HOUR,
			},
			{
				// The SAME order as the failed-attempt finding above. Both detectors run
				// per order independently (detectorKey is
				// `${detector}:${shopId}:${orderId}:${ruleVersion}`), so an order past its
				// deadline that also had a failed attempt produces two findings — which is
				// exactly why a findings count cannot be labelled as an orders count. With
				// this row the fixture has THREE in-period unconfirmed findings across TWO
				// awaiting orders, so the two numbers are distinguishable and the
				// assertions below can tell which one the code is reporting.
				id: 'fulfillment_confirmation:s1:oB:1',
				shopId: 's1',
				orderId: 'oB',
				detector: 'fulfillment_confirmation',
				status: 'unconfirmed',
				detectedAt: PERIOD_START + 2 * HOUR,
			},
			{
				id: 'fulfillment_confirmation:s1:oOld:1',
				shopId: 's1',
				orderId: 'oOld',
				detector: 'fulfillment_confirmation',
				status: 'resolved',
				detectedAt: PERIOD_START + 3 * HOUR,
			},
			{
				id: 'fulfillment_confirmation:s2:oA:1',
				shopId: 's2',
				orderId: 'oA',
				detector: 'fulfillment_confirmation',
				status: 'unconfirmed',
				detectedAt: PERIOD_START + HOUR,
			},
		]),
		events: new FakeTable('eventId', [
			{
				eventId: 's1:e1',
				shopId: 's1',
				domain: 'order',
				source: 'webhook',
				occurredAt: PERIOD_START + HOUR,
				receivedAt: PERIOD_START + HOUR,
			},
			{
				// resourceId/topic/state are what eventKind reads to determine a kind
				// (and what the caller needs to build a (resourceId, kind) key) — every
				// real reconciliation row carries them (src/reconcile.ts's reconEvent
				// always sets resourceId), so a fixture row without them is not a
				// realistic "no matching webhook" gap, it is an untestable one.
				eventId: 'recon:s1:o9:paid',
				shopId: 's1',
				domain: 'order',
				topic: 'orders/paid',
				resourceId: 'o9',
				state: 'paid',
				source: 'reconciliation',
				occurredAt: PERIOD_START + 2 * HOUR,
				receivedAt: PERIOD_START + 2 * HOUR,
			},
			{
				eventId: 'recon:s1:oOut:paid',
				shopId: 's1',
				domain: 'order',
				topic: 'orders/paid',
				resourceId: 'oOut',
				state: 'paid',
				source: 'reconciliation',
				occurredAt: PERIOD_START - 5 * DAY,
				receivedAt: PERIOD_START - 5 * DAY,
			},
			{
				eventId: 'recon:s2:o9:paid',
				shopId: 's2',
				domain: 'order',
				topic: 'orders/paid',
				resourceId: 'o9',
				state: 'paid',
				source: 'reconciliation',
				occurredAt: PERIOD_START + 2 * HOUR,
				receivedAt: PERIOD_START + 2 * HOUR,
			},
		]),
		deliveries: new FakeTable('id', [
			{ id: 's1:d1', shopId: 's1', status: 'processed', receivedAt: PERIOD_START },
			// A second tenant's dead letter, in every test's fixture — not just the one
			// test that adds an s1 row — so nothing can drop the deliveries shopId
			// condition without a test noticing. deadLettered drives recorderHealthy,
			// which drives the subject line, so a leak here would make one shop's
			// delivery failure show up as "Sightline needs attention" in ANOTHER
			// shop's digest.
			{ id: 's2:d1', shopId: 's2', status: 'dead_letter', receivedAt: PERIOD_START },
		]),
	};
}

test('counts are scoped to the shop and to the period', async () => {
	const input = await gatherDigestInput(tables(), 's1', 'daily', PERIOD_START, PERIOD_END, NOW);
	// TWO awaiting orders (oA, oB), not the THREE unconfirmed findings detected in
	// the period — oB carries both a confirmation finding and a failed-attempt
	// finding, and counting findings would report it twice as an "order".
	assert.equal(input.ordersAwaiting, 2, 'orders awaiting confirmation, one entry per order');
	assert.equal(input.topAwaiting.length, input.ordersAwaiting, 'the headline count and the list beneath it are one population');
	// Counted independently, not as a subset of the headline: this is a presence
	// (Shopify recorded an attempt that did not succeed), scoped to the period.
	assert.equal(input.failedAttemptsInPeriod, 1);
	assert.equal(input.deliveryGaps, 1, 'only the in-period reconciliation-only event');
	assert.equal(input.shopId, 's1');
	assert.equal(input.cadence, 'daily');
	assert.equal(input.periodStart, PERIOD_START);
	assert.equal(input.periodEnd, PERIOD_END);
	assert.equal(input.recorderHealthy, true, "another tenant's dead letter must not make this shop's recorder look unhealthy");
	assert.equal(input.deadLettered, 0);
});

// THE structural guard for the headline count. The digest's `ordersAwaiting` and the
// Overview's `orders.awaitingConfirmation` must be the same number for the same
// shop, because they are the same claim rendered on two surfaces — the
// Notifications screen literally promises the digest reports "How many orders are
// awaiting fulfillment confirmation", which is the Overview's tile.
//
// This is the assertion that would have caught the original defect: the digest
// counted GapFinding rows while the tile counted orders, so on this fixture the
// digest said 3 and the tile said 2. It fails if EITHER side drifts — a
// reintroduced findings count on the digest side, or a changed predicate on the
// Overview side — which is why it derives both numbers rather than hardcoding one.
//
// Both are computed over the same fixture. Note the one legitimate divergence,
// avoided here on purpose: getSummary bounds its projection scan to the 7-day read
// window on `lastEventAt`, while the digest does not, so a fixture row older than
// that would make the two differ for a reason that is not a defect (see the
// comment in gatherDigestInput). Every projection in `tables()` is inside the
// window, so this equality is honest rather than accidental.
//
// IF YOU SEE THESE TWO DISAGREE IN PRODUCTION, the digest is the number to trust,
// and the direction tells you which case you are in. The digest can only be the
// HIGHER of the two, and only by counting orders that are genuinely still awaiting
// but whose last event predates the read window — purge residue, which retention
// normally removes. Those orders are the most overdue ones the shop has, so the
// digest is the more COMPLETE figure and the Overview is the one omitting them. Do
// not "fix" that by bounding the digest's scan to the same window: it would make
// the digest under-report real awaiting orders to win this assertion, which trades
// the product's truth for a green test. A digest LOWER than the tile, or a gap
// bigger than the residue explanation supports, is a real defect — start with
// whether either side stopped using `isAwaitingConfirmation`.
test('the digest reports the same awaiting count as the Overview tile, for the same shop', async () => {
	const t = tables();
	const input = await gatherDigestInput(t, 's1', 'daily', PERIOD_START, PERIOD_END, NOW);
	const summary = await getSummary(
		{
			events: t.events as unknown as QueryTable,
			projections: t.projections as unknown as QueryTable,
			findings: t.findings as unknown as QueryTable,
			deliveries: t.deliveries as unknown as QueryTable,
			shops: new FakeTable('shopId', [{ shopId: 's1' }]) as unknown as QueryTable,
		},
		's1',
		NOW,
	);
	const orders = summary.orders as { awaitingConfirmation: number };
	assert.equal(input.ordersAwaiting, orders.awaitingConfirmation);
	// Not vacuously equal because both are zero, and not equal to the findings count
	// either — the fixture has three in-period unconfirmed findings for s1.
	assert.equal(orders.awaitingConfirmation, 2);
	// The same agreement for the failed-attempt figure, which the two surfaces also
	// both publish. getSummary's is unbounded in time and the digest's is scoped to
	// the period; they coincide here because the fixture's only failed-attempt
	// finding falls inside the period, and that is asserted rather than assumed.
	const findings = summary.findings as { failedAttempts: number };
	assert.equal(input.failedAttemptsInPeriod, findings.failedAttempts);
});

test('the longest-waiting orders are listed oldest first and capped', async () => {
	const input = await gatherDigestInput(tables(), 's1', 'daily', PERIOD_START, PERIOD_END, NOW);
	assert.deepEqual(
		input.topAwaiting.map((o) => o.orderName),
		['#1001', '#1002'],
	);
	assert.equal(input.topAwaiting[0].ageHours, 100);
	assert.ok(input.topAwaiting.length <= TOP_AWAITING);
});

test('a fulfilled order is not listed as waiting', async () => {
	const input = await gatherDigestInput(tables(), 's1', 'daily', PERIOD_START, PERIOD_END, NOW);
	assert.equal(
		input.topAwaiting.some((o) => o.orderName === '#1003'),
		false,
	);
});

test('another tenant data never appears in a digest', async () => {
	const input = await gatherDigestInput(tables(), 's1', 'daily', PERIOD_START, PERIOD_END, NOW);
	assert.equal(
		input.topAwaiting.some((o) => o.orderName === '#9999'),
		false,
	);
	assert.equal(input.ordersAwaiting, 2);
});

test('dead-lettered deliveries make the recorder unhealthy', async () => {
	const t = tables();
	await t.deliveries.put({ id: 's1:d2', shopId: 's1', status: 'dead_letter', receivedAt: PERIOD_START });
	const input = await gatherDigestInput(t, 's1', 'daily', PERIOD_START, PERIOD_END, NOW);
	assert.equal(input.recorderHealthy, false);
	// 1, not 2: the fixture's other dead letter belongs to s2 and must not be
	// counted into this shop's total.
	assert.equal(input.deadLettered, 1);
});

test('a webhook event and its reconciliation twin for the same order and change are not a delivery gap', async () => {
	// This is the exact defect a reviewer proved empirically: a healthy webhook
	// delivery followed by the next reconcile sweep's synthesized event for the
	// SAME change used to count as "the webhook never arrived". It must count 0.
	const t = tables();
	await t.events.put({
		eventId: 's1:webhook-o10',
		shopId: 's1',
		domain: 'order',
		topic: 'orders/paid',
		resourceId: 'o10',
		state: 'paid',
		source: 'webhook',
		occurredAt: PERIOD_START + HOUR,
		receivedAt: PERIOD_START + HOUR,
	});
	await t.events.put({
		eventId: 'recon:s1:o10:paid',
		shopId: 's1',
		domain: 'order',
		topic: 'orders/paid',
		resourceId: 'o10',
		state: 'paid',
		source: 'reconciliation',
		// The order's own timestamp, not the sweep time — this is what keeps a
		// matching pair in the same period without any special-casing.
		occurredAt: PERIOD_START + 2 * HOUR,
		receivedAt: PERIOD_START + 2 * HOUR,
	});
	const input = await gatherDigestInput(t, 's1', 'daily', PERIOD_START, PERIOD_END, NOW);
	// 1, not 2: o10's reconciliation event is matched by its webhook twin, so only
	// o9 (fixture, no webhook counterpart) remains a gap.
	assert.equal(input.deliveryGaps, 1, 'a matched reconciliation event is not counted alongside the genuine o9 gap');
});

test('a reconciliation event with no matching webhook event is still counted as a delivery gap', async () => {
	// Proves the fix did not simply zero the number out: a genuine gap (no
	// webhook counterpart at all) must still be reported.
	const t = tables();
	await t.events.put({
		eventId: 'recon:s1:o11:cancelled',
		shopId: 's1',
		domain: 'order',
		topic: 'orders/cancelled',
		resourceId: 'o11',
		state: 'voided',
		source: 'reconciliation',
		occurredAt: PERIOD_START + 3 * HOUR,
		receivedAt: PERIOD_START + 3 * HOUR,
	});
	const input = await gatherDigestInput(t, 's1', 'daily', PERIOD_START, PERIOD_END, NOW);
	// 2: the fixture's o9 gap plus this new o11 gap, neither matched by a webhook.
	assert.equal(input.deliveryGaps, 2);
});

// A pair whose two observations carry timestamps from different moments, straddling
// a period edge. Only the events table matters here, so the other three are empty:
// an isolated pair with nothing else in scope means the asserted 0 is about this
// pair and nothing else.
function eventsOnly(rows: Array<Record<string, unknown>>) {
	return {
		projections: new FakeTable('id', []),
		findings: new FakeTable('id', []),
		events: new FakeTable('eventId', rows),
		deliveries: new FakeTable('id', []),
	};
}

function paidPair(resourceId: string, reconAt: number, webhookAt: number): Array<Record<string, unknown>> {
	return [
		{
			// synthesizeEvents (src/reconcile.ts) dates a `paid` event from the order's
			// createdAt, not from the payment.
			eventId: `recon:s1:${resourceId}:paid`,
			shopId: 's1',
			domain: 'order',
			topic: 'orders/paid',
			resourceId,
			state: 'paid',
			source: 'reconciliation',
			occurredAt: reconAt,
			receivedAt: reconAt,
		},
		{
			// normalizeOrder dates it from the payload's updated_at — the payment.
			eventId: `s1:webhook-${resourceId}`,
			shopId: 's1',
			domain: 'order',
			topic: 'orders/paid',
			resourceId,
			state: 'paid',
			source: 'webhook',
			occurredAt: webhookAt,
			receivedAt: webhookAt,
		},
	];
}

// The concrete case: an order CREATED 2026-08-03T23:55Z and PAID 2026-08-04T00:05Z,
// webhook delivered normally. The reconciliation twin carries the creation time, so
// it lands in the 08-03 period while its webhook twin lands ten minutes into 08-04.
// Before the match margin the pair never collided, and the 08-03 digest existed
// solely to tell the merchant a webhook had not arrived when it had.
test('a pair split across the END of the period still collides, so a normal delivery is not reported as a gap', async () => {
	const periodStart = Date.parse('2026-08-03T00:00:00Z');
	const periodEnd = Date.parse('2026-08-04T00:00:00Z');
	const t = eventsOnly(paidPair('o20', Date.parse('2026-08-03T23:55:00Z'), Date.parse('2026-08-04T00:05:00Z')));
	const input = await gatherDigestInput(t, 's1', 'daily', periodStart, periodEnd, NOW);
	assert.equal(input.deliveryGaps, 0, 'the webhook twin is ten minutes past periodEnd, not missing');
});

// The mirror case, which `refunded` produces routinely: the reconciliation twin is
// dated from the order's updatedAt and so lands LATER than the webhook's
// processed_at. Same defect, other edge.
test('a pair split across the START of the period still collides', async () => {
	const periodStart = Date.parse('2026-08-04T00:00:00Z');
	const periodEnd = Date.parse('2026-08-05T00:00:00Z');
	const t = eventsOnly(paidPair('o21', Date.parse('2026-08-04T00:05:00Z'), Date.parse('2026-08-03T23:55:00Z')));
	const input = await gatherDigestInput(t, 's1', 'daily', periodStart, periodEnd, NOW);
	assert.equal(input.deliveryGaps, 0, 'the webhook twin is ten minutes before periodStart, not missing');
});

// The margin widens MATCHING only. A reconciliation event that is itself outside the
// period — but now inside the widened query — must not be reported: before the
// widening the query excluded it, so this is the property the code, not the query,
// has to enforce from here on.
test('a reconciliation event inside the match margin but outside the period is not reported as a gap', async () => {
	const periodStart = Date.parse('2026-08-04T00:00:00Z');
	const periodEnd = Date.parse('2026-08-05T00:00:00Z');
	const t = eventsOnly([
		// Two hours BEFORE the period, unmatched. And two hours after it, likewise.
		...paidPair('oBefore', Date.parse('2026-08-03T22:00:00Z'), Date.parse('2026-08-03T22:00:00Z')).slice(0, 1),
		...paidPair('oAfter', Date.parse('2026-08-05T02:00:00Z'), Date.parse('2026-08-05T02:00:00Z')).slice(0, 1),
		// One genuinely in-period unmatched reconciliation event, so the assertion
		// below distinguishes "the margin is excluded" from "nothing counts at all".
		...paidPair('oIn', Date.parse('2026-08-04T12:00:00Z'), Date.parse('2026-08-04T12:00:00Z')).slice(0, 1),
	]);
	const input = await gatherDigestInput(t, 's1', 'daily', periodStart, periodEnd, NOW);
	assert.equal(input.deliveryGaps, 1, 'only the in-period reconciliation event, not the two in the margin');
});

test('a shop with nothing at all gathers a clean, zeroed input', async () => {
	const input = await gatherDigestInput(tables(), 'unknown.myshopify.com', 'daily', PERIOD_START, PERIOD_END, NOW);
	assert.equal(input.ordersAwaiting, 0);
	assert.equal(input.failedAttemptsInPeriod, 0);
	assert.equal(input.deliveryGaps, 0);
	assert.equal(input.recorderHealthy, true);
	assert.deepEqual(input.topAwaiting, []);
});
