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
import { EVENT_FIELDS, FINDING_LIST_FIELDS, MAX_LIMIT } from '../src/apiContract.ts';
import { detectorKey } from '../src/detector.ts';
import { runStateBackfill, type BackfillDeps } from '../src/stateBackfill.ts';

const NOW = 1_000_000_000_000;
const DAY = 86_400_000;
const HOUR = 3_600_000;

// Two tenants; s2 rows must never surface for an s1 query.
function fixtures() {
	const events = new FakeTable('eventId', [
		{
			eventId: 's1:e1',
			shopId: 's1',
			domain: 'order',
			topic: 'orders/paid',
			resourceId: 'o1',
			state: 'paid',
			occurredAt: NOW - 1000,
			receivedAt: NOW - 1000,
			email: 'leak@x.com',
		},
		{
			eventId: 's1:e2',
			shopId: 's1',
			domain: 'fulfillment',
			topic: 'fulfillments/create',
			resourceId: 'o1',
			state: 'success',
			occurredAt: NOW - 500,
			receivedAt: NOW - 500,
		},
		{
			eventId: 's1:e3',
			shopId: 's1',
			domain: 'inventory',
			topic: 'inventory_levels/update',
			resourceId: 'inv9',
			quantity: 5,
			occurredAt: NOW - 8 * DAY,
			receivedAt: NOW - 8 * DAY,
		}, // outside window
		{
			eventId: 's2:e1',
			shopId: 's2',
			domain: 'order',
			topic: 'orders/paid',
			resourceId: 'o1',
			state: 'paid',
			occurredAt: NOW - 800,
			receivedAt: NOW - 800,
		},
	]);
	// Two deliberately different scales of "recent" among the s1 rows below:
	// - o1/o2 (and s2's o1) are the ORIGINAL pair, millisecond-fresh, used by the
	//   event/finding tests above. Their paidAt/lastEventAt are seconds old, which
	//   puts them ahead of every hour-scale row in any unfiltered/newest-first
	//   order query. Do not retime them "to make the ordering tidier": their
	//   paidAt is joined into the findings-list assertions and their orderId is
	//   reused as an event resourceId elsewhere in this file, so retiming would
	//   ripple into unrelated tests.
	// - oA-oF are the WORKLIST set, hour-scale ages, purpose-built for the order
	//   list/aging/lane tests.
	//
	// EVERY row carries a stored `state` that agrees with its own latches — that is
	// an invariant of this fixture set, not an incidental detail. The stored column
	// is what listOrders filters on while getSummary/computeFlows derive the lane
	// live, so a fixture row whose `state` disagrees with its latches encodes a
	// count/list divergence AS THE EXPECTED RESULT: a correct implementation then
	// fails the suite and an incorrect one passes. (Three rows here carried no
	// `state` at all for exactly that reason, which is how C1 stayed invisible.) The
	// one deliberate exception is oLegacy below, whose whole purpose is to be the
	// pre-backfill shape, and which is named and tested as such.
	//
	// All of these functions read from this SAME table — one shared universe, not
	// two. getSummary and computeFlows share one window predicate: both filter on
	// `lastEventAt >= windowStart`, so o1/o2 and oA-oF all count toward both, since
	// every row here, even oC's 80-hour-old lastEventAt, sits inside the 7-day
	// window. getPrivacy's footprint (countWhere) is intentionally different — it
	// reports the tenant's whole stored footprint, not a "last 7 days" claim, so it
	// has no window filter and o1/o2 count toward it regardless of lastEventAt.
	const projections = new FakeTable('id', [
		{
			id: 's1:o1',
			shopId: 's1',
			orderId: 'o1',
			paidAt: NOW - 1000,
			requiresFulfillment: true,
			fulfilledAt: NOW - 500,
			lastEventAt: NOW - 500,
			state: 'fulfilled',
		},
		{
			id: 's1:o2',
			shopId: 's1',
			orderId: 'o2',
			// The named s1 rows are numbered by paidAt, oldest to newest: oC (80h)
			// #1001, oB (30h) #1002, oD (5h) #1003, oA (2h) #1004, and o2 (2s — the
			// most recent order in the fixture set) #1005. Order names increase over
			// time in Shopify, so a fixture whose numbers don't track paidAt tells two
			// contradictory stories about ordering — keep them in this order when
			// adding or editing rows here, not in whatever order is convenient to type.
			// Rows added later (oE, oF, oLegacy) deliberately carry NO name rather than
			// disturbing that sequence.
			orderName: '#1005',
			paidAt: NOW - 2000,
			requiresFulfillment: true,
			lastEventAt: NOW - 2000,
			state: 'awaiting',
		}, // awaiting confirmation
		{ id: 's2:o1', shopId: 's2', orderId: 'o1', paidAt: NOW, requiresFulfillment: true, lastEventAt: NOW, state: 'awaiting' },
		// Worklist fixtures: six s1 orders across lanes/ages plus an s2 order that
		// shares an order id, so tenant bleed is testable.
		{
			id: 's1:oA',
			shopId: 's1',
			orderId: 'oA',
			orderName: '#1004',
			paidAt: NOW - 2 * HOUR,
			requiresFulfillment: true,
			state: 'awaiting',
			lastEventAt: NOW - 2 * HOUR,
			orderTotal: 50,
			currency: 'USD',
		},
		{
			id: 's1:oB',
			shopId: 's1',
			orderId: 'oB',
			orderName: '#1002',
			paidAt: NOW - 30 * HOUR,
			requiresFulfillment: true,
			state: 'awaiting',
			lastEventAt: NOW - 30 * HOUR,
			orderTotal: 90,
			currency: 'USD',
			fulfillmentFailedAt: NOW - 20 * HOUR,
		},
		{
			id: 's1:oC',
			shopId: 's1',
			orderId: 'oC',
			orderName: '#1001',
			paidAt: NOW - 80 * HOUR,
			requiresFulfillment: true,
			state: 'awaiting',
			lastEventAt: NOW - 80 * HOUR,
		},
		{
			id: 's1:oD',
			shopId: 's1',
			orderId: 'oD',
			orderName: '#1003',
			paidAt: NOW - 5 * HOUR,
			requiresFulfillment: true,
			state: 'fulfilled',
			lastEventAt: NOW - 4 * HOUR,
			fulfilledAt: NOW - 4 * HOUR,
		},
		// Fulfilled, then cancelled. deriveOrderLane's finality ordering (cancelled
		// beats fulfilled) must resolve this to exactly one lane — cancelled — and
		// every surface that counts lanes (getSummary.orders.fulfilled,
		// computeFlows.lanes, listOrders' state filter) must agree it is NOT
		// fulfilled. No orderName: it is not part of the numbered oA-oD/o2 sequence
		// above, so it carries none rather than disturbing that ordering.
		{
			id: 's1:oE',
			shopId: 's1',
			orderId: 'oE',
			paidAt: NOW - 10 * HOUR,
			requiresFulfillment: true,
			state: 'cancelled',
			fulfilledAt: NOW - 8 * HOUR,
			cancelledAt: NOW - 6 * HOUR,
			lastEventAt: NOW - 6 * HOUR,
		},
		// A LEGACY row: written before the `state` column existed, so it carries
		// none. This is the production shape on deploy day for every projection that
		// gets no further events, and it is deliberately the worst case — paid,
		// fulfillment-eligible, unfulfilled and QUIET, so nothing will ever rebuild it
		// (and reconciliation's cursor-scoped sweep will never re-fetch it either).
		// getSummary/computeFlows count it via the live lane; listOrders cannot see it
		// until the backfill runs. That divergence is what test/stateBackfill.test.ts
		// and test/overviewLinks.test.ts name and close — it is NOT the normal shape,
		// and no other row here may imitate it.
		{
			id: 's1:oLegacy',
			shopId: 's1',
			orderId: 'oLegacy',
			paidAt: NOW - 50 * HOUR,
			requiresFulfillment: true,
			lastEventAt: NOW - 50 * HOUR,
		},
		// A DIGITAL order: paid, live, zero fulfillable units — so
		// `requiresFulfillment` was never latched (the reducer only ever latches it
		// true) and no fulfillment was ever observed. It is not awaiting and it is not
		// fulfilled; it has its own lane, because rendering it as "Fulfilled" asserted
		// a fulfillment nobody saw.
		{
			id: 's1:oF',
			shopId: 's1',
			orderId: 'oF',
			paidAt: NOW - 3 * HOUR,
			state: 'no_fulfillment_expected',
			lastEventAt: NOW - 3 * HOUR,
			orderTotal: 25,
			currency: 'USD',
		},
		{
			id: 's2:oA',
			shopId: 's2',
			orderId: 'oA',
			orderName: '#9999',
			paidAt: NOW - 2 * HOUR,
			requiresFulfillment: true,
			state: 'awaiting',
			lastEventAt: NOW - 2 * HOUR,
		},
	]);
	const findings = new FakeTable('id', [
		{
			id: detectorKey('s1', 'o2'),
			shopId: 's1',
			orderId: 'o2',
			ruleVersion: 1,
			status: 'unconfirmed',
			detectedAt: NOW - 100,
			evidenceEventIds: ['s1:eX'],
		},
		{ id: detectorKey('s2', 'oZ'), shopId: 's2', orderId: 'oZ', ruleVersion: 1, status: 'unconfirmed', detectedAt: NOW - 50 },
	]);
	const expectations = new FakeTable('id', [
		{
			id: detectorKey('s1', 'o2'),
			shopId: 's1',
			orderId: 'o2',
			detector: 'fulfillment_confirmation',
			ruleVersion: 1,
			state: 'expired',
			deadline: NOW - 200,
			createdAt: NOW - 5000,
		},
	]);
	const deliveries = new FakeTable('id', [
		{ id: 's1:d1', shopId: 's1', status: 'dead_letter', receivedAt: NOW - 3000 },
		{ id: 's1:d2', shopId: 's1', status: 'processed', receivedAt: NOW - 900 },
		{ id: 's2:d1', shopId: 's2', status: 'processed', receivedAt: NOW - 10 },
	]);
	const shops = new FakeTable('shopId', [
		{
			shopId: 's1',
			status: 'active',
			scopes: 'read_orders,read_fulfillments',
			installedAt: NOW - 10 * DAY,
			lastReconciledAt: NOW - 4 * 60_000,
			reconciliationState: 'ready',
		},
		{ shopId: 's2', status: 'active', scopes: 'read_orders', installedAt: NOW - DAY, lastReconciledAt: NOW, reconciliationState: 'ready' },
	]);
	const credentials = new FakeTable('shopId', [{ shopId: 's1', status: 'active' }]);
	return { events, projections, findings, expectations, deliveries, shops, credentials };
}

