import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { refreshOrder, runDetectorForOrder, updateOrderProjection, type OrderTables } from '../src/ingest/orderRefresh.ts';
import { purgeExpired, DAY_MS } from '../src/retention/retention.ts';
import { detectorKey } from '../src/domain/detector.ts';
import { metrics, M } from '../src/observability/observe.ts';
import type { OperationalEvent, OrderProjection } from '../src/domain/model.ts';
import type { SearchQuery } from '../src/retention/retention.ts';
import { FakeTable } from './fakeTable.ts';

const NOW = 1000 * DAY_MS;
const HOUR = 3_600_000;

class CountingTable extends FakeTable {
	searches = 0;
	gets = 0;
	override search(query: SearchQuery): AsyncIterable<Record<string, unknown>> {
		this.searches++;
		return super.search(query);
	}
	override get(id: string): Promise<Record<string, unknown> | undefined> {
		this.gets++;
		return super.get(id);
	}
}

function tables() {
	const t = {
		events: new CountingTable('eventId'),
		projections: new CountingTable('id'),
		expectations: new CountingTable('id'),
		findings: new CountingTable('id'),
	};
	return { ...t, deps: t as unknown as OrderTables };
}

function ev(eventId: string, receivedAt: number, extra: Partial<OperationalEvent> = {}): OperationalEvent {
	return { eventId, shopId: 's', domain: 'order', resourceId: 'o1', source: 'webhook', occurredAt: receivedAt, receivedAt, ...extra };
}
const paid = (id: string, at: number) => ev(id, at, { topic: 'orders/paid', state: 'paid', fulfillableItemCount: 1 });
const fulfilled = (id: string, at: number) => ev(id, at, { domain: 'fulfillment', topic: 'fulfillments/create', state: 'success' });

async function seed(table: FakeTable, events: OperationalEvent[]) {
	for (const e of events) await table.put(e as unknown as Record<string, unknown>);
}

async function storedRow(table: FakeTable): Promise<OrderProjection> {
	return (await table.get('s:o1')) as unknown as OrderProjection;
}

function stored(over: Partial<OrderProjection>): Record<string, unknown> {
	return { id: 's:o1', shopId: 's', orderId: 'o1', paidAt: NOW - 3 * HOUR, requiresFulfillment: true, state: 'awaiting', ...over };
}

beforeEach(() => metrics.reset());

test('a rebuild that saw fewer events than the stored row is skipped and counted', async () => {
	const t = tables();
	await seed(t.events, [paid('e1', NOW - 3 * HOUR), paid('e2', NOW - 2 * HOUR)]);
	const newer = stored({
		eventCount: 3,
		firstEventAt: NOW - 3 * HOUR,
		lastEventAt: NOW - HOUR,
		fulfilledAt: NOW - HOUR,
		state: 'fulfilled',
	});
	await t.projections.put(newer);

	const rebuilt = await updateOrderProjection(t.deps, 's', 'o1', NOW);

	assert.equal(rebuilt, undefined);
	assert.deepEqual(await t.projections.get('s:o1'), newer);
	assert.equal(metrics.snapshot().counters[M.projectionStaleSkipped], 1);
});

test('an equal event count overwrites the stored row', async () => {
	const t = tables();
	await seed(t.events, [paid('e1', NOW - 3 * HOUR), fulfilled('e2', NOW - 2 * HOUR)]);
	await t.projections.put(stored({ eventCount: 2, firstEventAt: NOW - 3 * HOUR, lastEventAt: NOW - 2 * HOUR, state: 'awaiting' }));

	const rebuilt = await updateOrderProjection(t.deps, 's', 'o1', NOW);

	assert.equal(rebuilt?.projection.eventCount, 2);
	const row = await storedRow(t.projections);
	assert.equal(row.state, 'fulfilled');
	assert.equal(row.fulfilledAt, NOW - 2 * HOUR);
	assert.equal(metrics.snapshot().counters[M.projectionStaleSkipped], undefined);
});

test('a stored row with no event count is always overwritten', async () => {
	const t = tables();
	await seed(t.events, [fulfilled('e1', NOW - HOUR)]);
	await t.projections.put(stored({ lastEventAt: NOW - 2 * HOUR, lastSourceVersion: NOW - 2 * HOUR }));

	const rebuilt = await updateOrderProjection(t.deps, 's', 'o1', NOW);

	assert.ok(rebuilt);
	const row = await storedRow(t.projections);
	assert.equal(row.eventCount, 1);
	assert.equal(row.firstEventAt, NOW - HOUR);
	assert.equal(row.fulfilledAt, NOW - HOUR);
});

