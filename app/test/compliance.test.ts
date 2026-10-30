import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleCompliance, type ComplianceDeps } from '../src/privacy/compliance.ts';

function spyDeps() {
	const calls: Array<{ fn: string; args: unknown[] }> = [];
	const deps: ComplianceDeps = {
		async redactShop(shopId) {
			calls.push({ fn: 'redactShop', args: [shopId] });
			return { deleted: 3, failures: [] };
		},
		async redactOrders(shopId, orderIds) {
			calls.push({ fn: 'redactOrders', args: [shopId, orderIds] });
			return { deleted: orderIds.length, failures: [] };
		},
		async tombstoneOrders(shopId, orderIds) {
			calls.push({ fn: 'tombstoneOrders', args: [shopId, orderIds] });
		},
		async tombstoneShop(shopId) {
			calls.push({ fn: 'tombstoneShop', args: [shopId] });
		},
		async scrubDeliveries(shopId, orderIds) {
			calls.push({ fn: 'scrubDeliveries', args: [shopId, orderIds] });
			return { scrubbed: orderIds.length, capped: false };
		},
		async audit(action, shopId, detail) {
			calls.push({ fn: 'audit', args: [action, shopId, detail] });
		},
	};
	return { deps, calls };
}

test('shop/redact erases the tenant, tombstones it on both sides of the erase, and audits', async () => {
	const { deps, calls } = spyDeps();
	const r = await handleCompliance('shop/redact', 's1', { shop_domain: 's1' }, deps);
	assert.equal(r.action, 'shop_redact');
	assert.equal(r.deleted, 3);
	// The erase deletes the shop's tombstones, so the second write is the one that lasts.
	assert.deepEqual(
		calls.map((c) => c.fn),
		['tombstoneShop', 'redactShop', 'tombstoneShop', 'audit'],
	);
	assert.deepEqual(calls[1].args, ['s1']);
});

test('customers/redact deletes order-linked rows from orders_to_redact', async () => {
	const { deps, calls } = spyDeps();
	const r = await handleCompliance('customers/redact', 's1', { orders_to_redact: [111, '222'] }, deps);
	assert.equal(r.action, 'customer_redact');
	assert.equal(r.deleted, 2);
	assert.equal(r.scrubbed, 2);
	// Tombstone before anything is deleted; scrub while the events that find deliveries remain.
	assert.deepEqual(calls.slice(0, 3), [
		{ fn: 'tombstoneOrders', args: ['s1', ['111', '222']] },
		{ fn: 'scrubDeliveries', args: ['s1', ['111', '222']] },
		{ fn: 'redactOrders', args: ['s1', ['111', '222']] },
	]);
	assert.equal(calls[3].fn, 'audit');
	assert.equal((calls[3].args[2] as Record<string, unknown>).scrubbed, 2);
});

test('customers/redact with no orders is a safe no-op delete', async () => {
	const { deps, calls } = spyDeps();
	const r = await handleCompliance('customers/redact', 's1', {}, deps);
	assert.equal(r.deleted, 0);
	assert.deepEqual(calls[2], { fn: 'redactOrders', args: ['s1', []] });
	assert.ok(!calls.some((c) => c.fn === 'tombstoneShop'), 'no orders never tombstones the whole shop');
});

test('customers/data_request performs NO deletion (no PII to export)', async () => {
	const { deps, calls } = spyDeps();
	const r = await handleCompliance('customers/data_request', 's1', { orders_requested: [7] }, deps);
	assert.equal(r.action, 'customer_data_request');
	assert.deepEqual(
		calls.map((c) => c.fn),
		['audit'],
		'no mutation',
	);
	assert.equal(calls[0].fn, 'audit');
	assert.deepEqual((calls[0].args[2] as Record<string, unknown>).orders, ['7']);
});

test('an unrelated topic is ignored with no side effects', async () => {
	const { deps, calls } = spyDeps();
	const r = await handleCompliance('orders/paid', 's1', {}, deps);
	assert.equal(r.action, 'ignored');
	assert.equal(calls.length, 0);
});
