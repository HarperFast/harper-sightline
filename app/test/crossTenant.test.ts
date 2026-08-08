import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTable } from './fakeTable.ts';
import {
	listEvents,
	getEventDetail,
	listFindings,
	getFindingDetail,
	getSummary,
	computeFlows,
	getPrivacy,
	getSetup,
	listOrders,
	getOrderDetail,
} from '../src/queries.ts';
import { detectorKey } from '../src/detector.ts';
import { encodeCursor, EVENT_LIST_FIELDS, FINDING_LIST_FIELDS, ORDER_LIST_FIELDS } from '../src/apiContract.ts';
import { EXPORT_COLUMNS } from '../src/csv.ts';

// Adversarial tenant-isolation suite (#23, threat model §4). Two shops:
// `victim` and `attacker`. The attacker deliberately (a) reuses the victim's
// order id `o1`/`o2` and SKU, and (b) holds MORE rows, so any broken scope leaks
// a row or inflates an aggregate. Every read endpoint is attacked with the
// attacker's ids, filters chosen to match only the attacker, and a cursor taken
// from the attacker's data. Every query derives shopId from the (verified)
// principal — these tests pass that shopId directly, exactly as the resources do.

const NOW = 1_000_000_000_000;
const V = 'victim.myshopify.com';
const A = 'attacker.myshopify.com';

function world() {
	const events = new FakeTable('eventId', [
		// victim
		{
			eventId: 'v:e1',
			shopId: V,
			domain: 'order',
			topic: 'orders/paid',
			resourceId: 'o1',
			sku: 'SKU-1',
			occurredAt: NOW - 1000,
			receivedAt: NOW - 1000,
		},
		{
			eventId: 'v:e2',
			shopId: V,
			domain: 'fulfillment',
			topic: 'fulfillments/create',
			resourceId: 'o1',
			occurredAt: NOW - 500,
			receivedAt: NOW - 500,
		},
		// attacker — same resourceId o1 + same SKU, plus extra rows, one NEWER than any victim row
		{
			eventId: 'a:e1',
			shopId: A,
			domain: 'order',
			topic: 'orders/paid',
			resourceId: 'o1',
			sku: 'SKU-1',
			occurredAt: NOW - 100,
			receivedAt: NOW - 100,
		},
		{ eventId: 'a:e2', shopId: A, domain: 'order', topic: 'orders/paid', resourceId: 'o2', occurredAt: NOW - 900, receivedAt: NOW - 900 },
		{
			eventId: 'a:e3',
			shopId: A,
			domain: 'fulfillment',
			topic: 'fulfillments/create',
			resourceId: 'o1',
			occurredAt: NOW - 700,
			receivedAt: NOW - 700,
		},
		{
			eventId: 'a:e4',
			shopId: A,
			domain: 'inventory',
			topic: 'inventory_levels/update',
			resourceId: 'invX',
			occurredAt: NOW - 600,
			receivedAt: NOW - 600,
		},
	]);
	const projections = new FakeTable('id', [
		{
			id: `${V}:o1`,
			shopId: V,
			orderId: 'o1',
			paidAt: NOW - 1000,
			requiresFulfillment: true,
			fulfilledAt: NOW - 500,
			lastEventAt: NOW - 500,
			state: 'fulfilled',
		},
		{
			id: `${V}:o2`,
			shopId: V,
			orderId: 'o2',
			paidAt: NOW - 2000,
			requiresFulfillment: true,
			lastEventAt: NOW - 2000,
			state: 'awaiting',
		}, // awaiting
		{ id: `${A}:o1`, shopId: A, orderId: 'o1', paidAt: NOW - 100, requiresFulfillment: true, lastEventAt: NOW - 100, state: 'awaiting' },
		{ id: `${A}:o2`, shopId: A, orderId: 'o2', paidAt: NOW - 90, requiresFulfillment: true, lastEventAt: NOW - 90, state: 'awaiting' },
		{
			id: `${A}:o3`,
			shopId: A,
			orderId: 'o3',
			paidAt: NOW - 80,
			requiresFulfillment: true,
			fulfilledAt: NOW - 70,
			lastEventAt: NOW - 70,
			state: 'fulfilled',
		},
		// A digital order per shop, sharing an order id, so the newest lane value is
		// attacked exactly like every other filter.
		{ id: `${V}:o4`, shopId: V, orderId: 'o4', paidAt: NOW - 60, lastEventAt: NOW - 60, state: 'no_fulfillment_expected' },
		{ id: `${A}:o4`, shopId: A, orderId: 'o4', paidAt: NOW - 50, lastEventAt: NOW - 50, state: 'no_fulfillment_expected' },
	]);
	const findings = new FakeTable('id', [
		{
			id: detectorKey(V, 'o2'),
			shopId: V,
			orderId: 'o2',
			ruleVersion: 1,
			status: 'unconfirmed',
			detectedAt: NOW - 100,
			evidenceEventIds: ['v:eX'],
		},
		// attacker finding on the SAME orderId o2 — a distinct row only because keys are shop-namespaced
		{ id: detectorKey(A, 'o2'), shopId: A, orderId: 'o2', ruleVersion: 1, status: 'unconfirmed', detectedAt: NOW - 50 },
		{ id: detectorKey(A, 'o1'), shopId: A, orderId: 'o1', ruleVersion: 1, status: 'resolved', detectedAt: NOW - 40 },
	]);
	const expectations = new FakeTable('id', [
		{
			id: detectorKey(V, 'o2'),
			shopId: V,
			orderId: 'o2',
			detector: 'fulfillment_confirmation',
			ruleVersion: 1,
			state: 'expired',
			deadline: NOW - 200,
		},
		{
			id: detectorKey(A, 'o2'),
			shopId: A,
			orderId: 'o2',
			detector: 'fulfillment_confirmation',
			ruleVersion: 1,
			state: 'expired',
			deadline: NOW - 20,
		},
	]);
	const deliveries = new FakeTable('id', [
		{ id: `${V}:d1`, shopId: V, status: 'dead_letter', receivedAt: NOW - 100 },
		{ id: `${A}:d1`, shopId: A, status: 'dead_letter', receivedAt: NOW - 100 },
		{ id: `${A}:d2`, shopId: A, status: 'dead_letter', receivedAt: NOW - 100 },
		{ id: `${A}:d3`, shopId: A, status: 'dead_letter', receivedAt: NOW - 100 },
	]);
	const shops = new FakeTable('shopId', [
		{
			shopId: V,
			status: 'active',
			scopes: 'read_orders',
			installedAt: NOW - 1000,
			lastReconciledAt: NOW - 60_000,
			reconciliationState: 'ready',
		},
		{
			shopId: A,
			status: 'active',
			scopes: 'read_orders,read_all_the_things',
			installedAt: NOW - 1000,
			lastReconciledAt: NOW - 60_000,
			reconciliationState: 'ready',
		},
	]);
	const credentials = new FakeTable('shopId', [
		{ shopId: V, status: 'active' },
		{ shopId: A, status: 'reauthorization_required' },
	]);
	return { events, projections, findings, expectations, deliveries, shops, credentials };
}