function skuFixtures() {
	return new FakeTable('id', [
		{
			id: 's1:e1:TSHIRT',
			shopId: 's1',
			eventId: 's1:e1',
			sku: 'TSHIRT',
			domain: 'order',
			topic: 'orders/paid',
			source: 'webhook',
			resourceId: 'o1',
			occurredAt: NOW - 1000,
			receivedAt: NOW - 1000,
		},
		{
			id: 's1:e2:TSHIRT',
			shopId: 's1',
			eventId: 's1:e2',
			sku: 'TSHIRT',
			domain: 'fulfillment',
			topic: 'fulfillments/create',
			source: 'webhook',
			resourceId: 'o1',
			occurredAt: NOW - 500,
			receivedAt: NOW - 500,
		},
		{
			id: 's2:e1:TSHIRT',
			shopId: 's2',
			eventId: 's2:e1',
			sku: 'TSHIRT',
			domain: 'order',
			topic: 'orders/paid',
			source: 'webhook',
			resourceId: 'o1',
			occurredAt: NOW - 900,
			receivedAt: NOW - 900,
		},
	]);
}

test('a SKU filter returns the shop own matching events, newest first', async () => {
	const { events } = fixtures();
	const page = await listEvents(events, 's1', NOW, { sku: 'TSHIRT' }, skuFixtures());
	assert.deepEqual(
		page.items.map((i) => i.eventId),
		['s1:e2', 's1:e1'],
	);
});

test('a SKU filter never returns another tenant event that shares the SKU', async () => {
	const { events } = fixtures();
	const page = await listEvents(events, 's1', NOW, { sku: 'TSHIRT' }, skuFixtures());
	for (const item of page.items) assert.equal(String(item.eventId).startsWith('s1:'), true);
});

test('a SKU filter combines with a domain filter without post-filtering the page', async () => {
	const { events } = fixtures();
	const page = await listEvents(events, 's1', NOW, { sku: 'TSHIRT', domain: 'fulfillment' }, skuFixtures());
	assert.deepEqual(
		page.items.map((i) => i.eventId),
		['s1:e2'],
	);
});

test('a SKU filter combines with a state filter, which the index cannot answer alone', async () => {
	// The two controls sit side by side in the events filter bar. `state` is not an
	// EventSku column, so pushing it into the index query made the PAIR match nothing
	// while each filter worked alone — a filter that looks like it works and silently
	// returns an empty page. It is applied after hydration instead, from the event row.
	const { events } = fixtures();
	const both = await listEvents(events, 's1', NOW, { sku: 'TSHIRT', state: 'success' }, skuFixtures());
	assert.deepEqual(
		both.items.map((i) => i.eventId),
		['s1:e2'],
		'the fulfillment event carrying TSHIRT, in state success',
	);
	// And it still discriminates: the other TSHIRT event is in state 'paid'.
	assert.deepEqual(
		(await listEvents(events, 's1', NOW, { sku: 'TSHIRT', state: 'paid' }, skuFixtures())).items.map((i) => i.eventId),
		['s1:e1'],
	);
	assert.deepEqual(
		(await listEvents(events, 's1', NOW, { sku: 'TSHIRT', state: 'error' }, skuFixtures())).items,
		[],
		'and excludes non-matches',
	);
	// A state filter that excludes a row on the index path can only ever SHRINK the
	// page, never reach another tenant's event.
	for (const item of both.items) assert.equal(String(item.eventId).startsWith('s1:'), true);
});

test('the SKU path fetches its page of events in one batch, not one round trip at a time', async () => {
	// At export scale this loop ran up to MAX_EXPORT_ROWS sequential gets inside a
	// single request. The gets are issued together now; this pins that by observing
	// that no get resolves before all of them have been issued.
	const { events } = fixtures();
	const trace: string[] = [];
	const counting = {
		search: (spec: unknown) => events.search(spec as never),
		get: async (id: string) => {
			trace.push(`issue ${id}`);
			const row = await events.get(id);
			trace.push(`settle ${id}`);
			return row;
		},
	} as unknown as typeof events;
	const page = await listEvents(counting, 's1', NOW, { sku: 'TSHIRT' }, skuFixtures());
	assert.equal(page.items.length, 2);
	// Every get is issued before any of them settles. Awaiting inside the loop would
	// interleave them (issue, settle, issue, settle).
	const issues = trace.filter((t) => t.startsWith('issue')).length;
	assert.equal(issues, 2, 'one get per index row on the page');
	assert.deepEqual(
		trace.slice(0, issues).map((t) => t.split(' ')[0]),
		['issue', 'issue'],
	);
});

test('a SKU with no index rows returns an empty page, not every event', async () => {
	const { events } = fixtures();
	const page = await listEvents(events, 's1', NOW, { sku: 'NOPE' }, skuFixtures());
	assert.deepEqual(page.items, []);
});

test('an index row whose event is missing is skipped, not returned as a phantom', async () => {
	const { events } = fixtures();
	const orphaned = skuFixtures();
	await orphaned.put({
		id: 's1:gone:TSHIRT',
		shopId: 's1',
		eventId: 's1:gone',
		sku: 'TSHIRT',
		domain: 'order',
		source: 'webhook',
		occurredAt: NOW - 100,
		receivedAt: NOW - 100,
	});
	const page = await listEvents(events, 's1', NOW, { sku: 'TSHIRT' }, orphaned);
	assert.equal(
		page.items.some((i) => i.eventId === 's1:gone'),
		false,
	);
});

test('events carry their full SKU list, sorted, not just the scalar', async () => {
	const { events } = fixtures();
	const page = await listEvents(events, 's1', NOW, {}, skuFixtures());
	const e1 = page.items.find((i) => i.eventId === 's1:e1');
	assert.deepEqual(e1?.skus, ['TSHIRT']);
});

test('an event with no index rows simply has no skus key', async () => {
	const { events } = fixtures();
	// s1:e3 (the fixture with no index rows) is deliberately OUTSIDE the 7-day
	// window, so it never reaches page.items and can't verify this at all — the
	// find() below would return undefined against either a correct or a broken
	// hydrateSkus. Add an IN-WINDOW event with no corresponding EventSku rows so
	// the assertion actually exercises the no-index-rows path.
	await events.put({
		eventId: 's1:e4',
		shopId: 's1',
		domain: 'refund',
		topic: 'refunds/create',
		resourceId: 'o1',
		occurredAt: NOW - 200,
		receivedAt: NOW - 200,
	});
	const page = await listEvents(events, 's1', NOW, {}, skuFixtures());
	const e4 = page.items.find((i) => i.eventId === 's1:e4');
	assert.ok(e4, 'the in-window event must actually appear in the page');
	assert.equal('skus' in (e4 ?? {}), false);
});

test('the SKU list is hydrated in one query per page, not one per row', async () => {
	const { events } = fixtures();
	const index = skuFixtures();
	let searches = 0;
	const counting = {
		search: (spec: unknown) => {
			searches++;
			return index.search(spec as never);
		},
		get: (id: string) => index.get(id),
	} as unknown as typeof index;
	await listEvents(events, 's1', NOW, {}, counting);
	assert.equal(searches, 1, 'a keyed query per row would be up to MAX_LIMIT round trips per screen');
});

test('SKU hydration never attaches another tenant SKUs', async () => {
	const { events } = fixtures();
	const index = skuFixtures();
	// Production event ids are shop-prefixed (`${shopId}:${webhookId}`), so an OR
	// query keyed on s1's own ids can never structurally match a genuine s2 row —
	// skuFixtures()'s s2:e1 row is not even a candidate. To actually exercise the
	// `row.shopId !== shopId` re-check (rather than pass vacuously because the
	// hostile row was never in contention), plant a row that collides on eventId
	// with an s1 event while carrying another shop's shopId — a corrupted/hostile
	// index row is exactly the case that check defends against.
	await index.put({
		id: 's2:e1:HACKED',
		shopId: 's2',
		eventId: 's1:e1',
		sku: 'HACKED-SKU',
		domain: 'order',
		topic: 'orders/paid',
		source: 'webhook',
		resourceId: 'o1',
		occurredAt: NOW - 1000,
		receivedAt: NOW - 1000,
	});
	const page = await listEvents(events, 's1', NOW, {}, index);
	const e1 = page.items.find((i) => i.eventId === 's1:e1');
	assert.ok(!(e1?.skus as string[] | undefined)?.includes('HACKED-SKU'), 'a cross-tenant index row must never attach its SKU');
	for (const item of page.items) {
		if (item.skus)
			assert.equal(
				(item.skus as string[]).every((s) => typeof s === 'string'),
				true,
			);
		assert.notEqual(item.eventId, 's2:e1');
	}
});

