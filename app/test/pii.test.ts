import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripPii } from '../src/pii.ts';

test('removes every PII container key', () => {
	const payload = {
		id: 1,
		name: '#1001',
		order_number: 1001,
		financial_status: 'paid',
		line_items: [{ sku: 'A', quantity: 1 }],
		customer: { first_name: 'Jane' },
		billing_address: { zip: '00000' },
		shipping_address: { zip: '00000' },
		destination: { zip: '00000' },
		client_details: { browser_ip: '1.2.3.4' },
		email: 'a@b.com',
		contact_email: 'a@b.com',
		phone: '+1-555',
		note: 'secret',
		note_attributes: [{ name: 'x', value: 'y' }],
		customer_locale: 'en',
	};
	const result = stripPii(payload) as Record<string, unknown>;
	for (const key of [
		'customer',
		'billing_address',
		'shipping_address',
		'destination',
		'client_details',
		'email',
		'contact_email',
		'phone',
		'note',
		'note_attributes',
		'customer_locale',
	]) {
		assert.ok(!(key in result), `still has ${key}`);
	}
	// Non-PII evidence is preserved (order name is NOT customer name).
	assert.equal(result.name, '#1001');
	assert.equal(result.order_number, 1001);
	assert.equal(result.financial_status, 'paid');
	assert.deepEqual(result.line_items, [{ sku: 'A', quantity: 1 }]);
});

test('does not mutate the input', () => {
	const payload = { id: 1, email: 'a@b.com', customer: { first_name: 'Jane' } };
	stripPii(payload);
	assert.equal(payload.email, 'a@b.com');
	assert.deepEqual(payload.customer, { first_name: 'Jane' });
});

test('passes through non-objects unchanged', () => {
	assert.equal(stripPii(null), null);
	assert.equal(stripPii(undefined), undefined);
	assert.equal(stripPii('text'), 'text');
	assert.equal(stripPii(42), 42);
	assert.deepEqual(stripPii([1, 2, 3]), [1, 2, 3]);
});

test('removes PII nested inside arrays and objects, keeping evidence', () => {
	const payload = {
		id: 1,
		name: '#1001',
		fulfillments: [
			{
				id: 9,
				status: 'success',
				destination: { address1: '1 Main St', name: 'Jane Doe' },
				line_items: [{ sku: 'A', quantity: 1, title: 'Widget' }],
			},
		],
		refunds: [{ id: 3, transactions: [{ amount: '5.00' }], note: 'gift receipt' }],
	};
	const result = stripPii(payload) as Record<string, unknown>;
	const serialized = JSON.stringify(result);
	for (const marker of ['Main St', 'Jane Doe', 'gift receipt']) {
		assert.ok(!serialized.includes(marker), `nested PII "${marker}" survived`);
	}
	// Nested Level-1 evidence is preserved.
	const fulfillment = (result.fulfillments as Record<string, unknown>[])[0];
	assert.equal(fulfillment.status, 'success');
	assert.ok(!('destination' in fulfillment));
	assert.deepEqual(fulfillment.line_items, [{ sku: 'A', quantity: 1, title: 'Widget' }]);
	assert.equal(result.name, '#1001');
});
