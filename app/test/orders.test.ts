import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGE_BUCKETS, ageBucketKey, ageHours, deriveOrderLane, isAwaitingConfirmation } from '../src/orders.ts';
import type { OrderProjection } from '../src/model.ts';

const NOW = 1_775_000_000_000;
const HOUR = 3_600_000;

function p(over: Partial<OrderProjection> = {}): OrderProjection {
	return { id: 's1:o1', shopId: 's1', orderId: 'o1', ...over };
}

test('an unpaid order is unpaid whatever else is true', () => {
	assert.equal(deriveOrderLane(p({ requiresFulfillment: true })), 'unpaid');
});

test('a paid, fulfillment-eligible, unfulfilled order is awaiting', () => {
	assert.equal(deriveOrderLane(p({ paidAt: NOW, requiresFulfillment: true })), 'awaiting');
	assert.equal(isAwaitingConfirmation(p({ paidAt: NOW, requiresFulfillment: true })), true);
});

test('a digital order needs no fulfillment, so it is never awaiting', () => {
	assert.equal(deriveOrderLane(p({ paidAt: NOW, requiresFulfillment: false })), 'fulfilled');
	assert.equal(isAwaitingConfirmation(p({ paidAt: NOW, requiresFulfillment: false })), false);
});

test('fulfilled beats awaiting; cancelled and refunded beat fulfilled', () => {
	assert.equal(deriveOrderLane(p({ paidAt: NOW, requiresFulfillment: true, fulfilledAt: NOW })), 'fulfilled');
	assert.equal(deriveOrderLane(p({ paidAt: NOW, requiresFulfillment: true, fulfilledAt: NOW, cancelledAt: NOW })), 'cancelled');
	assert.equal(deriveOrderLane(p({ paidAt: NOW, requiresFulfillment: true, fullyRefundedAt: NOW })), 'refunded');
});

test('a failed fulfillment attempt does not change the lane — the order is still awaiting', () => {
	// The lane answers "where is this order", the finding answers "what went wrong".
	// Conflating them would hide a failed attempt inside a separate lane and drop it
	// out of the awaiting worklist, which is exactly where it needs to be seen.
	assert.equal(deriveOrderLane(p({ paidAt: NOW, requiresFulfillment: true, fulfillmentFailedAt: NOW })), 'awaiting');
});

test('age in hours is measured from payment and floors', () => {
	assert.equal(ageHours(NOW - 90 * 60_000, NOW), 1);
	assert.equal(ageHours(undefined, NOW), undefined);
});

test('age buckets partition the timeline with no gap and no overlap', () => {
	assert.equal(ageBucketKey(NOW - 1 * HOUR, NOW), 'under24');
	assert.equal(ageBucketKey(NOW - 30 * HOUR, NOW), 'h24to48');
	assert.equal(ageBucketKey(NOW - 60 * HOUR, NOW), 'h48to72');
	assert.equal(ageBucketKey(NOW - 100 * HOUR, NOW), 'over72');
	assert.equal(ageBucketKey(undefined, NOW), undefined);
	// Boundaries land in exactly one bucket.
	assert.equal(ageBucketKey(NOW - 24 * HOUR, NOW), 'h24to48');
	assert.equal(ageBucketKey(NOW - 72 * HOUR, NOW), 'over72');
	assert.equal(AGE_BUCKETS.length, 4);
});