test('listEvents is tenant-scoped, windowed, and field-allowlisted', async () => {
	const { events } = fixtures();
	const page = await listEvents(events, 's1', NOW, {});
	const ids = page.items.map((i) => i.eventId);
	assert.deepEqual(ids, ['s1:e2', 's1:e1'], 'only s1 in-window events, newest first');
	assert.ok(!ids.includes('s2:e1'), 'no cross-tenant leak');
	assert.ok(!ids.includes('s1:e3'), 'out-of-window event excluded');
	// Allowlist: no stray/PII keys (the fixture put an `email` on s1:e1).
	for (const item of page.items) {
		for (const key of Object.keys(item)) assert.ok((EVENT_FIELDS as readonly string[]).includes(key), `leaked field ${key}`);
	}
});

test('listEvents filters by domain and resourceId', async () => {
	const { events } = fixtures();
	assert.deepEqual(
		(await listEvents(events, 's1', NOW, { domain: 'fulfillment' })).items.map((i) => i.eventId),
		['s1:e2'],
	);
	const byResource = await listEvents(events, 's1', NOW, { resourceId: 'o1' });
	assert.deepEqual(byResource.items.map((i) => i.eventId).sort(), ['s1:e1', 's1:e2']);
});

test('listEvents filters by evidence source', async () => {
	const events = new FakeTable('eventId', [
		{ eventId: 's1:w', shopId: 's1', domain: 'order', source: 'webhook', occurredAt: NOW - 100, receivedAt: NOW - 100 },
		{ eventId: 's1:r', shopId: 's1', domain: 'order', source: 'reconciliation', occurredAt: NOW - 200, receivedAt: NOW - 200 },
	]);
	assert.deepEqual(
		(await listEvents(events, 's1', NOW, { source: 'reconciliation' })).items.map((i) => i.eventId),
		['s1:r'],
	);
	assert.deepEqual(
		(await listEvents(events, 's1', NOW, { source: 'webhook' })).items.map((i) => i.eventId),
		['s1:w'],
	);
});

test('listEvents filters by fulfillment state, so a failed attempt can be found directly', async () => {
	const events = new FakeTable('eventId', [
		{ eventId: 's1:ok', shopId: 's1', domain: 'fulfillment', state: 'success', occurredAt: NOW - 100, receivedAt: NOW - 100 },
		{ eventId: 's1:err', shopId: 's1', domain: 'fulfillment', state: 'error', occurredAt: NOW - 200, receivedAt: NOW - 200 },
	]);
	assert.deepEqual(
		(await listEvents(events, 's1', NOW, { state: 'error' })).items.map((i) => i.eventId),
		['s1:err'],
	);
});

test('listEvents paginates by cursor without dupes or gaps', async () => {
	const rows = Array.from({ length: 5 }, (_, i) => ({
		eventId: `s1:p${i}`,
		shopId: 's1',
		domain: 'order',
		resourceId: 'o',
		occurredAt: NOW - i * 10,
		receivedAt: NOW - i * 10,
	}));
	const events = new FakeTable('eventId', rows);
	const seen: unknown[] = [];
	let cursor: string | undefined;
	for (let guard = 0; guard < 10; guard++) {
		const page = await listEvents(events, 's1', NOW, { limit: 2, cursor });
		seen.push(...page.items.map((i) => i.eventId));
		if (!page.nextCursor) break;
		cursor = page.nextCursor;
	}
	assert.deepEqual(seen, ['s1:p0', 's1:p1', 's1:p2', 's1:p3', 's1:p4'], 'every row exactly once, in order');
});

test('listEvents clamps limit to MAX_LIMIT', async () => {
	const rows = Array.from({ length: MAX_LIMIT + 10 }, (_, i) => ({
		eventId: `s1:m${i}`,
		shopId: 's1',
		domain: 'order',
		occurredAt: NOW - i,
		receivedAt: NOW - i,
	}));
	const events = new FakeTable('eventId', rows);
	const page = await listEvents(events, 's1', NOW, { limit: 9999 });
	assert.equal(page.items.length, MAX_LIMIT);
});

test('getEventDetail refuses cross-tenant access even with the correct id', async () => {
	const { events, projections, findings } = fixtures();
	assert.equal(await getEventDetail(events, projections, findings, 's1', 's2:e1'), null, 's1 cannot read an s2 event');
	const ok = await getEventDetail(events, projections, findings, 's1', 's1:e1');
	assert.equal(ok?.eventId, 's1:e1');
	assert.deepEqual(ok?.relatedEventIds, ['s1:e2'], 'same-order sibling, tenant-scoped');
	assert.equal(ok?.affectedProjection, true);
});

test('an inventory event detail names its SKU, product, and location', async () => {
	const { events, projections, findings } = fixtures();
	const items = new FakeTable('id', [{ id: 's1:inv9', shopId: 's1', inventoryItemId: 'inv9', sku: 'TSHIRT', productTitle: 'T-Shirt' }]);
	const locations = new FakeTable('id', [{ id: 's1:987', shopId: 's1', locationId: '987', name: 'Brooklyn' }]);
	await events.put({
		eventId: 's1:inv',
		shopId: 's1',
		domain: 'inventory',
		resourceId: 'inv9',
		locationId: '987',
		quantity: 4,
		source: 'webhook',
		occurredAt: NOW,
		receivedAt: NOW,
	});
	const detail = await getEventDetail(events, projections, findings, 's1', 's1:inv', items, locations);
	assert.equal(detail?.inventorySku, 'TSHIRT');
	assert.equal(detail?.productTitle, 'T-Shirt');
	assert.equal(detail?.locationName, 'Brooklyn');
});

test('another tenant cache row can never name this shop event', async () => {
	const { events, projections, findings } = fixtures();
	const items = new FakeTable('id', [{ id: 's2:inv9', shopId: 's2', inventoryItemId: 'inv9', sku: 'LEAKED' }]);
	const locations = new FakeTable('id', []);
	await events.put({
		eventId: 's1:inv',
		shopId: 's1',
		domain: 'inventory',
		resourceId: 'inv9',
		source: 'webhook',
		occurredAt: NOW,
		receivedAt: NOW,
	});
	const detail = await getEventDetail(events, projections, findings, 's1', 's1:inv', items, locations);
	assert.equal(detail?.inventorySku, undefined);
});

test('listFindings is tenant-scoped and filterable by status', async () => {
	const { findings, expectations, projections } = fixtures();
	const page = await listFindings(findings, expectations, projections, 's1', {});
	assert.deepEqual(
		page.items.map((i) => i.orderId),
		['o2'],
	);
	for (const key of Object.keys(page.items[0])) assert.ok((FINDING_LIST_FIELDS as readonly string[]).includes(key), `leaked ${key}`);
	assert.equal((await listFindings(findings, expectations, projections, 's1', { status: 'resolved' })).items.length, 0);
});

test('listFindings carries the list columns (paid time, expected confirmation)', async () => {
	const { findings, expectations, projections } = fixtures();
	const [item] = (await listFindings(findings, expectations, projections, 's1', {})).items;
	assert.equal(item.paidAt, NOW - 2000, 'paid time joined from the projection');
	assert.equal(item.deadline, NOW - 200, 'expected-confirmation deadline joined from the expectation');
});

test('listFindings join never crosses tenants', async () => {
	// s2's own finding must not pick up s1's identically-keyed order facts.
	const { expectations, projections } = fixtures();
	const findings = new FakeTable('id', [
		{ id: detectorKey('s2', 'o2'), shopId: 's2', orderId: 'o2', ruleVersion: 1, status: 'unconfirmed', detectedAt: NOW - 10 },
	]);
	const [item] = (await listFindings(findings, expectations, projections, 's2', {})).items;
	assert.equal(item.paidAt, undefined, 'no s1 projection leaked into an s2 row');
	assert.equal(item.deadline, undefined, 'no s1 expectation leaked into an s2 row');
	assert.equal(item.orderName, undefined, 'no s1 order name leaked into an s2 row');
});

test('the findings list carries the merchant-facing order name', async () => {
	const { findings, expectations, projections } = fixtures();
	const page = await listFindings(findings, expectations, projections, 's1', {});
	const withName = page.items.find((i) => i.orderName !== undefined);
	assert.ok(withName, 'at least one finding should join an order name');
});

test('the findings join never takes another tenant order name', async () => {
	// A smoke check, not the guard's real coverage: s1's only finding is joined to
	// order o2, and s2's differently-named order is oA — those never collide at the
	// `${shopId}:${orderId}` lookup key, so this passes whether or not the
	// `projection.shopId === shopId` guard actually works. The genuine shared-key
	// case — an s2 finding whose orderId is also an s1 order id — is exercised by
	// 'listFindings join never crosses tenants' above, which is where the guard is
	// actually proven.
	const { findings, expectations, projections } = fixtures();
	const page = await listFindings(findings, expectations, projections, 's1', {});
	for (const item of page.items) assert.notEqual(item.orderName, '#9999');
});

test('getFindingDetail joins expectation + projection, cross-tenant safe', async () => {
	const { findings, expectations, projections } = fixtures();
	assert.equal(
		await getFindingDetail(findings, expectations, projections, 's2', detectorKey('s1', 'o2')),
		null,
		's2 cannot read s1 finding',
	);
	const d = await getFindingDetail(findings, expectations, projections, 's1', detectorKey('s1', 'o2'));
	assert.equal(d?.status, 'unconfirmed');
	assert.match(String(d?.description), /no shopify fulfillment confirmation/i);
	assert.equal((d?.expectation as Record<string, unknown>)?.deadline, NOW - 200);
	assert.equal((d?.projection as Record<string, unknown>)?.orderId, 'o2');
});

