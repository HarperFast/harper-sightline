import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTable } from './fakeTable.ts';
import { listEvents, getEventDetail, listFindings, getFindingDetail, getSummary, computeFlows, getPrivacy } from '../src/queries.ts';
import { EVENT_FIELDS, FINDING_FIELDS, MAX_LIMIT } from '../src/apiContract.ts';
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
			id: detectorKey('o2'),
			shopId: 's1',
			orderId: 'o2',
			ruleVersion: 1,
			status: 'unconfirmed',
			detectedAt: NOW - 100,
			evidenceEventIds: ['s1:eX'],
		},
		{ id: detectorKey('oZ'), shopId: 's2', orderId: 'oZ', ruleVersion: 1, status: 'unconfirmed', detectedAt: NOW - 50 },
	]);
	const expectations = new FakeTable('id', [
		{
			id: detectorKey('o2'),
			shopId: 's1',
			orderId: 'o2',
			detector: 'fulfillment_confirmation',
			ruleVersion: 1,
			state: 'expired',
			deadline: NOW - 200,
			createdAt: NOW - 5000,
		},
	]);
	const deliveries = new FakeTable('id', [{ id: 's1:d1', shopId: 's1', status: 'dead_letter' }]);
	return { events, projections, findings, expectations, deliveries };
}

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

test('listFindings is tenant-scoped and filterable by status', async () => {
	const { findings } = fixtures();
	const page = await listFindings(findings, 's1', {});
	assert.deepEqual(
		page.items.map((i) => i.orderId),
		['o2'],
	);
	for (const key of Object.keys(page.items[0])) assert.ok((FINDING_FIELDS as readonly string[]).includes(key), `leaked ${key}`);
	assert.equal((await listFindings(findings, 's1', { status: 'resolved' })).items.length, 0);
});

test('getFindingDetail joins expectation + projection, cross-tenant safe', async () => {
	const { findings, expectations, projections } = fixtures();
	assert.equal(await getFindingDetail(findings, expectations, projections, 's2', detectorKey('o2')), null, 's2 cannot read s1 finding');
	const d = await getFindingDetail(findings, expectations, projections, 's1', detectorKey('o2'));
	assert.equal(d?.status, 'unconfirmed');
	assert.match(String(d?.description), /no shopify fulfillment confirmation/i);
	assert.equal((d?.expectation as Record<string, unknown>)?.deadline, NOW - 200);
	assert.equal((d?.projection as Record<string, unknown>)?.orderId, 'o2');
});

test('getSummary counts reconcile to the fixtures, scoped to the tenant', async () => {
	const f = fixtures();
	const s = await getSummary(f, 's1', NOW);
	assert.equal((s.events as Record<string, number>).total, 2, 's1 in-window events');
	assert.deepEqual(s.orders, { tracked: 2, paid: 2, fulfilled: 1, awaitingConfirmation: 1 });
	assert.deepEqual(s.findings, { unconfirmed: 1, resolved: 0, suppressed: 0 });
	assert.deepEqual(s.recorder, { healthy: false, deadLetteredDeliveries: 1 });
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
	const p = await getPrivacy(f, 's1');
	assert.equal(p.storesCustomerPii, false);
	assert.equal(p.retentionDays, 7);
	assert.deepEqual(p.footprint, { events: 3, orders: 2, findings: 1 });
});