const idsOf = (page: { items: Array<Record<string, unknown>> }) => page.items.map((i) => i.eventId);

test('listEvents: no attacker event leaks, even sharing resourceId/sku', async () => {
	const { events } = world();
	const page = await listEvents(events, V, NOW, {});
	assert.deepEqual(idsOf(page), ['v:e2', 'v:e1']);
	assert.ok(!idsOf(page).some((id) => String(id).startsWith('a:')), 'no attacker rows');
});

test('listEvents: manipulated filters cannot reach across tenants', async () => {
	const { events } = world();
	// resourceId=o1 matches attacker rows too — must still return only victim's.
	assert.deepEqual((await listEvents(events, V, NOW, { resourceId: 'o1' })).items.map((i) => i.eventId).sort(), ['v:e1', 'v:e2']);
	// sku shared with the attacker.
	assert.deepEqual(idsOf(await listEvents(events, V, NOW, { sku: 'SKU-1' })), ['v:e1']);
	// a domain the victim has no rows for at that filter → empty, never attacker's inventory row.
	assert.deepEqual(idsOf(await listEvents(events, V, NOW, { domain: 'inventory' })), []);
	// topic filter matching attacker rows.
	assert.deepEqual(
		(await listEvents(events, V, NOW, { topic: 'orders/paid' })).items.map((i) => i.eventId),
		['v:e1'],
	);
});