test('findings can be filtered to one detector', async () => {
	const { findings, expectations, projections } = fixtures();
	await findings.put({
		id: 'fulfillment_attempt_failed:s1:o1:1',
		shopId: 's1',
		orderId: 'o1',
		detector: 'fulfillment_attempt_failed',
		status: 'unconfirmed',
		detectedAt: NOW - 100,
	});
	const page = await listFindings(findings, expectations, projections, 's1', { detector: 'fulfillment_attempt_failed' });
	assert.equal(page.items.length, 1);
	assert.equal(page.items[0].detector, 'fulfillment_attempt_failed');
});

test('getSummary counts reconcile to the fixtures, scoped to the tenant', async () => {
	const f = fixtures();
	const s = await getSummary(f, 's1', NOW);
	assert.equal((s.events as Record<string, number>).total, 2, 's1 in-window events');
	// Includes the worklist fixture orders (oA-oF) and oLegacy: 9 tracked, 9 paid,
	// 2 fulfilled (o1, oD — oE is fulfilled-then-cancelled so it lands in cancelled,
	// and oF is digital so it lands in no_fulfillment_expected), 5 awaiting (o2, oA,
	// oB, oC, oLegacy). These counts derive the lane LIVE, so oLegacy — which has no
	// stored `state` — is counted here; the worklist cannot see it until the backfill
	// runs (test/stateBackfill.test.ts), which is the whole of C1.
	assert.deepEqual(s.orders, { tracked: 9, paid: 9, fulfilled: 2, awaitingConfirmation: 5 });
	assert.deepEqual(s.findings, { unconfirmed: 1, resolved: 0, suppressed: 0, failedAttempts: 0 });
	assert.deepEqual(s.recorder, { healthy: false, deadLetteredDeliveries: 1 });
});

test('getSummary reports reconciliation freshness, and staleness when it lags', async () => {
	const f = fixtures();
	const fresh = (await getSummary(f, 's1', NOW)).reconciliation as Record<string, unknown>;
	assert.deepEqual(fresh, { lastReconciledAt: NOW - 4 * 60_000, ageMs: 4 * 60_000, stale: false, state: 'ready' });

	// Past the operator-side staleness threshold → the merchant sees it too.
	const stale = (
		await getSummary(
			{ ...f, shops: new FakeTable('shopId', [{ shopId: 's1', lastReconciledAt: NOW - 90 * 60_000, reconciliationState: 'ready' }]) },
			's1',
			NOW,
		)
	).reconciliation as Record<string, unknown>;
	assert.equal(stale.stale, true);

	// Never reconciled must NOT read as "reconciled just now".
	const never = (await getSummary({ ...f, shops: new FakeTable('shopId', [{ shopId: 's1', reconciliationState: 'pending' }]) }, 's1', NOW))
		.reconciliation as Record<string, unknown>;
	assert.deepEqual(never, { ageMs: null, stale: true, state: 'pending' });
});

test('getSummary activity buckets the window by day and reconciles to the total', async () => {
	const f = fixtures();
	const s = await getSummary(f, 's1', NOW);
	const activity = s.activity as { days: number; buckets: Array<Record<string, number>> };
	assert.equal(activity.buckets.length, 7, 'one bucket per retention day');
	assert.equal(
		activity.buckets.reduce((n, b) => n + b.total, 0),
		(s.events as Record<string, number>).total,
		'buckets sum to the window total',
	);
	// Both s1 in-window events are seconds old → the newest bucket.
	const newest = activity.buckets[6];
	assert.equal(newest.order, 1);
	assert.equal(newest.fulfillment, 1);
	assert.equal(newest.inventory, 0, 'the out-of-window inventory event is excluded');
});

test('getSummary pins eventsTotal, webhookEvents and the activity buckets ahead of the margin change', async () => {
	// The regression net for widening the event query's lower bound: eventsTotal,
	// webhookEvents and the activity buckets share the loop that produces
	// reconciliationOnlyEvents, so a margin added to find a twin outside the window
	// must not also let this fixture's out-of-window row leak into any of the
	// three. Both rows here are named for what they must do to each tally.
	const windowStart = NOW - 7 * DAY;
	const events = new FakeTable('eventId', [
		{
			eventId: 'pin-in-order',
			shopId: 's1',
			domain: 'order',
			topic: 'orders/paid',
			resourceId: 'pin-o1',
			state: 'paid',
			source: 'webhook',
			occurredAt: NOW - HOUR,
			receivedAt: NOW - HOUR,
		},
		{
			eventId: 'pin-in-fulfillment',
			shopId: 's1',
			domain: 'fulfillment',
			topic: 'fulfillments/create',
			resourceId: 'pin-o2',
			state: 'success',
			source: 'webhook',
			occurredAt: NOW - HOUR,
			receivedAt: NOW - HOUR,
		},
		// Just outside the window, and well inside the digest's one-day match
		// margin — exactly the row that must NOT count once the query widens.
		{
			eventId: 'pin-out-order',
			shopId: 's1',
			domain: 'order',
			topic: 'orders/paid',
			resourceId: 'pin-o3',
			state: 'paid',
			source: 'webhook',
			occurredAt: windowStart - 1000,
			receivedAt: windowStart - 1000,
		},
	]);
	const empty = { projections: new FakeTable('id', []), findings: new FakeTable('id', []), deliveries: new FakeTable('id', []) };
	const shops = new FakeTable('shopId', []);
	const summary = await getSummary({ events, ...empty, shops }, 's1', NOW);
	assert.equal((summary.events as { total: number }).total, 2, 'the out-of-window row is not part of the total');
	assert.equal((summary.integrity as { webhookEvents: number }).webhookEvents, 2, 'the out-of-window row is not part of this tally either');
	const activity = summary.activity as { buckets: Array<Record<string, number>> };
	assert.equal(
		activity.buckets.reduce((n, b) => n + b.total, 0),
		2,
		'the out-of-window row must not appear in any bucket',
	);
	const newest = activity.buckets[activity.buckets.length - 1];
	assert.equal(newest.order, 1, 'only the in-window order event');
	assert.equal(newest.fulfillment, 1, 'only the in-window fulfillment event');
});

test('computeFlows lane counts reconcile and are rebuildable from projections', async () => {
	const { projections } = fixtures();
	const flows = await computeFlows(projections, 's1', NOW);
	// Includes the worklist fixture orders (oA-oF) and oLegacy, all within the window.
	// oE is fulfilled-then-cancelled, so it counts once, in cancelled; oF is digital,
	// so it counts once, in noFulfillmentExpected — never as fulfilled.
	assert.deepEqual(flows.lanes, { paid: 9, fulfilled: 2, awaitingConfirmation: 5, noFulfillmentExpected: 1, cancelled: 1, refunded: 0 });
	// Rebuild = same function over the same data → identical (idempotent).
	assert.deepEqual((await computeFlows(projections, 's1', NOW)).lanes, flows.lanes);
});

test('the summary order counts and the flow lanes describe the same window', async () => {
	const { events, projections, findings, deliveries, shops } = fixtures();
	// An order whose last activity is older than the window — present because the
	// purge has not run yet. Neither panel may count it.
	await projections.put({
		id: 's1:oStale',
		shopId: 's1',
		orderId: 'oStale',
		paidAt: NOW - 20 * DAY,
		requiresFulfillment: true,
		state: 'awaiting',
		lastEventAt: NOW - 20 * DAY,
	});
	const summary = await getSummary({ events, projections, findings, deliveries, shops }, 's1', NOW);
	const flows = await computeFlows(projections, 's1', NOW);
	const orders = summary.orders as { tracked: number; awaitingConfirmation: number };
	const lanes = flows.lanes as Record<string, number>;
	assert.equal(orders.awaitingConfirmation, lanes.awaitingConfirmation);
	// The fixture universe already has nine in-window s1 orders (o1, o2, oA-oF,
	// oLegacy) before oStale is added; oStale must not become a tenth.
	assert.equal(orders.tracked, 9, 'the out-of-window order must not be counted');
});

test('the order scans bound the window in the database, not only in code', async () => {
	// getSummary runs on every screen load. Both it and computeFlows searched on
	// `{ shopId }` alone and dropped out-of-window rows in code, so the hottest read
	// in the app scanned every projection the shop had ever stored. The predicate is
	// indexable and identical to the one listOrders already used, so it belongs in the
	// query — the code-side check stays as a belt, which is why every count above is
	// unchanged.
	const { events, findings, deliveries, shops } = fixtures();
	const projections = new FakeTable('id', [
		{ id: 's1:in', shopId: 's1', orderId: 'in', paidAt: NOW - HOUR, requiresFulfillment: true, state: 'awaiting', lastEventAt: NOW - HOUR },
		// Purge residue: expired but still queryable (a purge run capped at
		// MAX_DELETES_PER_RUN leaves some behind).
		{
			id: 's1:old',
			shopId: 's1',
			orderId: 'old',
			paidAt: NOW - 20 * DAY,
			requiresFulfillment: true,
			state: 'awaiting',
			lastEventAt: NOW - 20 * DAY,
		},
	]);
	let yielded = 0;
	const counting = {
		search: async function* (spec: unknown) {
			for await (const row of projections.search(spec as never)) {
				yielded++;
				yield row;
			}
		},
		get: (id: string) => projections.get(id),
	} as unknown as typeof projections;

	const summary = await getSummary({ events, projections: counting, findings, deliveries, shops }, 's1', NOW);
	assert.equal((summary.orders as { tracked: number }).tracked, 1);
	assert.equal(yielded, 1, 'the expired row was never read, not read and then discarded');

	yielded = 0;
	const flows = await computeFlows(counting, 's1', NOW);
	assert.equal((flows.lanes as Record<string, number>).awaitingConfirmation, 1);
	assert.equal(yielded, 1);
});

