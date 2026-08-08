import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTable } from './fakeTable.ts';
import { eventSkuRows, stripSkus, writeEventWithSkus } from '../src/eventSkus.ts';
import type { NormalizedEvent } from '../src/normalize.ts';

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

test('stripSkus removes the transport-only field so it is never stored', () => {
	const stored = stripSkus(event());
	assert.equal('skus' in stored, false);
	assert.equal(stored.eventId, 's1:w1');
});

test('writing the same event twice is idempotent — deterministic keys upsert', async () => {
	const events = new FakeTable('eventId');
	const eventSkus = new FakeTable('id');
	await writeEventWithSkus({ events, eventSkus }, event());
	await writeEventWithSkus({ events, eventSkus }, event());
	assert.equal(events.rows.size, 1);
	assert.equal(eventSkus.rows.size, 2);
	assert.equal('skus' in (await events.get('s1:w1'))!, false);
});
