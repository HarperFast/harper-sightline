import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTable } from './fakeTable.ts';
import { gatherDigestInput, TOP_AWAITING } from '../src/digestData.ts';

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
	assert.equal(input.unconfirmed, 2, 'both unconfirmed findings, absence and failed-attempt');
	assert.equal(input.failedAttempts, 1);
	assert.equal(input.deliveryGaps, 1, 'only the in-period reconciliation-only event');
	assert.equal(input.shopId, 's1');
	assert.equal(input.cadence, 'daily');
	assert.equal(input.periodStart, PERIOD_START);
	assert.equal(input.periodEnd, PERIOD_END);
	assert.equal(input.recorderHealthy, true, "another tenant's dead letter must not make this shop's recorder look unhealthy");
	assert.equal(input.deadLettered, 0);
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
	assert.equal(input.unconfirmed, 2);
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

test('a shop with nothing at all gathers a clean, zeroed input', async () => {
	const input = await gatherDigestInput(tables(), 'unknown.myshopify.com', 'daily', PERIOD_START, PERIOD_END, NOW);
	assert.equal(input.unconfirmed, 0);
	assert.equal(input.failedAttempts, 0);
	assert.equal(input.deliveryGaps, 0);
	assert.equal(input.recorderHealthy, true);
	assert.deepEqual(input.topAwaiting, []);
});