test('events aged out by the purge do not block a later rebuild', async () => {
	const t = tables();
	const day = (n: number) => n * DAY_MS;
	await seed(t.events, [paid('e1', day(0)), paid('e2', day(0) + HOUR), paid('e3', day(5))]);
	await refreshOrder(t.deps, 's', 'o1', day(5));
	assert.equal((await storedRow(t.projections)).eventCount, 3);

	const purge = await purgeExpired(
		[
			{ name: 'OperationalEvent', keyField: 'eventId', tsField: 'receivedAt', table: t.events },
			{ name: 'OrderProjection', keyField: 'id', tsField: 'lastEventAt', table: t.projections },
		],
		day(7.5),
	);
	assert.equal(purge.byTable.OperationalEvent.deleted, 2);
	assert.equal(purge.byTable.OrderProjection.deleted, 0);

	await seed(t.events, [fulfilled('e4', day(7.5))]);
	await refreshOrder(t.deps, 's', 'o1', day(7.5));

	const row = await storedRow(t.projections);
	assert.equal(row.eventCount, 2);
	assert.equal(row.fulfilledAt, day(7.5));
	assert.equal(row.state, 'fulfilled');
	assert.equal(metrics.snapshot().counters[M.projectionStaleSkipped], undefined);
});

test('the guard still holds while every event of the stored row is a day inside the window', async () => {
	const t = tables();
	await seed(t.events, [paid('e1', NOW - 5 * DAY_MS)]);
	await t.projections.put(stored({ eventCount: 2, firstEventAt: NOW - 5 * DAY_MS, lastEventAt: NOW - HOUR }));

	assert.equal(await updateOrderProjection(t.deps, 's', 'o1', NOW), undefined);
	assert.equal(metrics.snapshot().counters[M.projectionStaleSkipped], 1);
});

test('the detector reuses the rebuild: one event query and one projection read per order', async () => {
	const t = tables();
	await seed(t.events, [paid('e2', NOW - 100 * HOUR), paid('e1', NOW - 99 * HOUR)]);

	await refreshOrder(t.deps, 's', 'o1', NOW);

	assert.equal(t.events.searches, 1);
	assert.equal(t.projections.gets, 1);
	const finding = (await t.findings.get(detectorKey('s', 'o1'))) as { status: string; evidenceEventIds: string[] };
	assert.equal(finding.status, 'unconfirmed');
	assert.deepEqual(finding.evidenceEventIds, ['e1', 'e2']);
});

test('the detector on its own reads the stored projection and the evidence', async () => {
	const t = tables();
	await seed(t.events, [paid('e2', NOW - 100 * HOUR), paid('e1', NOW - 99 * HOUR)]);
	await refreshOrder(t.deps, 's', 'o1', NOW - 99 * HOUR);
	assert.equal(await t.findings.get(detectorKey('s', 'o1')), undefined);
	t.events.searches = 0;
	t.projections.gets = 0;

	await runDetectorForOrder(t.deps, 's', 'o1', NOW);

	assert.equal(t.events.searches, 1);
	assert.equal(t.projections.gets, 1);
	const finding = (await t.findings.get(detectorKey('s', 'o1'))) as { status: string; evidenceEventIds: string[] };
	assert.equal(finding.status, 'unconfirmed');
	assert.deepEqual(finding.evidenceEventIds, ['e1', 'e2']);
});

test('a skipped rebuild evaluates the detector against the stored row', async () => {
	const t = tables();
	await seed(t.events, [paid('e1', NOW - 100 * HOUR)]);
	await t.projections.put(
		stored({
			eventCount: 2,
			firstEventAt: NOW - 100 * HOUR,
			lastEventAt: NOW - HOUR,
			paidAt: NOW - 100 * HOUR,
			fulfilledAt: NOW - HOUR,
			state: 'fulfilled',
		}),
	);

	await refreshOrder(t.deps, 's', 'o1', NOW);

	const finding = await t.findings.get(detectorKey('s', 'o1'));
	assert.equal(finding, undefined, 'the stored row is fulfilled, so no unconfirmed finding');
	const expectation = (await t.expectations.get(detectorKey('s', 'o1'))) as { state: string };
	assert.equal(expectation.state, 'resolved');
});
