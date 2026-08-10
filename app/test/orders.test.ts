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

test('a digital order is never awaiting, and is never claimed as fulfilled', () => {
	// `requiresFulfillment` is UNDEFINED here, not false: the reducer only ever
	// latches it true (from a positive fulfillableItemCount), so `false` is an input
	// no code path produces and testing it proved nothing about the case that
	// actually occurs. A digital order has zero fulfillable units, so the latch never
	// fires — and with no observed fulfillment either, calling it 'fulfilled' would
	// assert something Sightline never saw.
	const digital = p({ paidAt: NOW });
	assert.equal(isAwaitingConfirmation(digital), false, 'no confirmation is expected');
	assert.equal(deriveOrderLane(digital), 'no_fulfillment_expected');
	// An order Sightline has only ever seen a payment for — no line items observed —
	// is indistinguishable from a digital one, and gets the same honest answer.
	assert.equal(deriveOrderLane(p({ paidAt: NOW, requiresFulfillment: undefined })), 'no_fulfillment_expected');
});

test('an observed fulfillment is what makes an order fulfilled, whatever the eligibility latch says', () => {
	// The lane says a fulfillment WAS observed, so it must not depend on whether the
	// order-eligibility latch also arrived.
	assert.equal(deriveOrderLane(p({ paidAt: NOW, fulfilledAt: NOW })), 'fulfilled');
	assert.equal(deriveOrderLane(p({ paidAt: NOW, requiresFulfillment: true, fulfilledAt: NOW })), 'fulfilled');
});

test('fulfilled beats awaiting; cancelled and refunded beat fulfilled', () => {
	assert.equal(deriveOrderLane(p({ paidAt: NOW, requiresFulfillment: true, fulfilledAt: NOW })), 'fulfilled');
	assert.equal(deriveOrderLane(p({ paidAt: NOW, requiresFulfillment: true, fulfilledAt: NOW, cancelledAt: NOW })), 'cancelled');
	assert.equal(deriveOrderLane(p({ paidAt: NOW, requiresFulfillment: true, fullyRefundedAt: NOW })), 'refunded');
	// Finality still wins over the digital case.
	assert.equal(deriveOrderLane(p({ paidAt: NOW, cancelledAt: NOW })), 'cancelled');
	assert.equal(deriveOrderLane(p({ paidAt: NOW, fullyRefundedAt: NOW })), 'refunded');
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
