import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactShop, redactOrders, type RedactTarget } from '../src/redaction.ts';
import { FakeTable } from './fakeTable.ts';

function buildTargets() {
	const deliveries = new FakeTable('id', [
		{ id: 's1:w1', shopId: 's1', receivedAt: 1 },
		{ id: 's2:w1', shopId: 's2', receivedAt: 1 },
	]);
	const events = new FakeTable('eventId', [
		{ eventId: 's1:e1', shopId: 's1', resourceId: 'o1' },
		{ eventId: 's1:e2', shopId: 's1', resourceId: 'o2' },
		{ eventId: 's2:e1', shopId: 's2', resourceId: 'o1' },
	]);
	const projections = new FakeTable('id', [
		{ id: 's1:o1', shopId: 's1', orderId: 'o1' },
		{ id: 's1:o2', shopId: 's1', orderId: 'o2' },
		{ id: 's2:o1', shopId: 's2', orderId: 'o1' },
	]);
	const targets: RedactTarget[] = [
		{ name: 'WebhookDelivery', keyField: 'id', shopField: 'shopId', table: deliveries },
		{ name: 'OperationalEvent', keyField: 'eventId', shopField: 'shopId', orderField: 'resourceId', table: events },
		{ name: 'OrderProjection', keyField: 'id', shopField: 'shopId', orderField: 'orderId', table: projections },
	];
	return { targets, deliveries, events, projections };
}

test('redactShop erases all of a shop, leaves other tenants intact', async () => {
	const { targets, deliveries, events, projections } = buildTargets();
	const result = await redactShop(targets, 's1');

	assert.equal(result.deleted, 1 + 2 + 2); // deliveries + events + projections for s1
	assert.deepEqual(result.failures, []);
	// s1 gone everywhere, s2 untouched.
	assert.deepEqual([...deliveries.rows.keys()], ['s2:w1']);
	assert.deepEqual([...events.rows.keys()], ['s2:e1']);
	assert.deepEqual([...projections.rows.keys()], ['s2:o1']);
});

test('redactShop is idempotent', async () => {
	const { targets } = buildTargets();
	await redactShop(targets, 's1');
	const second = await redactShop(targets, 's1');
	assert.equal(second.deleted, 0);
	assert.deepEqual(second.failures, []);
});

test('redactOrders removes only order-linked rows for the shop', async () => {
	const { targets, deliveries, events, projections } = buildTargets();
	const result = await redactOrders(targets, 's1', ['o1']);

	assert.deepEqual(result.failures, []);
	assert.equal(result.deleted, 2); // s1:e1 (event, o1) + s1:o1 (projection, o1)
	// s1's o1 rows gone; s1's o2 kept; s2's o1 kept.
	assert.deepEqual([...events.rows.keys()].sort(), ['s1:e2', 's2:e1']);
	assert.deepEqual([...projections.rows.keys()].sort(), ['s1:o2', 's2:o1']);
	// Non-order-linked table (deliveries) is untouched by customer redaction.
	assert.equal(deliveries.rows.size, 2);
});

test('redactOrders is idempotent and handles multiple orders', async () => {
	const { targets, events, projections } = buildTargets();
	const first = await redactOrders(targets, 's1', ['o1', 'o2']);
	assert.equal(first.deleted, 4); // s1 e1,e2 + s1 o1,o2
	assert.deepEqual([...events.rows.keys()], ['s2:e1']);
	assert.deepEqual([...projections.rows.keys()], ['s2:o1']);
	const second = await redactOrders(targets, 's1', ['o1', 'o2']);
	assert.equal(second.deleted, 0);
});
