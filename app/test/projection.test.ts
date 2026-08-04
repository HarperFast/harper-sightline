import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, rebuildProjection, isOrderLinked } from '../src/projection.ts';
import type { EventDomain, OperationalEvent } from '../src/model.ts';

let seq = 0;
function ev(domain: EventDomain, occurredAt: number, extra: Partial<OperationalEvent> = {}): OperationalEvent {
	seq += 1;
	return {
		eventId: `s:wh${seq}`,
		shopId: 's',
		domain,
		resourceId: 'o1',
		source: 'webhook',
		occurredAt,
		receivedAt: occurredAt,
		...extra,
	};
}

const paid = (t: number, units = 2) => ev('order', t, { topic: 'orders/paid', state: 'paid', fulfillableItemCount: units });
const created = (t: number, units = 2) => ev('order', t, { topic: 'orders/create', state: 'pending', fulfillableItemCount: units });
const cancelled = (t: number) => ev('order', t, { topic: 'orders/cancelled', state: 'cancelled' });
const refunded = (t: number) => ev('order', t, { topic: 'orders/updated', state: 'refunded' });
const fulfilled = (t: number) => ev('fulfillment', t, { topic: 'fulfillments/create', state: 'success' });

function fold(events: OperationalEvent[]) {
	let p;
	for (const e of events) p = applyEvent(p, e);
	return p;
}

test('captures payment, eligibility, and fulfillment evidence', () => {
	const p = fold([created(10), paid(20), fulfilled(30)]);
	assert.equal(p?.orderId, 'o1');
	assert.equal(p?.id, 's:o1');
	assert.equal(p?.paidAt, 20);
	assert.equal(p?.requiresFulfillment, true);
	assert.equal(p?.fulfilledAt, 30);
	assert.equal(p?.lastSourceVersion, 30);
	assert.equal(p?.lastEventAt, 30);
});

test('a digital order (no shippable units) is not fulfillment-eligible', () => {
	const p = fold([paid(20, 0)]);
	assert.equal(p?.paidAt, 20);
	assert.ok(!p?.requiresFulfillment);
});

test('reordered events converge to the same state', () => {
	const events = [created(10), paid(20), fulfilled(30), cancelled(25)];
	const forward = fold(events);
	const reverse = fold([...events].reverse());
	const shuffled = fold([fulfilled(30), created(10), cancelled(25), paid(20)]);
	assert.deepEqual(reverse, forward);
	assert.deepEqual(shuffled, forward);
});

test('duplicate events do not change the result (idempotent)', () => {
	const once = fold([paid(20), fulfilled(30)]);
	const twice = fold([paid(20), paid(20), fulfilled(30), fulfilled(30)]);
	assert.deepEqual(twice, once);
});

test('an older/pending state cannot regress a paid projection', () => {
	// A delayed orders/create (pending) arrives AFTER orders/paid.
	const p = fold([paid(20), created(5)]);
	assert.equal(p?.paidAt, 20, 'still paid — latch is never cleared');
	assert.equal(p?.requiresFulfillment, true);
});

test('latches keep the earliest timestamp regardless of arrival order', () => {
	assert.equal(fold([paid(20), paid(10)])?.paidAt, 10);
	assert.equal(fold([paid(10), paid(20)])?.paidAt, 10);
	assert.equal(fold([fulfilled(30), fulfilled(15)])?.fulfilledAt, 15);
});

test('cancellation and full refund are recorded as suppression latches', () => {
	const c = fold([paid(20), cancelled(25)]);
	assert.equal(c?.cancelledAt, 25);
	const r = fold([paid(20), refunded(40)]);
	assert.equal(r?.fullyRefundedAt, 40);
});

test('a missing payment leaves paidAt unset but still records fulfillment', () => {
	const p = fold([fulfilled(30)]);
	assert.equal(p?.paidAt, undefined);
	assert.equal(p?.fulfilledAt, 30);
});

test('rebuildProjection equals incremental application, ignoring non-order events', () => {
	const inventory = ev('inventory', 15, { resourceId: '99999' }); // not order-linked
	const events = [created(10), paid(20), inventory, fulfilled(30)];
	const rebuilt = rebuildProjection(events);
	const incremental = fold(events.filter(isOrderLinked));
	assert.deepEqual(rebuilt, incremental);
	// The inventory event is excluded from the order projection.
	assert.equal(rebuilt?.orderId, 'o1');
});

test('refund-domain events add no speculative order status', () => {
	const refundEvent = ev('refund', 40, { topic: 'refunds/create', state: 'refunded', quantity: 1 });
	const p = fold([paid(20), refundEvent]);
	// A refund event bumps bookkeeping but does not set fullyRefundedAt (that is
	// a full-refund order state, not a partial refund line).
	assert.equal(p?.fullyRefundedAt, undefined);
	assert.equal(p?.lastSourceVersion, 40);
});

test('isOrderLinked excludes inventory and missing resourceId', () => {
	assert.equal(isOrderLinked(paid(1)), true);
	assert.equal(isOrderLinked(ev('inventory', 1, { resourceId: '5' })), false);
	assert.equal(isOrderLinked(ev('order', 1, { resourceId: '' })), false);
});
