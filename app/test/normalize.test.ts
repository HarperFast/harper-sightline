import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripPii } from '../src/pii.ts';
import { normalizeDelivery, isOperationalTopic, PermanentNormalizeError, MAX_EVENT_SKUS, type DeliveryMeta } from '../src/normalize.ts';

// The single API version we pin (shopify-contract §1). Fixtures live under this
// directory; add a sibling directory to cover a future version.
const API_VERSION = '2026-07';
const RECEIVED_AT = 1_700_000_000_000;

function fixture(name: string): unknown {
	return JSON.parse(readFileSync(new URL(`./fixtures/${API_VERSION}/${name}.json`, import.meta.url), 'utf8'));
}

function meta(topic: string): DeliveryMeta {
	return { shopId: 'shop.myshopify.com', topic, webhookId: 'wh-123', receivedAt: RECEIVED_AT };
}

// Strings that appear only in the PII containers of the fixtures — none may
// survive into a normalized event or the stored (stripped) payload.
const PII_MARKERS = [
	'example.com',
	'Jane',
	'Doe',
	'John',
	'Roe',
	'Sam',
	'Poe',
	'Main St',
	'Oak Ave',
	'Pine Rd',
	'555-0100',
	'gift wrap',
	'changed mind',
];

interface Case {
	file: string;
	topic: string;
	domain: string;
	resourceId: string;
	state?: string;
	quantity?: number;
	occurredAtField?: string; // fixture field the source timestamp should come from
}

const CASES: Case[] = [
	{
		file: 'orders_create',
		topic: 'orders/create',
		domain: 'order',
		resourceId: '5100000000002',
		state: 'pending',
		occurredAtField: 'updated_at',
	},
	{ file: 'orders_paid', topic: 'orders/paid', domain: 'order', resourceId: '5100000000001', state: 'paid', occurredAtField: 'updated_at' },
	{
		file: 'orders_updated',
		topic: 'orders/updated',
		domain: 'order',
		resourceId: '5100000000001',
		state: 'paid',
		occurredAtField: 'updated_at',
	},
	{
		file: 'orders_cancelled',
		topic: 'orders/cancelled',
		domain: 'order',
		resourceId: '5100000000003',
		state: 'refunded',
		occurredAtField: 'updated_at',
	},
	{
		file: 'fulfillments_create',
		topic: 'fulfillments/create',
		domain: 'fulfillment',
		resourceId: '5100000000001',
		state: 'success',
		occurredAtField: 'updated_at',
	},
	{
		file: 'fulfillments_update',
		topic: 'fulfillments/update',
		domain: 'fulfillment',
		resourceId: '5100000000001',
		state: 'success',
		occurredAtField: 'updated_at',
	},
	{
		file: 'inventory_levels_update',
		topic: 'inventory_levels/update',
		domain: 'inventory',
		resourceId: '7300000000001',
		quantity: 42,
		occurredAtField: 'updated_at',
	},
	{
		file: 'refunds_create',
		topic: 'refunds/create',
		domain: 'refund',
		resourceId: '5100000000003',
		state: 'refunded',
		quantity: 1,
		occurredAtField: 'processed_at',
	},
];

for (const c of CASES) {
	test(`normalizes ${c.topic} into a single approved-field event`, () => {
		const raw = fixture(c.file) as Record<string, unknown>;
		const stripped = stripPii(raw);
		const events = normalizeDelivery(meta(c.topic), stripped);

		assert.equal(events.length, 1, 'one event per operational delivery');
		const ev = events[0];
		assert.equal(ev.eventId, 'shop.myshopify.com:wh-123');
		assert.equal(ev.shopId, 'shop.myshopify.com');
		assert.equal(ev.topic, c.topic);
		assert.equal(ev.domain, c.domain);
		assert.equal(ev.resourceId, c.resourceId);
		assert.equal(ev.source, 'webhook');
		assert.equal(ev.receivedAt, RECEIVED_AT);
		if (c.state !== undefined) assert.equal(ev.state, c.state);
		if (c.quantity !== undefined) assert.equal(ev.quantity, c.quantity);

		// occurredAt preserves the source timestamp from the payload.
		const expectedTs = Date.parse(raw[c.occurredAtField!] as string);
		assert.equal(ev.occurredAt, expectedTs);

		// No PII survives into the event.
		const serialized = JSON.stringify(ev);
		for (const marker of PII_MARKERS) {
			assert.ok(!serialized.includes(marker), `event leaked PII marker "${marker}"`);
		}
	});
}

test('order events carry fulfillment eligibility from line_items (#12)', () => {
	// orders_paid: two shippable lines, fulfillable_quantity 2 + 1.
	const paid = normalizeDelivery(meta('orders/paid'), stripPii(fixture('orders_paid')))[0];
	assert.equal(paid.fulfillableItemCount, 3);
	// A digital order (no line requires shipping) yields 0, not undefined.
	const digital = normalizeDelivery(meta('orders/paid'), {
		id: 42,
		financial_status: 'paid',
		updated_at: '2026-08-04T14:05:00Z',
		line_items: [{ sku: 'EBOOK', quantity: 1, requires_shipping: false }],
	})[0];
	assert.equal(digital.fulfillableItemCount, 0);
	// Non-order events do not carry the field.
	const inv = normalizeDelivery(meta('inventory_levels/update'), { inventory_item_id: 5, available: 3 })[0];
	assert.equal(inv.fulfillableItemCount, undefined);
});

test('additive unknown payload fields do not break normalization or leak', () => {
	const raw = fixture('orders_paid') as Record<string, unknown>;
	assert.ok('__future_additive_field__' in raw, 'fixture carries an additive field');
	const events = normalizeDelivery(meta('orders/paid'), stripPii(raw));
	assert.equal(events.length, 1);
	assert.ok(!('__future_additive_field__' in events[0]));
});