test('the fulfilled count is lane-consistent: a fulfilled-then-cancelled order counts once, as cancelled', async () => {
	const { projections } = fixtures();
	const summary = await getSummary(
		{
			events: new FakeTable('eventId', []),
			projections,
			findings: new FakeTable('id', []),
			deliveries: new FakeTable('id', []),
			shops: new FakeTable('shopId', []),
		},
		's1',
		NOW,
	);
	const flows = await computeFlows(projections, 's1', NOW);
	const orders = summary.orders as { fulfilled: number };
	const lanes = flows.lanes as Record<string, number>;
	// oE (paid, then fulfilled, then cancelled) must land in exactly one lane —
	// cancelled — on every surface that counts lanes. Before this fix, getSummary
	// counted "has a fulfilledAt" (3: o1, oD, oE) while computeFlows already
	// counted "is in the fulfilled lane" (2: o1, oD) — the same order rendering as
	// two different "Fulfilled" tile numbers, both linking to the same worklist
	// filter.
	assert.equal(orders.fulfilled, lanes.fulfilled, 'the Overview tile and the flow lane must agree');
	assert.equal(lanes.fulfilled, 2, 'o1 and oD only — oE is cancelled, not fulfilled');
	assert.equal(lanes.cancelled, 1, 'oE counts once, in cancelled');

	const cancelledPage = await listOrders(projections, 's1', NOW, { state: 'cancelled' });
	assert.ok(
		cancelledPage.items.some((i) => i.orderId === 'oE'),
		'the worklist finds oE under the cancelled lane',
	);
	const fulfilledPage = await listOrders(projections, 's1', NOW, { state: 'fulfilled' });
	assert.ok(!fulfilledPage.items.some((i) => i.orderId === 'oE'), 'the worklist must not also show oE under fulfilled');
});

test('getPrivacy reports no PII and the tenant footprint', async () => {
	const f = fixtures();
	const p = await getPrivacy(f, 's1', NOW);
	assert.equal(p.storesCustomerPii, false);
	assert.equal(p.retentionDays, 7);
	// Includes the worklist fixture orders (oA-oF) and oLegacy alongside o1/o2.
	assert.deepEqual(p.footprint, { events: 3, orders: 9, findings: 1 });
});

test('getPrivacy discloses scopes, exclusions, and capture/reconciliation health', async () => {
	const f = fixtures();
	const p = await getPrivacy(f, 's1', NOW);
	assert.deepEqual(p.scopes, ['read_orders', 'read_fulfillments']);
	assert.ok(
		(p.excludedFields as string[]).some((x) => /email/i.test(x)),
		'the exclusion list is stated, not just the inclusion list',
	);
	// Delivery health is this shop's only — s2's delivery must not be counted.
	assert.deepEqual(p.webhooks, { received: 2, processed: 1, deadLettered: 1, healthy: false, lastReceivedAt: NOW - 900 });
	assert.equal((p.reconciliation as Record<string, unknown>).stale, false);
});

test('getPrivacy never returns token material or cross-tenant metrics', async () => {
	const f = fixtures();
	// A credential-shaped secret on the shop row must not reach the response.
	f.shops.rows.set('s1', { ...(f.shops.rows.get('s1') as Record<string, unknown>), accessTokenEnc: 'SECRET' });
	const serialized = JSON.stringify(await getPrivacy(f, 's1', NOW));
	assert.ok(!serialized.includes('SECRET'), 'no token material in the privacy payload');
	assert.ok(!serialized.includes('s2'), 'no other tenant referenced');
});

test('the privacy payload discloses whether a notification address is stored, without echoing it', async () => {
	const { events, findings, projections, deliveries, shops } = fixtures();
	const subscriptions = new FakeTable('shopId', [{ shopId: 's1', email: 'ops@merchant.example', cadence: 'daily', status: 'active' }]);
	const privacy = await getPrivacy({ events, findings, projections, deliveries, shops, digestSubscriptions: subscriptions }, 's1', NOW);
	const notifications = privacy.notifications as { emailStored: boolean; status: string };
	assert.equal(notifications.emailStored, true);
	assert.equal(notifications.status, 'active');
	// The address itself is on the Notifications screen; the privacy payload states
	// only that one exists, so this endpoint cannot become an address disclosure.
	assert.equal(JSON.stringify(privacy).includes('ops@merchant.example'), false);
});

test('a shop with no subscription reports none stored', async () => {
	const { events, findings, projections, deliveries, shops } = fixtures();
	const privacy = await getPrivacy(
		{ events, findings, projections, deliveries, shops, digestSubscriptions: new FakeTable('shopId') },
		's1',
		NOW,
	);
	assert.equal((privacy.notifications as { emailStored: boolean }).emailStored, false);
});

test('the data categories disclose the notification address', async () => {
	const { events, findings, projections, deliveries, shops } = fixtures();
	const privacy = await getPrivacy(
		{ events, findings, projections, deliveries, shops, digestSubscriptions: new FakeTable('shopId') },
		's1',
		NOW,
	);
	assert.ok((privacy.dataCategories as string[]).some((c) => /notification email/i.test(c)));
});

test('the no-customer-PII promise is unchanged by the notification address', async () => {
	const { events, findings, projections, deliveries, shops } = fixtures();
	const privacy = await getPrivacy(
		{ events, findings, projections, deliveries, shops, digestSubscriptions: new FakeTable('shopId') },
		's1',
		NOW,
	);
	// A merchant's own staff address is not customer data.
	assert.equal(privacy.storesCustomerPii, false);
	assert.deepEqual(privacy.excludedFields, ['customer name', 'customer email', 'customer phone', 'shipping & billing address']);
});

test('the deletion disclosure states the digest outbox retention alongside the ledger purge', async () => {
	// getPrivacy imports OUTBOX_RETENTION_DAYS from src/retention.ts directly
	// (queries.ts used to hold its own duplicated `DIGEST_OUTBOX_RETENTION_DAYS`
	// literal, checked against the real constant by reading src/ledgerTargets.ts
	// as text — now that db.ts is importable under test, the constant could have
	// been imported from ledgerTargets.ts, but it lives in retention.ts instead,
	// which has no imports of its own, so queries.ts stays testable without
	// `--conditions=test`. Either way there is only one number to get right, not
	// two to keep in sync).
	const { events, findings, projections, deliveries, shops } = fixtures();
	const privacy = await getPrivacy({ events, findings, projections, deliveries, shops }, 's1', NOW);
	const automatic = (privacy.deletion as Record<string, string>).automatic;
	assert.match(automatic, /7-day/);
	assert.match(automatic, /30 days/);
});

test('the privacy disclosure lists every category actually stored, and no more', async () => {
	const { events, findings, projections, deliveries, shops } = fixtures();
	const privacy = await getPrivacy({ events, findings, projections, deliveries, shops }, 's1', NOW);
	// Exact array, in order: this is what makes "and no more" real. A spot-check
	// via .includes() would still pass if a category were added, duplicated, or
	// silently dropped.
	assert.deepEqual(privacy.dataCategories, [
		'order status & timestamps',
		'order name (e.g. #1001)',
		'order value & currency',
		'fulfillment status, location, tracking presence & carrier',
		'inventory levels',
		'refund status',
		'SKUs, product & variant titles & quantities',
		'notification email you supply for digests (merchant contact, not customer data)',
		// DigestOutbox is a real, independently-retained data category (30 days,
		// not the 7-day ledger) once its rows hold no body — leaving it off this
		// disclosure would understate what is stored.
		'digest record: counts and subject line only, kept 30 days (no order names or customer data)',
	]);
	// The exclusion list is the load-bearing promise and must not have widened.
	assert.deepEqual(privacy.excludedFields, ['customer name', 'customer email', 'customer phone', 'shipping & billing address']);
	assert.equal(privacy.storesCustomerPii, false);
});

test('getSetup derives each step from durable state, never a timer', async () => {
	const f = fixtures();
	// s1: installed, deliveries observed, reconciliation ready → complete.
	const done = await getSetup(f, 's1', NOW);
	assert.equal(done.complete, true);
	assert.deepEqual(
		(done.steps as Array<Record<string, unknown>>).map((s) => s.state),
		['done', 'done', 'done'],
	);
	assert.equal(done.action, 'none');

	assert.equal(done.eventsObserved, true);

	// A fresh install: installed, but no credential yet and no sweep finished.
	const fresh = await getSetup(
		{
			shops: new FakeTable('shopId', [{ shopId: 's3', status: 'active', installedAt: NOW, reconciliationState: 'pending' }]),
			deliveries: new FakeTable('id', []),
			credentials: new FakeTable('shopId', []),
		},
		's3',
		NOW,
	);
	assert.equal(fresh.complete, false);
	assert.deepEqual(
		(fresh.steps as Array<Record<string, unknown>>).map((s) => s.state),
		['done', 'waiting', 'running'],
		'no credential yet → the connection step is still in progress',
	);
	assert.equal(fresh.eventsObserved, false);
});

