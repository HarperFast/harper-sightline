import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { storedBody, INCLUDE_FIELDS } from '../src/privacy/pii.ts';
import { normalizeDelivery } from '../src/ingest/normalize.ts';

const meta = (topic: string) => ({ shopId: 's.myshopify.com', topic, webhookId: 'w1', receivedAt: 1_700_000_000_000 });

const order = {
	id: 1,
	admin_graphql_api_id: 'gid://shopify/Order/1',
	name: '#1001',
	order_number: 1001,
	created_at: '2026-10-01T00:00:00Z',
	updated_at: '2026-10-01T01:00:00Z',
	financial_status: 'paid',
	fulfillment_status: null,
	currency: 'USD',
	total_price: '20.00',
	current_total_price: '18.00',
	line_items: [
		{
			sku: 'A',
			quantity: 2,
			fulfillable_quantity: 2,
			requires_shipping: true,
			title: 'Engraved mug',
			price: '9.00',
			properties: [{ name: 'Engraving', value: 'For Jane Doe' }],
		},
	],
	// Customer-linked fields a drifted subscription could send.
	browser_ip: '203.0.113.7',
	customer_id: 42,
	landing_site: '/?ref=jane',
	order_status_url: 'https://shop.example/orders/abc/authenticate?key=secret',
	customer: { first_name: 'Jane' },
	email: 'jane@example.com',
	note: 'gift for Jane',
	shipping_address: { address1: '1 Main St' },
	some_field_shopify_adds_next_year: 'unknown',
};

test('an order body keeps only its include_fields and the line-item fields the normalizer reads', () => {
	const kept = storedBody('orders/paid', order) as Record<string, unknown>;
	assert.deepEqual(Object.keys(kept).sort(), [...INCLUDE_FIELDS['orders/paid']].filter((key) => key in order).sort());
	assert.deepEqual(kept.line_items, [{ sku: 'A', quantity: 2, fulfillable_quantity: 2, requires_shipping: true }]);
	const text = JSON.stringify(kept);
	for (const marker of ['Jane', '203.0.113.7', 'ref=', 'key=secret', '1 Main St', 'unknown', '"customer_id"']) {
		assert.ok(!text.includes(marker), `${marker} survived`);
	}
});

test('a field Shopify adds later is not stored', () => {
	assert.deepEqual(storedBody('inventory_levels/update', { inventory_item_id: 5, location_id: 6, available: 1, brand_new: 'x' }), {
		inventory_item_id: 5,
		location_id: 6,
		available: 1,
	});
});

test('a field that should be a scalar but arrives as an object is not stored', () => {
	assert.deepEqual(storedBody('fulfillments/create', { id: 9, order_id: 1, status: { nested: 'x' }, tracking_numbers: ['1Z', '2Z'] }), {
		id: 9,
		order_id: 1,
		tracking_numbers: ['1Z', '2Z'],
	});
});

test('a refund keeps its line quantities and the nested SKU, and no transaction detail', () => {
	const kept = storedBody('refunds/create', {
		id: 3,
		order_id: 1,
		processed_at: '2026-10-02T00:00:00Z',
		note: 'Jane changed her mind',
		refund_line_items: [{ quantity: 1, line_item: { sku: 'A', title: 'Mug', properties: [{ name: 'n', value: 'Jane' }] } }],
		transactions: [{ amount: '5.00', gateway: 'card', receipt: { card: '4242' } }],
	});
	assert.deepEqual(kept, {
		id: 3,
		order_id: 1,
		processed_at: '2026-10-02T00:00:00Z',
		refund_line_items: [{ quantity: 1, line_item: { sku: 'A' } }],
		transactions: [{}],
	});
});

test('a topic with no include_fields stores nothing, and a non-object body is stored as null', () => {
	assert.deepEqual(storedBody('app/uninstalled', { id: 1, myshopify_domain: 's.myshopify.com', email: 'owner@example.com' }), {});
	assert.equal(storedBody('orders/paid', 'text'), null);
	assert.equal(storedBody('orders/paid', [order]), null);
	assert.equal(storedBody('orders/paid', null), null);
});

test('does not mutate the input', () => {
	const body = structuredClone(order);
	storedBody('orders/paid', body);
	assert.deepEqual(body, order);
});

test('each call returns fresh objects, so changing one stored body cannot leak into the next', () => {
	const first = storedBody('orders/paid', order) as Record<string, unknown>;
	(first.line_items as Array<Record<string, unknown>>)[0].sku = 'CHANGED';
	first.injected = true;
	const second = storedBody('orders/paid', order) as Record<string, unknown>;
	assert.equal((second.line_items as Array<Record<string, unknown>>)[0].sku, 'A');
	assert.ok(!('injected' in second));
	assert.deepEqual(storedBody('orders/create', { id: 1, sku: 'x' }), { id: 1 });
});

test('the normalizer reads the same event from the stored body as from the full one', () => {
	const bodies: Record<string, unknown> = {
		'orders/paid': order,
		'fulfillments/create': {
			id: 9,
			order_id: 1,
			status: 'success',
			location_id: 6,
			tracking_company: 'UPS',
			tracking_numbers: ['1Z'],
			line_items: order.line_items,
			destination: { zip: '0' },
		},
		'refunds/create': {
			id: 3,
			order_id: 1,
			processed_at: '2026-10-02T00:00:00Z',
			refund_line_items: [{ quantity: 1, line_item: { sku: 'A' } }],
		},
		'inventory_levels/update': { inventory_item_id: 5, location_id: 6, available: 1, updated_at: '2026-10-02T00:00:00Z' },
	};
	for (const [topic, body] of Object.entries(bodies)) {
		assert.deepEqual(normalizeDelivery(meta(topic), storedBody(topic, body)), normalizeDelivery(meta(topic), body), topic);
	}
});

// The allowlist must not drift from what the app subscribes to.
test('INCLUDE_FIELDS matches the include_fields registered in shopify.app.toml', () => {
	const toml = readFileSync(new URL('../../shopify.app.toml', import.meta.url), 'utf8');
	const registered: Record<string, string[]> = {};
	for (const block of toml.split('[[webhooks.subscriptions]]').slice(1)) {
		const list = (name: string) =>
			[...(block.match(new RegExp(`${name} = \\[([^\\]]*)\\]`))?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
		for (const topic of list('topics')) registered[topic] = list('include_fields');
	}
	assert.deepEqual(Object.fromEntries(Object.entries(INCLUDE_FIELDS).map(([topic, fields]) => [topic, [...fields]])), registered);
});
