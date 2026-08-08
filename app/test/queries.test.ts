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
} from '../src/queries.ts';
import { EVENT_FIELDS, FINDING_LIST_FIELDS, MAX_LIMIT } from '../src/apiContract.ts';
import { detectorKey } from '../src/detector.ts';

const NOW = 1_000_000_000_000;
const DAY = 86_400_000;

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
	const projections = new FakeTable('id', [
		{
			id: 's1:o1',
			shopId: 's1',
			orderId: 'o1',
			paidAt: NOW - 1000,
			requiresFulfillment: true,
			fulfilledAt: NOW - 500,
			lastEventAt: NOW - 500,
		},
		{ id: 's1:o2', shopId: 's1', orderId: 'o2', paidAt: NOW - 2000, requiresFulfillment: true, lastEventAt: NOW - 2000 }, // awaiting confirmation
		{ id: 's2:o1', shopId: 's2', orderId: 'o1', paidAt: NOW, requiresFulfillment: true, lastEventAt: NOW },
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
	assert.deepEqual(s.orders, { tracked: 2, paid: 2, fulfilled: 1, awaitingConfirmation: 1 });
	assert.deepEqual(s.findings, { unconfirmed: 1, resolved: 0, suppressed: 0 });
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

test('computeFlows lane counts reconcile and are rebuildable from projections', async () => {
	const { projections } = fixtures();
	const flows = await computeFlows(projections, 's1', NOW);
	assert.deepEqual(flows.lanes, { paid: 2, fulfilled: 1, awaitingConfirmation: 1, cancelled: 0, refunded: 0 });
	// Rebuild = same function over the same data → identical (idempotent).
	assert.deepEqual((await computeFlows(projections, 's1', NOW)).lanes, flows.lanes);
});

test('getPrivacy reports no PII and the tenant footprint', async () => {
	const f = fixtures();
	const p = await getPrivacy(f, 's1', NOW);
	assert.equal(p.storesCustomerPii, false);
	assert.equal(p.retentionDays, 7);
	assert.deepEqual(p.footprint, { events: 3, orders: 2, findings: 1 });
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