test('getSetup stays complete for a connected shop that has simply been quiet', async () => {
	// Deliveries live on the 7-day ledger and get purged. A healthy low-volume shop
	// with nothing in the window must NOT regress to "not set up" — otherwise a
	// returning merchant gets bounced back to the first-open screen.
	const setup = await getSetup(
		{
			shops: new FakeTable('shopId', [
				{ shopId: 's4', status: 'active', installedAt: NOW - 30 * DAY, lastReconciledAt: NOW - 60_000, reconciliationState: 'ready' },
			]),
			deliveries: new FakeTable('id', []),
			credentials: new FakeTable('shopId', [{ shopId: 's4', status: 'active' }]),
		},
		's4',
		NOW,
	);
	assert.equal(setup.complete, true, 'a purged-but-healthy ledger does not un-complete setup');
	assert.equal(setup.eventsObserved, false, 'but the UI can still say "connected — no events yet"');
});

test('getSetup surfaces reauthorization as the one safe action', async () => {
	const f = fixtures();
	const blocked = await getSetup(
		{ ...f, credentials: new FakeTable('shopId', [{ shopId: 's1', status: 'reauthorization_required' }]) },
		's1',
		NOW,
	);
	assert.equal(blocked.action, 'reauthorize');
	assert.equal(blocked.complete, false);
	assert.deepEqual(
		(blocked.steps as Array<Record<string, unknown>>).map((s) => s.state),
		['done', 'blocked', 'blocked'],
	);
});

test('getSetup is tenant-scoped: another shop’s deliveries are not this shop’s activity', async () => {
	const setup = await getSetup(
		{
			shops: new FakeTable('shopId', [{ shopId: 's3', status: 'active', installedAt: NOW, reconciliationState: 'pending' }]),
			deliveries: new FakeTable('id', [{ id: 's9:d1', shopId: 's9', status: 'processed', receivedAt: NOW }]),
			credentials: new FakeTable('shopId', [{ shopId: 's3', status: 'active' }]),
		},
		's3',
		NOW,
	);
	assert.equal(setup.eventsObserved, false, "another tenant's delivery is not evidence this shop has seen activity");
});

test('the summary reports an aging breakdown of orders awaiting confirmation', async () => {
	const { events, projections, findings, deliveries, shops } = fixtures();
	const summary = await getSummary({ events, projections, findings, deliveries, shops }, 's1', NOW);
	const aging = summary.aging as { buckets: Array<{ key: string; count: number }> };
	const byKey = Object.fromEntries(aging.buckets.map((b) => [b.key, b.count]));
	// o2 (paid 2000ms ago) and oA (paid 2h ago) are both awaiting and both under24.
	// Every bucket is non-empty, which is what makes the per-bucket link assertions
	// in view.test.ts and test/overviewLinks.test.ts able to fail.
	assert.equal(byKey.under24, 2); // o2, oA
	assert.equal(byKey.h24to48, 1); // oB, paid 30h ago
	assert.equal(byKey.h48to72, 1); // oLegacy, paid 50h ago
	assert.equal(byKey.over72, 1); // oC, paid 80h ago
	// The buckets partition the awaiting set: no order is in two, none is in none.
	assert.equal(
		aging.buckets.reduce((n, b) => n + b.count, 0),
		(summary.orders as { awaitingConfirmation: number }).awaitingConfirmation,
	);
});

test('aging counts only awaiting orders — a fulfilled order is not aging', async () => {
	const { events, projections, findings, deliveries, shops } = fixtures();
	const summary = await getSummary({ events, projections, findings, deliveries, shops }, 's1', NOW);
	const aging = summary.aging as { buckets: Array<{ count: number }> };
	const total = aging.buckets.reduce((n, b) => n + b.count, 0);
	assert.equal(total, (summary.orders as { awaitingConfirmation: number }).awaitingConfirmation);
});

test('the aging breakdown never counts another tenant orders', async () => {
	const { events, projections, findings, deliveries, shops } = fixtures();
	const summary = await getSummary({ events, projections, findings, deliveries, shops }, 's2', NOW);
	const aging = summary.aging as { buckets: Array<{ count: number }> };
	// s2 genuinely has two awaiting orders of its own (s2:o1, s2:oA — both paid,
	// requiresFulfillment, never fulfilled/cancelled/refunded). Do not "correct"
	// this to 1: if s1's four awaiting orders leaked into an s2 query, the total
	// would be 6, not 2 — asserting 2 is what actually proves tenant isolation.
	assert.equal(
		aging.buckets.reduce((n, b) => n + b.count, 0),
		2,
	);
});

test('the summary counts events observed by direct check rather than by webhook', async () => {
	const { events, projections, findings, deliveries, shops } = fixtures();
	await events.put({
		eventId: 'recon:s1:o9:paid',
		shopId: 's1',
		domain: 'order',
		topic: 'orders/paid',
		resourceId: 'o9',
		source: 'reconciliation',
		occurredAt: NOW - 2000,
		receivedAt: NOW - 2000,
	});
	const summary = await getSummary({ events, projections, findings, deliveries, shops }, 's1', NOW);
	const integrity = summary.integrity as { webhookEvents: number; reconciliationOnlyEvents: number };
	assert.equal(integrity.reconciliationOnlyEvents, 1);
	assert.ok(integrity.webhookEvents >= 1);
});

test('a webhook event and its reconciliation twin for the same order and change are not counted as reconciliation-only', async () => {
	// This is the exact defect a reviewer proved empirically: reconcileShopWithToken
	// is a rolling resync, so a healthy webhook delivery is routinely followed by a
	// matching reconciliation event for the SAME change on the next sweep. Webhook
	// and reconciliation event ids can never collide, so both rows persist — and the
	// old tally (source === 'reconciliation') counted the reconciliation twin as a
	// capture failure even though the webhook plainly arrived. This test is the one
	// that returns 1 (wrongly) on the pre-fix implementation.
	const { events, projections, findings, deliveries, shops } = fixtures();
	await events.put({
		eventId: 's1:webhook-o10',
		shopId: 's1',
		domain: 'order',
		topic: 'orders/paid',
		resourceId: 'o10',
		state: 'paid',
		source: 'webhook',
		occurredAt: NOW - 3000,
		receivedAt: NOW - 3000,
	});
	await events.put({
		eventId: 'recon:s1:o10:paid',
		shopId: 's1',
		domain: 'order',
		topic: 'orders/paid',
		resourceId: 'o10',
		state: 'paid',
		source: 'reconciliation',
		// The order's own timestamp, not the sweep time — the reason a matching
		// pair lands in the same window without any special-casing.
		occurredAt: NOW - 2000,
		receivedAt: NOW - 2000,
	});
	const summary = await getSummary({ events, projections, findings, deliveries, shops }, 's1', NOW);
	assert.equal((summary.integrity as { reconciliationOnlyEvents: number }).reconciliationOnlyEvents, 0);
});

test('a reconciliation event with no matching webhook event is still counted as reconciliation-only', async () => {
	// Proves the fix did not simply zero the number out: a genuine capture gap (no
	// webhook counterpart at all, for a different order/kind than any webhook row)
	// must still be reported.
	const { events, projections, findings, deliveries, shops } = fixtures();
	await events.put({
		eventId: 'recon:s1:o11:cancelled',
		shopId: 's1',
		domain: 'order',
		topic: 'orders/cancelled',
		resourceId: 'o11',
		state: 'voided',
		source: 'reconciliation',
		occurredAt: NOW - 3000,
		receivedAt: NOW - 3000,
	});
	const summary = await getSummary({ events, projections, findings, deliveries, shops }, 's1', NOW);
	assert.equal((summary.integrity as { reconciliationOnlyEvents: number }).reconciliationOnlyEvents, 1);
});

test('a webhook event just before windowStart still matches its reconciliation twin just inside it', async () => {
	// The concrete failing case this task exists to fix: the webhook and its
	// reconciliation twin timestamp the SAME real change from different fields
	// (see the comment in getSummary), so a pair can straddle windowStart even
	// though nothing actually went missing. Before the margin, the in-window
	// reconciliation row here would have reported a phantom capture gap.
	const { events, projections, findings, deliveries, shops } = fixtures();
	const windowStart = NOW - 7 * DAY;
	await events.put({
		eventId: 's1:webhook-o20',
		shopId: 's1',
		domain: 'order',
		topic: 'orders/paid',
		resourceId: 'o20',
		state: 'paid',
		source: 'webhook',
		occurredAt: windowStart - 500, // just before the window
		receivedAt: windowStart - 500,
	});
	await events.put({
		eventId: 'recon:s1:o20:paid',
		shopId: 's1',
		domain: 'order',
		topic: 'orders/paid',
		resourceId: 'o20',
		state: 'paid',
		source: 'reconciliation',
		occurredAt: windowStart + 500, // just inside the window
		receivedAt: windowStart + 500,
	});
	const summary = await getSummary({ events, projections, findings, deliveries, shops }, 's1', NOW);
	assert.equal((summary.integrity as { reconciliationOnlyEvents: number }).reconciliationOnlyEvents, 0);
});

test('a reconciliation event with no twin anywhere in the margin is still counted, not zeroed by the fix', async () => {
	// Without this, a change that simply always returns 0 for reconciliationOnlyEvents
	// would pass the test above. This reconciliation row has no webhook counterpart
	// at all — not in the window, not in the margin either side — so it is a real,
	// reportable capture gap.
	const { events, projections, findings, deliveries, shops } = fixtures();
	const windowStart = NOW - 7 * DAY;
	await events.put({
		eventId: 'recon:s1:o21:paid',
		shopId: 's1',
		domain: 'order',
		topic: 'orders/paid',
		resourceId: 'o21',
		state: 'paid',
		source: 'reconciliation',
		occurredAt: windowStart + 500,
		receivedAt: windowStart + 500,
	});
	const summary = await getSummary({ events, projections, findings, deliveries, shops }, 's1', NOW);
	assert.equal((summary.integrity as { reconciliationOnlyEvents: number }).reconciliationOnlyEvents, 1);
});

