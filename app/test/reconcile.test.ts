import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeEvents } from '../src/reconcile.ts';
import {
	toReconcileOrder,
	numericId,
	fetchOrdersUpdatedSince,
	fetchShopTimezone,
	fetchInventoryItems,
	fetchLocations,
	type ReconcileOrder,
} from '../src/adminApi.ts';
import { rebuildProjection } from '../src/projection.ts';

test('numericId extracts the numeric order id from a gid', () => {
	assert.equal(numericId('gid://shopify/Order/7518851989809'), '7518851989809');
	assert.equal(numericId('123'), '123');
	assert.equal(numericId(null), undefined);
});

test('toReconcileOrder shapes an order node (fulfillable units, fulfilledAt)', () => {
	const order = toReconcileOrder({
		id: 'gid://shopify/Order/900',
		createdAt: '2026-08-01T10:00:00Z',
		updatedAt: '2026-08-02T10:00:00Z',
		displayFinancialStatus: 'PAID',
		displayFulfillmentStatus: 'FULFILLED',
		lineItems: {
			nodes: [
				{ quantity: 2, requiresShipping: true },
				{ quantity: 5, requiresShipping: false },
			],
		},
		fulfillments: [{ status: 'SUCCESS', createdAt: '2026-08-02T09:00:00Z' }],
	});
	assert.equal(order?.orderId, '900');
	assert.equal(order?.fulfillableUnits, 2, 'only shippable units counted');
	assert.equal(order?.financialStatus, 'PAID');
	assert.equal(order?.fulfilledAt, Date.parse('2026-08-02T09:00:00Z'));
});

test('a paid, fulfillment-eligible, fulfilled order synthesizes events that project correctly', () => {
	const order: ReconcileOrder = {
		orderId: '900',
		financialStatus: 'PAID',
		fulfillmentStatus: 'FULFILLED',
		createdAt: Date.parse('2026-08-01T10:00:00Z'),
		updatedAt: Date.parse('2026-08-02T10:00:00Z'),
		fulfillableUnits: 2,
		fulfilledAt: Date.parse('2026-08-02T09:00:00Z'),
	};
	const events = synthesizeEvents('s', order);
	assert.ok(events.every((e) => e.source === 'reconciliation'));
	const p = rebuildProjection(events);
	assert.equal(p?.orderId, '900');
	assert.equal(p?.paidAt, order.createdAt);
	assert.equal(p?.requiresFulfillment, true);
	assert.equal(p?.fulfilledAt, order.fulfilledAt);
});

test('synthesized events are deterministic (idempotent reconciliation)', () => {
	const order: ReconcileOrder = { orderId: '5', financialStatus: 'PAID', fulfillableUnits: 1, createdAt: 100 };
	const a = synthesizeEvents('s', order).map((e) => e.eventId);
	const b = synthesizeEvents('s', order).map((e) => e.eventId);
	assert.deepEqual(a, b);
	assert.deepEqual(a, ['recon:s:5:paid']);
});

test('cancellation and full refund synthesize suppression events', () => {
	const cancelled = synthesizeEvents('s', { orderId: '1', financialStatus: 'PAID', fulfillableUnits: 1, createdAt: 10, cancelledAt: 50 });
	assert.ok(cancelled.some((e) => e.topic === 'orders/cancelled'));
	const refunded = synthesizeEvents('s', { orderId: '2', financialStatus: 'REFUNDED', fulfillableUnits: 1, createdAt: 10, updatedAt: 60 });
	const p = rebuildProjection(refunded);
	assert.equal(p?.fullyRefundedAt, 60);
});

test('an unpaid order produces no paid event', () => {
	const events = synthesizeEvents('s', { orderId: '3', financialStatus: 'PENDING', fulfillableUnits: 1, createdAt: 10 });
	assert.ok(!events.some((e) => e.topic === 'orders/paid'));
});

test('fetchOrdersUpdatedSince parses pages and stops when hasNextPage is false', async () => {
	const fakeFetch = (async () =>
		new Response(
			JSON.stringify({
				data: {
					orders: {
						edges: [
							{
								cursor: 'c1',
								node: {
									id: 'gid://shopify/Order/1',
									displayFinancialStatus: 'PAID',
									updatedAt: '2026-08-02T00:00:00Z',
									lineItems: { nodes: [{ quantity: 1, requiresShipping: true }] },
									fulfillments: [],
								},
							},
						],
						pageInfo: { hasNextPage: false },
					},
				},
			}),
			{ status: 200 },
		)) as unknown as typeof fetch;
	const { orders, nextCursor } = await fetchOrdersUpdatedSince('s.myshopify.com', 'tok', 0, undefined, fakeFetch);
	assert.equal(orders.length, 1);
	assert.equal(orders[0].orderId, '1');
	assert.equal(nextCursor, undefined);
});

test('adminGraphql surfaces GraphQL errors', async () => {
	const fakeFetch = (async () =>
		new Response(JSON.stringify({ errors: [{ message: 'Throttled' }] }), { status: 200 })) as unknown as typeof fetch;
	await assert.rejects(() => fetchOrdersUpdatedSince('s', 'tok', 0, undefined, fakeFetch), /Throttled/);
});

test('fetchShopTimezone reads the store zone', async () => {
	const fakeFetch = (async () =>
		new Response(JSON.stringify({ data: { shop: { ianaTimezone: 'America/New_York' } } }), { status: 200 })) as unknown as typeof fetch;
	assert.equal(await fetchShopTimezone('s.myshopify.com', 'tok', fakeFetch), 'America/New_York');
});

test('fetchShopTimezone returns undefined for a missing or blank zone rather than a bad value', async () => {
	// The UI falls back to the viewer's zone on undefined; an empty string would
	// make Intl throw, so it must never be passed through as if it were a zone.
	for (const shop of [{}, { ianaTimezone: '' }, { ianaTimezone: 42 }]) {
		const fakeFetch = (async () => new Response(JSON.stringify({ data: { shop } }), { status: 200 })) as unknown as typeof fetch;
		assert.equal(await fetchShopTimezone('s', 'tok', fakeFetch), undefined);
	}
});

test('fetchInventoryItems maps GraphQL nodes to inventory item facts', async () => {
	const body = {
		data: {
			nodes: [
				{ id: 'gid://shopify/InventoryItem/111', sku: 'TSHIRT', variant: { title: 'M / Black', product: { title: 'T-Shirt' } } },
				null,
			],
		},
	};
	const fetchImpl = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
	const facts = await fetchInventoryItems('s.myshopify.com', 't', ['111', '222'], fetchImpl);
	assert.deepEqual(facts, [{ inventoryItemId: '111', sku: 'TSHIRT', productTitle: 'T-Shirt', variantTitle: 'M / Black' }]);
});

test('fetchLocations maps GraphQL nodes to location facts', async () => {
	const body = { data: { locations: { nodes: [{ id: 'gid://shopify/Location/987', name: 'Brooklyn' }] } } };
	const fetchImpl = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
	assert.deepEqual(await fetchLocations('s.myshopify.com', 't', fetchImpl), [{ locationId: '987', name: 'Brooklyn' }]);
});
