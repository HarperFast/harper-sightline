import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleCompliance, type ComplianceDeps } from '../src/compliance.ts';

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
		async audit(action, shopId, detail) {
			calls.push({ fn: 'audit', args: [action, shopId, detail] });
		},
	};
	return { deps, calls };
}

test('shop/redact erases the tenant and audits', async () => {
	const { deps, calls } = spyDeps();
	const r = await handleCompliance('shop/redact', 's1', { shop_domain: 's1' }, deps);
	assert.equal(r.action, 'shop_redact');
	assert.equal(r.deleted, 3);
	assert.deepEqual(
		calls.map((c) => c.fn),
		['redactShop', 'audit'],
	);
	assert.deepEqual(calls[0].args, ['s1']);
});

test('customers/redact deletes order-linked rows from orders_to_redact', async () => {
	const { deps, calls } = spyDeps();
	const r = await handleCompliance('customers/redact', 's1', { orders_to_redact: [111, '222'] }, deps);
	assert.equal(r.action, 'customer_redact');
	assert.equal(r.deleted, 2);
	assert.deepEqual(calls[0], { fn: 'redactOrders', args: ['s1', ['111', '222']] });
	assert.equal(calls[1].fn, 'audit');
});

test('customers/redact with no orders is a safe no-op delete', async () => {
	const { deps, calls } = spyDeps();
	const r = await handleCompliance('customers/redact', 's1', {}, deps);
	assert.equal(r.deleted, 0);
	assert.deepEqual(calls[0], { fn: 'redactOrders', args: ['s1', []] });
});

test('customers/data_request performs NO deletion (no PII to export)', async () => {
	const { deps, calls } = spyDeps();
	const r = await handleCompliance('customers/data_request', 's1', { orders_requested: [7] }, deps);
	assert.equal(r.action, 'customer_data_request');
	assert.ok(!calls.some((c) => c.fn === 'redactShop' || c.fn === 'redactOrders'), 'no mutation');
	assert.equal(calls[0].fn, 'audit');
	assert.deepEqual((calls[0].args[2] as Record<string, unknown>).orders, ['7']);
});

test('an unrelated topic is ignored with no side effects', async () => {
	const { deps, calls } = spyDeps();
	const r = await handleCompliance('orders/paid', 's1', {}, deps);
	assert.equal(r.action, 'ignored');
	assert.equal(calls.length, 0);
});