test('integrity counts are scoped to the shop', async () => {
	const { events, projections, findings, deliveries, shops } = fixtures();
	await events.put({
		eventId: 'recon:s2:o9:paid',
		shopId: 's2',
		domain: 'order',
		resourceId: 'o9',
		source: 'reconciliation',
		occurredAt: NOW - 2000,
		receivedAt: NOW - 2000,
	});
	const summary = await getSummary({ events, projections, findings, deliveries, shops }, 's1', NOW);
	assert.equal((summary.integrity as { reconciliationOnlyEvents: number }).reconciliationOnlyEvents, 0);
});

test('the summary counts unconfirmed failed-attempt findings separately from absence findings', async () => {
	const { events, projections, findings, deliveries, shops } = fixtures();
	await findings.put({
		id: 'fulfillment_attempt_failed:s1:oB:1',
		shopId: 's1',
		orderId: 'oB',
		detector: 'fulfillment_attempt_failed',
		status: 'unconfirmed',
		detectedAt: NOW - 20 * HOUR,
	});
	const summary = await getSummary({ events, projections, findings, deliveries, shops }, 's1', NOW);
	const f = summary.findings as { unconfirmed: number; failedAttempts: number };
	assert.equal(f.failedAttempts, 1);
	// It is still an unconfirmed finding, so the headline count includes it.
	assert.ok(f.unconfirmed >= 1);
});

test('orders default to latest-activity first and carry the worklist columns', async () => {
	const { projections } = fixtures();
	const page = await listOrders(projections, 's1', NOW, {});
	// Unfiltered, so the pre-existing o1/o2 fixture rows (last active seconds ago)
	// sort ahead of the worklist rows (hours ago) — newest lastEventAt first. The
	// sort key is lastEventAt, not paidAt: paidAt is nullable and a keyset pager on
	// a nullable column cannot page (C3).
	assert.deepEqual(
		page.items.map((i) => i.orderId),
		['o1', 'o2', 'oA', 'oF', 'oD', 'oE', 'oB', 'oLegacy', 'oC'],
	);
	const first = page.items.find((i) => i.orderId === 'oA')!;
	assert.equal(first.orderName, '#1004');
	assert.equal(first.state, 'awaiting');
	assert.equal(first.orderTotal, 50);
	assert.equal(first.currency, 'USD');
	assert.equal(first.ageHours, 2);
});

test('the worklist can be sorted oldest-first, which is what triage needs', async () => {
	const { projections } = fixtures();
	const page = await listOrders(projections, 's1', NOW, { sort: 'oldest' });
	assert.deepEqual(
		page.items.map((i) => i.orderId),
		['oC', 'oLegacy', 'oB', 'oE', 'oD', 'oF', 'oA', 'o2', 'o1'],
	);
});

test('a digital order is neither awaiting nor claimed as fulfilled', async () => {
	const { projections } = fixtures();
	// oF is paid, live, and has no observed fulfillment and no observed
	// fulfillment-eligible units. Before it had a lane of its own it fell through to
	// 'fulfilled' — a tile asserting a fulfillment nobody observed.
	const fulfilled = await listOrders(projections, 's1', NOW, { state: 'fulfilled' });
	assert.deepEqual(new Set(fulfilled.items.map((i) => i.orderId)), new Set(['o1', 'oD']), 'only orders with an observed fulfillment');
	const awaiting = await listOrders(projections, 's1', NOW, { state: 'awaiting' });
	assert.ok(!awaiting.items.some((i) => i.orderId === 'oF'), 'and it is not awaiting a confirmation nobody expects');
	const own = await listOrders(projections, 's1', NOW, { state: 'no_fulfillment_expected' });
	assert.deepEqual(
		own.items.map((i) => i.orderId),
		['oF'],
	);
});

test('orders filter by lane', async () => {
	const { projections } = fixtures();
	const page = await listOrders(projections, 's1', NOW, { state: 'awaiting' });
	// o2 belongs here too — it is paid, fulfillment-eligible and unconfirmed. It was
	// missing from this expectation only because the fixture row carried no stored
	// `state`, which is the divergence C1 fixed: the Overview counted it (awaiting: 4)
	// while this list returned three.
	assert.deepEqual(new Set(page.items.map((i) => i.orderId)), new Set(['o2', 'oA', 'oB', 'oC']));
});

test('a legacy projection with no stored state is counted but not listed, until the backfill runs', async () => {
	// This is C1, stated as an executable fact rather than left implicit across the
	// fixture set. oLegacy is paid, fulfillment-eligible, unfulfilled and quiet — so
	// getSummary/computeFlows, which derive the lane live, count it as awaiting,
	// while listOrders, which filters the stored `state` column, cannot see it. A
	// count that disagrees with the list it links to is the defect; the fix is the
	// backfill sweep (src/stateBackfill.ts), not a query-time fallback, because the
	// stored column is what makes DB-side filtering and honest paging possible.
	const f = fixtures();
	const legacy = await f.projections.get('s1:oLegacy');
	assert.equal(legacy?.state, undefined, 'the fixture legacy row must genuinely carry no state');

	const summary = await getSummary(f, 's1', NOW);
	assert.equal((summary.orders as { awaitingConfirmation: number }).awaitingConfirmation, 5, 'the live lane counts it');

	const listed = await listOrders(f.projections, 's1', NOW, { state: 'awaiting' });
	assert.ok(!listed.items.some((i) => i.orderId === 'oLegacy'), 'the stored-state filter cannot see it');
	assert.equal(listed.items.length, 4, 'so the count and the list disagree by exactly this row');

	// It is still visible in the UNFILTERED worklist and in its own detail view — the
	// row is not lost, only unreachable through the lane filter.
	const all = await listOrders(f.projections, 's1', NOW, {});
	assert.ok(all.items.some((i) => i.orderId === 'oLegacy'));
	assert.equal((await getOrderDetail(f.projections, f.events, f.findings, 's1', NOW, 'oLegacy'))?.orderId, 'oLegacy');
});

test('orders filter by minimum age, which is the sub-deadline aging view', async () => {
	const { projections } = fixtures();
	const page = await listOrders(projections, 's1', NOW, { state: 'awaiting', minAgeHours: 24 });
	assert.deepEqual(new Set(page.items.map((i) => i.orderId)), new Set(['oB', 'oC']));
});

test('orders filter by maximum age, so an aging bucket link opens the bucket', async () => {
	const { projections } = fixtures();
	// The stored-state universe after the backfill has run, which is what production
	// looks like once the sweep converges — the bucket links must reproduce their
	// counts there, not only on a hand-picked subset.
	await runStateBackfill(NOW, {
		projections: projections as unknown as BackfillDeps['projections'],
		checkpoints: new FakeTable('id', []) as unknown as BackfillDeps['checkpoints'],
	});
	const bucketed = async (min: number, max?: number) =>
		(await listOrders(projections, 's1', NOW, { state: 'awaiting', minAgeHours: min, maxAgeHours: max })).items
			.map((i) => String(i.orderId))
			.sort();

	// The awaiting set by age: o2 (2s), oA (2h), oB (30h), oLegacy (50h), oC (80h).
	assert.deepEqual(await bucketed(0, 24), ['o2', 'oA'], 'under24 opens under24, not everything');
	assert.deepEqual(await bucketed(24, 48), ['oB']);
	assert.deepEqual(await bucketed(48, 72), ['oLegacy']);
	assert.deepEqual(await bucketed(72), ['oC'], 'the last bucket is genuinely open-ended');
	// Without the upper bound, three of the four opened a strictly larger set.
	assert.deepEqual(await bucketed(0), ['o2', 'oA', 'oB', 'oC', 'oLegacy']);
});

test('the age bounds partition: no awaiting order lands in two buckets or in none', async () => {
	const { projections } = fixtures();
	await runStateBackfill(NOW, {
		projections: projections as unknown as BackfillDeps['projections'],
		checkpoints: new FakeTable('id', []) as unknown as BackfillDeps['checkpoints'],
	});
	// An order paid EXACTLY on a boundary is the case a `<=`/`<=` pair would
	// double-count and a `<`/`<` pair would drop. The query pairs `<=` with `>`.
	for (const hours of [0, 24, 48, 72]) {
		await projections.put({
			id: `s1:edge${hours}`,
			shopId: 's1',
			orderId: `edge${hours}`,
			paidAt: NOW - hours * HOUR,
			requiresFulfillment: true,
			state: 'awaiting',
			lastEventAt: NOW - hours * HOUR,
		});
	}
	const buckets: Array<[number, number | undefined]> = [
		[0, 24],
		[24, 48],
		[48, 72],
		[72, undefined],
	];
	const seen = new Map<string, number>();
	for (const [min, max] of buckets) {
		const page = await listOrders(projections, 's1', NOW, { state: 'awaiting', minAgeHours: min, maxAgeHours: max });
		for (const item of page.items) seen.set(String(item.orderId), (seen.get(String(item.orderId)) ?? 0) + 1);
	}
	const all = await listOrders(projections, 's1', NOW, { state: 'awaiting' });
	assert.equal(seen.size, all.items.length, 'every awaiting order is in some bucket');
	for (const [orderId, count] of seen) assert.equal(count, 1, `${orderId} appears in ${count} buckets`);
});