test('listEvents: a cursor crafted from the attacker boundary still yields only victim rows', async () => {
	const { events } = world();
	// Attacker's newest event is a:e1 @ NOW-100; craft a cursor at that boundary.
	const cursor = encodeCursor(NOW - 100, 'a:e1');
	const page = await listEvents(events, V, NOW, { cursor });
	assert.ok(!idsOf(page).some((id) => String(id).startsWith('a:')), 'cursor cannot cross tenants');
	assert.deepEqual(idsOf(page), ['v:e2', 'v:e1']);
});

test('getEventDetail: victim cannot read an attacker event by its real id', async () => {
	const { events, projections, findings } = world();
	for (const id of ['a:e1', 'a:e2', 'a:e3', 'a:e4']) {
		assert.equal(await getEventDetail(events, projections, findings, V, id), null, `${id} must be invisible to the victim`);
	}
	// own event resolves; related ids are victim-only (attacker's a:e1/a:e3 share resourceId o1)
	const ok = await getEventDetail(events, projections, findings, V, 'v:e1');
	assert.equal(ok?.eventId, 'v:e1');
	assert.deepEqual(ok?.relatedEventIds, ['v:e2']);
});

test('getEventDetail: an attacker inventory-item cache row can never name the victim event', async () => {
	const { events, projections, findings } = world();
	// Attacker's cache row for the SAME inventory item id the victim's event uses.
	const items = new FakeTable('id', [
		{ id: `${A}:invX`, shopId: A, inventoryItemId: 'invX', sku: 'LEAKED', productTitle: 'Leaked Product' },
	]);
	const locations = new FakeTable('id', []);
	await events.put({
		eventId: 'v:inv',
		shopId: V,
		domain: 'inventory',
		resourceId: 'invX',
		source: 'webhook',
		occurredAt: NOW,
		receivedAt: NOW,
	});
	const detail = await getEventDetail(events, projections, findings, V, 'v:inv', items, locations);
	assert.equal(detail?.inventorySku, undefined, "the attacker's cache row must not name the victim's item");
	assert.equal(detail?.productTitle, undefined);
});

test('listFindings: only the victim findings, never attacker findings on shared order ids', async () => {
	const { findings, expectations, projections } = world();
	const page = await listFindings(findings, expectations, projections, V, {});
	assert.deepEqual(
		page.items.map((i) => i.id),
		[detectorKey(V, 'o2')],
	);
	assert.ok(!page.items.some((i) => String(i.id) === detectorKey(A, 'o2')), 'attacker o2 finding not leaked');
});

test('getFindingDetail: shop-namespaced keys keep victim/attacker findings on the same order id distinct', async () => {
	const { findings, expectations, projections } = world();
	assert.notEqual(detectorKey(V, 'o2'), detectorKey(A, 'o2'));
	// victim cannot read the attacker's finding for the SAME order id o2
	assert.equal(await getFindingDetail(findings, expectations, projections, V, detectorKey(A, 'o2')), null);
	// attacker cannot read the victim's
	assert.equal(await getFindingDetail(findings, expectations, projections, A, detectorKey(V, 'o2')), null);
	// each reads only its own
	assert.equal((await getFindingDetail(findings, expectations, projections, V, detectorKey(V, 'o2')))?.orderId, 'o2');
});

test('getSummary: every count is victim-only despite the attacker holding more', async () => {
	const w = world();
	const s = await getSummary(w, V, NOW);
	assert.equal((s.events as Record<string, number>).total, 2, 'victim in-window events only (attacker has 4)');
	assert.deepEqual(s.orders, { tracked: 3, paid: 3, fulfilled: 1, awaitingConfirmation: 1 }, 'victim projections only');
	assert.deepEqual(s.findings, { unconfirmed: 1, resolved: 0, suppressed: 0, failedAttempts: 0 }, 'victim findings only');
	assert.deepEqual(s.recorder, { healthy: false, deadLetteredDeliveries: 1 }, 'victim dead letters only (attacker has 3)');
});

test('computeFlows: lane counts are victim-only', async () => {
	const { projections } = world();
	const flows = await computeFlows(projections, V, NOW);
	assert.deepEqual(flows.lanes, { paid: 3, fulfilled: 1, awaitingConfirmation: 1, noFulfillmentExpected: 1, cancelled: 0, refunded: 0 });
});

test('getPrivacy: footprint counts are victim-only', async () => {
	const w = world();
	const p = await getPrivacy(w, V, NOW);
	assert.deepEqual(p.footprint, { events: 2, orders: 3, findings: 1 });
	// Disclosure fields are the victim's own: the attacker holds 3 dead letters and
	// a wider scope string; neither may appear on the victim's privacy screen.
	assert.deepEqual(p.scopes, ['read_orders']);
	assert.deepEqual(p.webhooks, { received: 1, processed: 0, deadLettered: 1, healthy: false, lastReceivedAt: NOW - 100 });
});

