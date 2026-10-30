import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTable, fakeTransaction } from './fakeTable.ts';
import { eventSkuRows, stripSkus, writeEventWithSkus, type WritableTable } from '../src/ingest/eventSkus.ts';
import type { NormalizedEvent } from '../src/ingest/normalize.ts';
import type { EventSku, OperationalEvent } from '../src/domain/model.ts';

const NOW = 1_775_000_000_000;

function event(over: Partial<NormalizedEvent> = {}): NormalizedEvent {
	return {
		eventId: 's1:w1',
		shopId: 's1',
		domain: 'order',
		topic: 'orders/paid',
		resourceId: 'o1',
		source: 'webhook',
		occurredAt: NOW,
		receivedAt: NOW,
		skus: ['A', 'B'],
		...over,
	};
}

test('one index row per SKU, keyed by event and SKU, carrying the filterable fields', () => {
	const rows = eventSkuRows(event());
	assert.equal(rows.length, 2);
	assert.deepEqual(
		rows.map((r) => r.id),
		['s1:w1:A', 's1:w1:B'],
	);
	assert.equal(rows[0].shopId, 's1');
	assert.equal(rows[0].eventId, 's1:w1');
	assert.equal(rows[0].sku, 'A');
	assert.equal(rows[0].domain, 'order');
	assert.equal(rows[0].topic, 'orders/paid');
	assert.equal(rows[0].source, 'webhook');
	assert.equal(rows[0].resourceId, 'o1');
	assert.equal(rows[0].occurredAt, NOW);
	assert.equal(rows[0].receivedAt, NOW);
});

test('an event with no SKUs produces no index rows', () => {
	assert.deepEqual(eventSkuRows(event({ skus: undefined })), []);
	assert.deepEqual(eventSkuRows(event({ skus: [] })), []);
});

test('stripSkus removes the transport-only fields so they are never stored', () => {
	const stored = stripSkus(event({ skusDropped: 3 }));
	assert.equal('skus' in stored, false);
	assert.equal('skusDropped' in stored, false);
	assert.equal(stored.eventId, 's1:w1');
});

test('the event and its SKU rows are written together or not at all', async () => {
	const events = new FakeTable('eventId');
	const eventSkus = new FakeTable('id');
	const put = eventSkus.put.bind(eventSkus);
	eventSkus.put = async (row) => {
		if (row.sku === 'B') throw new Error('Primary key size is too large');
		await put(row);
	};
	const deps = {
		events: events as unknown as WritableTable<OperationalEvent>,
		eventSkus: eventSkus as unknown as WritableTable<EventSku>,
		transaction: fakeTransaction(events, eventSkus),
	};
	await assert.rejects(writeEventWithSkus(deps, event({ skus: ['A', 'B', 'C'] })), /too large/);
	assert.equal(events.rows.size, 0, 'no event without its SKU rows');
	assert.equal(eventSkus.rows.size, 0, 'no SKU rows without their event');
});

test('a many-SKU event writes one index row per SKU', async () => {
	const events = new FakeTable('eventId');
	const eventSkus = new FakeTable('id');
	const deps = {
		events: events as unknown as WritableTable<OperationalEvent>,
		eventSkus: eventSkus as unknown as WritableTable<EventSku>,
		transaction: fakeTransaction(events, eventSkus),
	};
	const skus = Array.from({ length: 100 }, (_u, i) => `SKU-${i}`);
	await writeEventWithSkus(deps, event({ skus }));
	assert.equal(eventSkus.rows.size, 100);
	assert.deepEqual([...eventSkus.rows.keys()].sort(), skus.map((sku) => `s1:w1:${sku}`).sort());
});

test('writing the same event twice is idempotent — deterministic keys upsert', async () => {
	const events = new FakeTable('eventId');
	const eventSkus = new FakeTable('id');
	// FakeTable's write surface is duck-typed against WritableTable<T> (Record vs.
	// the concrete model shape); cast the same way the other Fake* usages in this
	// suite do rather than widening the production interface for a test fixture.
	const deps = {
		events: events as unknown as WritableTable<OperationalEvent>,
		eventSkus: eventSkus as unknown as WritableTable<EventSku>,
		transaction: fakeTransaction(events, eventSkus),
	};
	await writeEventWithSkus(deps, event());
	await writeEventWithSkus(deps, event());
	assert.equal(events.rows.size, 1);
	assert.equal(eventSkus.rows.size, 2);
	assert.equal('skus' in (await events.get('s1:w1'))!, false);
});