test('orders never leak another tenant order that shares an id', async () => {
	const { projections } = fixtures();
	const page = await listOrders(projections, 's1', NOW, {});
	for (const item of page.items) assert.notEqual(item.orderName, '#9999');
});

test('a hostile state filter returns nothing rather than everything', async () => {
	const { projections } = fixtures();
	const page = await listOrders(projections, 's1', NOW, { state: "awaiting' OR 1=1" });
	assert.deepEqual(page.items, []);
});

test('orders page with a stable cursor and no duplicates across pages', async () => {
	const { projections } = fixtures();
	const first = await listOrders(projections, 's1', NOW, { limit: 2 });
	const second = await listOrders(projections, 's1', NOW, { limit: 2, cursor: first.nextCursor });
	const ids = [...first.items, ...second.items].map((i) => i.orderId);
	assert.equal(new Set(ids).size, ids.length);
	assert.equal(ids.length, 4);
});

test('the ascending (oldest-first) worklist pages correctly across a tied lastEventAt boundary', async () => {
	// A separate, purpose-built fixture — not the shared fixtures() universe — so
	// a tie can be placed exactly where a naive comparator or an off-by-one
	// boundary actually breaks: split across two pages. This is the case the
	// ascending path's id tiebreak exists for, and the only committed test that
	// exercises more than one page of the ascending path.
	const projections = new FakeTable('id', [
		{ id: 's1:a', shopId: 's1', orderId: 'a', paidAt: NOW - 10 * HOUR, requiresFulfillment: true, lastEventAt: NOW - 10 * HOUR },
		{ id: 's1:b', shopId: 's1', orderId: 'b', paidAt: NOW - 10 * HOUR, requiresFulfillment: true, lastEventAt: NOW - 10 * HOUR }, // tied with a
		{ id: 's1:c', shopId: 's1', orderId: 'c', paidAt: NOW - 20 * HOUR, requiresFulfillment: true, lastEventAt: NOW - 20 * HOUR },
		{ id: 's1:d', shopId: 's1', orderId: 'd', paidAt: NOW - 5 * HOUR, requiresFulfillment: true, lastEventAt: NOW - 5 * HOUR },
		{ id: 's1:e', shopId: 's1', orderId: 'e', paidAt: NOW - 1 * HOUR, requiresFulfillment: true, lastEventAt: NOW - 1 * HOUR },
	]);

	// Walk the entire oldest-first list two rows at a time until nextCursor is absent.
	let cursor: string | undefined;
	const seen: string[] = [];
	for (let guard = 0; guard < 10; guard++) {
		const page = await listOrders(projections, 's1', NOW, { sort: 'oldest', limit: 2, cursor });
		seen.push(...page.items.map((i) => String(i.orderId)));
		if (!page.nextCursor) break;
		cursor = page.nextCursor;
	}
	// c is oldest, then the tied a/b pair (id tiebreak: 'a' < 'b' ascending), then
	// d, then e. The tie falls exactly on the page-1/page-2 boundary at limit 2.
	assert.deepEqual(seen, ['c', 'a', 'b', 'd', 'e'], 'every row exactly once, in order, across the tie boundary');
	assert.equal(new Set(seen).size, seen.length, 'no duplicates across the page boundary');
});

test('the unpaid lane pages to the end instead of repeating its first page forever', async () => {
	// The 'unpaid' lane is an option in the worklist's Lane select, and an unpaid
	// projection has NO paidAt — `orders/create` is subscribed and paidAt is only
	// latched on payment, so every pending, authorized-not-captured, COD or draft
	// order sits here indefinitely. When the pager keyset on paidAt, Number(undefined)
	// encoded a "NaN|<id>" cursor that decodeCursor then rejected, so the next page
	// ran with no boundary condition and returned the same page again: 12 rows
	// fetched, 2 unique, and a five-order store exported 5000 duplicate rows.
	const projections = new FakeTable(
		'id',
		Array.from({ length: 5 }, (_unused, i) => ({
			id: `s1:u${i}`,
			shopId: 's1',
			orderId: `u${i}`,
			state: 'unpaid',
			lastEventAt: NOW - 1000 * i,
		})),
	);
	let cursor: string | undefined;
	const seen: string[] = [];
	for (let guard = 0; guard < 10; guard++) {
		const page = await listOrders(projections, 's1', NOW, { state: 'unpaid', limit: 2, cursor });
		seen.push(...page.items.map((i) => String(i.orderId)));
		if (!page.nextCursor) break;
		cursor = page.nextCursor;
	}
	assert.deepEqual(seen, ['u0', 'u1', 'u2', 'u3', 'u4'], 'every unpaid order exactly once, newest activity first');
	assert.equal(new Set(seen).size, seen.length, 'no row repeats across pages');
});

test('the default worklist pages to the end even with an unpaid row mixed into it', async () => {
	// The "Tracked" tile's link is the UNFILTERED worklist, which mixes paid and
	// unpaid rows — so the nullable-sort-key defect was reachable without touching
	// the lane filter at all.
	const projections = new FakeTable('id', [
		{
			id: 's1:p1',
			shopId: 's1',
			orderId: 'p1',
			paidAt: NOW - 1 * HOUR,
			state: 'awaiting',
			requiresFulfillment: true,
			lastEventAt: NOW - 1 * HOUR,
		},
		{ id: 's1:u1', shopId: 's1', orderId: 'u1', state: 'unpaid', lastEventAt: NOW - 2 * HOUR },
		{
			id: 's1:p2',
			shopId: 's1',
			orderId: 'p2',
			paidAt: NOW - 3 * HOUR,
			state: 'awaiting',
			requiresFulfillment: true,
			lastEventAt: NOW - 3 * HOUR,
		},
		{
			id: 's1:p3',
			shopId: 's1',
			orderId: 'p3',
			paidAt: NOW - 4 * HOUR,
			state: 'awaiting',
			requiresFulfillment: true,
			lastEventAt: NOW - 4 * HOUR,
		},
	]);
	let cursor: string | undefined;
	const seen: string[] = [];
	for (let guard = 0; guard < 10; guard++) {
		const page = await listOrders(projections, 's1', NOW, { limit: 2, cursor });
		seen.push(...page.items.map((i) => String(i.orderId)));
		if (!page.nextCursor) break;
		cursor = page.nextCursor;
	}
	assert.deepEqual(seen, ['p1', 'u1', 'p2', 'p3']);
	// The unpaid row has no age to report, and reports none rather than 0.
	const unpaid = (await listOrders(projections, 's1', NOW, {})).items.find((i) => i.orderId === 'u1');
	assert.ok(unpaid && !Object.prototype.hasOwnProperty.call(unpaid, 'ageHours'), 'an unpaid row carries no ageHours');
});

test('order detail returns the projection, its events, and its findings', async () => {
	const { projections, events, findings } = fixtures();
	const detail = await getOrderDetail(projections, events, findings, 's1', NOW, 'o1');
	assert.equal(detail?.orderId, 'o1');
	assert.ok(Array.isArray(detail?.events));
	assert.ok(Array.isArray(detail?.findings));
});

test('order detail for another tenant order returns null, whatever id is supplied', async () => {
	const { projections, events, findings } = fixtures();
	assert.equal(await getOrderDetail(projections, events, findings, 's1', NOW, '../s2:oA'), null);
	// s2 genuinely has order oA; s1 must not see it.
	const detail = await getOrderDetail(projections, events, findings, 's1', NOW, 'oA');
	assert.notEqual(detail?.orderName, '#9999');
});

test('order detail reports ageHours for a paid order, and omits it entirely for an unpaid one', async () => {
	const { events, findings } = fixtures();
	const paidProjections = new FakeTable('id', [
		{ id: 's1:aged', shopId: 's1', orderId: 'aged', paidAt: NOW - 2 * HOUR, requiresFulfillment: true, lastEventAt: NOW - 2 * HOUR },
	]);
	const paid = await getOrderDetail(paidProjections, events, findings, 's1', NOW, 'aged');
	assert.equal(paid?.ageHours, 2, 'computed per request, same as listOrders');

	// An order with no paidAt (not yet paid) has no age to report — omitted, not 0.
	const unpaidProjections = new FakeTable('id', [
		{ id: 's1:unpaid', shopId: 's1', orderId: 'unpaid', requiresFulfillment: true, lastEventAt: NOW },
	]);
	const unpaid = await getOrderDetail(unpaidProjections, events, findings, 's1', NOW, 'unpaid');
	assert.equal(unpaid?.ageHours, undefined);
	assert.ok(!Object.prototype.hasOwnProperty.call(unpaid, 'ageHours'), 'ageHours key is absent, not present as undefined');
});

test('order detail only surfaces events inside the retention window', async () => {
	const events = new FakeTable('eventId', [
		{ eventId: 's1:in', shopId: 's1', domain: 'order', resourceId: 'o1', occurredAt: NOW - DAY, receivedAt: NOW - DAY },
		// Retention purge lag can leave a stale row queryable past its window —
		// the detail view must still honor the same bound every other view does.
		{ eventId: 's1:stale', shopId: 's1', domain: 'order', resourceId: 'o1', occurredAt: NOW - 8 * DAY, receivedAt: NOW - 8 * DAY },
	]);
	const { projections, findings } = fixtures();
	const detail = await getOrderDetail(projections, events, findings, 's1', NOW, 'o1');
	assert.ok(detail);
	assert.deepEqual(
		(detail.events as Array<Record<string, unknown>>).map((e) => e.eventId),
		['s1:in'],
	);
});