test('getSetup: the attacker’s reauthorization state never blocks the victim', async () => {
	const w = world();
	const victim = await getSetup(w, V, NOW);
	assert.equal(victim.action, 'none', "the attacker's reauthorization_required credential is not the victim's");
	const attacker = await getSetup(w, A, NOW);
	assert.equal(attacker.action, 'reauthorize');
});

test('listOrders: attacker never sees a victim order that shares an order id', async () => {
	const { projections } = world();
	const page = await listOrders(projections, A, NOW, {});
	assert.deepEqual(new Set(page.items.map((i) => i.orderId)), new Set(['o1', 'o2', 'o3', 'o4']), "only the attacker's own four orders");
	// o1/o2 are shared order ids between shops — the returned rows must carry the
	// attacker's own paidAt, never the victim's.
	for (const item of page.items) {
		assert.notEqual(item.paidAt, NOW - 1000, "victim's o1 paidAt must not leak");
		assert.notEqual(item.paidAt, NOW - 2000, "victim's o2 paidAt must not leak");
	}
});

test('getOrderDetail: a crafted key cannot reach the victim order, and the attacker sees only its own data', async () => {
	const { projections, events, findings } = world();
	// `${shopId}:${orderId}` keying means these compute to a key that was never
	// written for the attacker's tenant, regardless of what looks like a victim key.
	assert.equal(await getOrderDetail(projections, events, findings, A, NOW, `../${V}:o1`), null);
	assert.equal(await getOrderDetail(projections, events, findings, A, NOW, `${V}:o1`), null);
	// The attacker's own o1 (same order id as the victim's) resolves to its own row.
	const detail = await getOrderDetail(projections, events, findings, A, NOW, 'o1');
	assert.equal(detail?.paidAt, NOW - 100, "the attacker's own o1, not the victim's");
});

test('listOrders: a cursor crafted from the victim boundary cannot surface victim rows for the attacker', async () => {
	const { projections } = world();
	// Victim's newest paidAt is o1 @ NOW-1000, older than every attacker order.
	const cursor = encodeCursor(NOW - 1000, `${V}:o1`);
	const page = await listOrders(projections, A, NOW, { cursor });
	assert.ok(!page.items.some((i) => i.paidAt === NOW - 1000 || i.paidAt === NOW - 2000), 'no victim paidAt leaked');
	assert.deepEqual(page.items, [], "the victim boundary excludes all of the attacker's own, newer orders");
});

test('listOrders: hostile filters cannot widen the attacker result set beyond its own shop', async () => {
	const { projections } = world();
	const hostile = await listOrders(projections, A, NOW, { state: "awaiting' OR 1=1" });
	assert.deepEqual(hostile.items, [], 'a hostile state filter matches nothing rather than everything');

	// minAgeHours=0 ("at least 0 hours old") matches every paid order — still only
	// the attacker's own four, never the victim's three.
	const wide = await listOrders(projections, A, NOW, { minAgeHours: 0 });
	assert.deepEqual(new Set(wide.items.map((i) => i.orderId)), new Set(['o1', 'o2', 'o3', 'o4']));
	assert.equal(wide.items.length, 4, "never the victim's three orders too");

	// The newest lane value is a FILTER, not a scope: the victim also has an o4 in
	// exactly this lane, and it must stay invisible.
	const lane = await listOrders(projections, A, NOW, { state: 'no_fulfillment_expected' });
	assert.deepEqual(
		lane.items.map((i) => i.orderId),
		['o4'],
	);
	assert.equal(lane.items[0].paidAt, NOW - 50, "the attacker's own o4, not the victim's");
});

test('export columns never reference a field outside the API allowlist', () => {
	const allowed: Record<string, readonly string[]> = {
		events: EVENT_LIST_FIELDS,
		findings: FINDING_LIST_FIELDS,
		orders: ORDER_LIST_FIELDS,
	};
	for (const kind of ['events', 'findings', 'orders'] as const) {
		for (const column of EXPORT_COLUMNS[kind]) {
			assert.ok(allowed[kind].includes(column.field), `${kind}.${column.field} is not in the API allowlist`);
		}
	}
});