test('stored (stripped) payload retains no PII containers', () => {
	const stripped = stripPii(fixture('orders_paid')) as Record<string, unknown>;
	for (const key of ['customer', 'email', 'phone', 'billing_address', 'shipping_address', 'note', 'contact_email', 'customer_locale']) {
		assert.ok(!(key in stripped), `stripped payload still has "${key}"`);
	}
	// Level-1 evidence is kept.
	assert.equal(stripped.name, '#1001');
	assert.equal(stripped.financial_status, 'paid');
	assert.ok(Array.isArray(stripped.line_items));
});

test('non-operational topics are accepted but produce no event', () => {
	assert.equal(isOperationalTopic('app/uninstalled'), false);
	assert.deepEqual(normalizeDelivery(meta('app/uninstalled'), { shop_id: 1 }), []);
	assert.deepEqual(normalizeDelivery(meta('customers/redact'), { customer: { id: 1 } }), []);
});

test('a broken operational payload throws a permanent error', () => {
	for (const payload of [{}, null, [], 'not-json']) {
		assert.throws(
			() => normalizeDelivery(meta('orders/paid'), payload),
			(err: unknown) => err instanceof PermanentNormalizeError && err.permanent === true,
		);
	}
});

test('missing source timestamp falls back to receivedAt', () => {
	const events = normalizeDelivery(meta('inventory_levels/update'), { inventory_item_id: 5, available: 3 });
	assert.equal(events[0].occurredAt, RECEIVED_AT);
	assert.equal(events[0].resourceId, '5');
	assert.equal(events[0].quantity, 3);
});

test('numeric-string ids normalize to strings', () => {
	const events = normalizeDelivery(meta('orders/paid'), {
		id: 5100000000009,
		financial_status: 'paid',
		updated_at: '2026-08-04T14:05:00Z',
	});
	assert.equal(events[0].resourceId, '5100000000009');
	assert.equal(typeof events[0].resourceId, 'string');
});

test('order events carry the merchant-facing name, value, and currency', () => {
	const [event] = normalizeDelivery(meta('orders/paid'), fixture('orders_paid'));
	assert.equal(event.orderName, '#1001');
	assert.equal(event.totalPrice, 129.95);
	assert.equal(event.currency, 'USD');
});

test('order name falls back to order_number when name is absent', () => {
	const payload = { ...(fixture('orders_paid') as Record<string, unknown>), name: undefined, order_number: 1042 };
	const [event] = normalizeDelivery(meta('orders/paid'), payload);
	assert.equal(event.orderName, '#1042');
});

test('order events carry every distinct line-item SKU, capped', () => {
	const [event] = normalizeDelivery(meta('orders/paid'), fixture('orders_paid'));
	// orders_paid.json line items: TSHIRT-BLK-M (id 111), STICKER-PK (id 112).
	assert.deepEqual(event.skus, ['TSHIRT-BLK-M', 'STICKER-PK']);

	const many = {
		...(fixture('orders_paid') as Record<string, unknown>),
		line_items: Array.from({ length: 30 }, (_u, i) => ({ sku: `SKU-${i}`, quantity: 1 })),
	};
	const [big] = normalizeDelivery(meta('orders/paid'), many);
	assert.equal(big.skus?.length, MAX_EVENT_SKUS);
});

test('duplicate SKUs across line items collapse to one entry', () => {
	const payload = {
		...(fixture('orders_paid') as Record<string, unknown>),
		line_items: [
			{ sku: 'A', quantity: 1 },
			{ sku: 'A', quantity: 2 },
		],
	};
	const [event] = normalizeDelivery(meta('orders/paid'), payload);
	assert.deepEqual(event.skus, ['A']);
});

test('fulfillment events carry location, tracking presence, carrier, and shipment status', () => {
	const [event] = normalizeDelivery(meta('fulfillments/create'), fixture('fulfillments_create'));
	assert.equal(event.locationId, '987654321');
	assert.equal(event.hasTracking, true);
	assert.equal(event.trackingCompany, 'UPS');
	assert.equal(event.shipmentStatus, 'in_transit');
});

test('a fulfillment with no tracking numbers reports hasTracking false, not undefined', () => {
	const payload = { ...(fixture('fulfillments_create') as Record<string, unknown>), tracking_numbers: [], tracking_company: undefined };
	const [event] = normalizeDelivery(meta('fulfillments/create'), payload);
	assert.equal(event.hasTracking, false);
	assert.equal(event.trackingCompany, undefined);
});

test('inventory events carry their location', () => {
	const [event] = normalizeDelivery(meta('inventory_levels/update'), fixture('inventory_levels_update'));
	// inventory_levels_update.json: location_id 8400000000001 (not 987654321 —
	// that id belongs to fulfillments_create.json's location).
	assert.equal(event.locationId, '8400000000001');
});

test('refund events carry the refunded line items SKUs', () => {
	const [event] = normalizeDelivery(meta('refunds/create'), fixture('refunds_create'));
	// refunds_create.json refunds the nested line_item with sku HAT-01, matching
	// orders_cancelled.json's line item.
	assert.deepEqual(event.skus, ['HAT-01']);
});

test('no normalizer ever emits a customer-identifying field', () => {
	const hostile = { ...(fixture('orders_paid') as Record<string, unknown>), email: 'a@b.com', customer: { first_name: 'X' }, phone: '+1' };
	const [event] = normalizeDelivery(meta('orders/paid'), hostile);
	for (const key of ['email', 'customer', 'phone', 'billing_address', 'shipping_address']) {
		assert.equal(key in event, false, `${key} must never reach a normalized event`);
	}
});
