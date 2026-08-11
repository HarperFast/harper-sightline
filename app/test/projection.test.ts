import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, rebuildProjection, isOrderLinked } from '../src/ingest/projection.ts';
import type { EventDomain, OperationalEvent } from '../src/domain/model.ts';

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

test('a fulfillment with status error latches fulfillmentFailedAt at the earliest attempt', () => {
	const p = rebuildProjection([
		ev('order', 100, { eventId: 'e1', topic: 'orders/paid', state: 'paid', fulfillableItemCount: 2 }),
		ev('fulfillment', 300, { eventId: 'e2', state: 'error' }),
		ev('fulfillment', 200, { eventId: 'e3', state: 'failure' }),
	]);
	assert.equal(p?.fulfillmentFailedAt, 200);
	assert.equal(p?.fulfilledAt, undefined);
});

test('a successful fulfillment does not clear an earlier failure — history is preserved', () => {
	const p = rebuildProjection([
		ev('order', 100, { eventId: 'e1', topic: 'orders/paid', state: 'paid', fulfillableItemCount: 2 }),
		ev('fulfillment', 200, { eventId: 'e2', state: 'error' }),
		ev('fulfillment', 400, { eventId: 'e3', state: 'success' }),
	]);
	assert.equal(p?.fulfillmentFailedAt, 200);
	assert.equal(p?.fulfilledAt, 400);
});

test('pending and open fulfillments are not failures', () => {
	const p = rebuildProjection([
		ev('fulfillment', 100, { eventId: 'e1', state: 'pending' }),
		ev('fulfillment', 200, { eventId: 'e2', state: 'open' }),
	]);
	assert.equal(p?.fulfillmentFailedAt, undefined);
});

test('tracking presence latches true and never back to false', () => {
	const p = rebuildProjection([
		ev('fulfillment', 100, { eventId: 'e1', state: 'success', hasTracking: true, trackingCompany: 'UPS' }),
		ev('fulfillment', 200, { eventId: 'e2', state: 'success', hasTracking: false }),
	]);
	assert.equal(p?.hasTracking, true);
	assert.equal(p?.trackingCompany, 'UPS');
});

test('trackingCompany is latched from the earliest tracked fulfillment, not fold order', () => {
	// Two fulfillments, two carriers — an ordinary split shipment. Whichever
	// carrier is "true" for the order must not depend on which event we folded
	// last, since Events.search() gives no ordering guarantee.
	const forward = rebuildProjection([
		ev('fulfillment', 100, { eventId: 'e1', state: 'success', hasTracking: true, trackingCompany: 'UPS' }),
		ev('fulfillment', 200, { eventId: 'e2', state: 'success', hasTracking: true, trackingCompany: 'FedEx' }),
	]);
	const reverse = rebuildProjection([
		ev('fulfillment', 200, { eventId: 'e2', state: 'success', hasTracking: true, trackingCompany: 'FedEx' }),
		ev('fulfillment', 100, { eventId: 'e1', state: 'success', hasTracking: true, trackingCompany: 'UPS' }),
	]);
	assert.equal(forward?.trackingCompany, 'UPS');
	assert.equal(reverse?.trackingCompany, 'UPS');
});

test('a later tracked fulfillment with no carrier does not blank a known carrier', () => {
	const p = rebuildProjection([
		ev('fulfillment', 100, { eventId: 'e1', state: 'success', hasTracking: true, trackingCompany: 'UPS' }),
		ev('fulfillment', 200, { eventId: 'e2', state: 'success', hasTracking: true }),
	]);
	assert.equal(p?.trackingCompany, 'UPS');
});

test('order value is latched from the EARLIEST paid event, with its currency', () => {
	const p = rebuildProjection([
		ev('order', 200, { eventId: 'e1', topic: 'orders/paid', state: 'paid', totalPrice: 50, currency: 'USD' }),
		ev('order', 100, { eventId: 'e2', topic: 'orders/paid', state: 'paid', totalPrice: 40, currency: 'USD' }),
	]);
	assert.equal(p?.paidAt, 100);
	assert.equal(p?.orderTotal, 40);
	assert.equal(p?.currency, 'USD');
});

test('order name is carried onto the projection', () => {
	const p = rebuildProjection([ev('order', 100, { eventId: 'e1', topic: 'orders/paid', state: 'paid', orderName: '#1001' })]);
	assert.equal(p?.orderName, '#1001');
});

test('the reducer writes the derived lane', () => {
	assert.equal(
		rebuildProjection([ev('order', 100, { eventId: 'e1', topic: 'orders/paid', state: 'paid', fulfillableItemCount: 2 })])?.state,
		'awaiting',
	);
	assert.equal(
		rebuildProjection([
			ev('order', 100, { eventId: 'e1', topic: 'orders/paid', state: 'paid', fulfillableItemCount: 2 }),
			ev('fulfillment', 200, { eventId: 'e2', state: 'success' }),
		])?.state,
		'fulfilled',
	);
});

test('the derived lane is rebuild-equal under shuffled event order', () => {
	const events = [
		ev('order', 100, { eventId: 'e1', topic: 'orders/paid', state: 'paid', fulfillableItemCount: 2 }),
		ev('fulfillment', 300, { eventId: 'e2', state: 'success' }),
		ev('order', 400, { eventId: 'e3', topic: 'orders/cancelled' }),
	];
	assert.equal(rebuildProjection([...events].reverse())?.state, rebuildProjection(events)?.state);
	assert.equal(rebuildProjection(events)?.state, 'cancelled');
});

test('rebuild equality holds for every new latch under shuffled event order', () => {
	const events = [
		ev('order', 100, {
			eventId: 'e1',
			topic: 'orders/paid',
			state: 'paid',
			fulfillableItemCount: 2,
			orderName: '#1001',
			totalPrice: 40,
			currency: 'USD',
		}),
		ev('fulfillment', 200, { eventId: 'e2', state: 'error' }),
		ev('fulfillment', 400, { eventId: 'e3', state: 'success', hasTracking: true, trackingCompany: 'UPS' }),
		ev('order', 300, { eventId: 'e4', topic: 'orders/paid', state: 'paid', totalPrice: 55, currency: 'USD' }),
		// A second tracked fulfillment, earlier than e3 and with a different
		// carrier — a split shipment. This is the case that would have caught the
		// "last fold wins" bug: e3 and e5 fold in different relative orders under
		// forward/reverse/shuffled, so a fold-order-dependent latch would diverge.
		ev('fulfillment', 350, { eventId: 'e5', state: 'success', hasTracking: true, trackingCompany: 'FedEx' }),
	];
	const forward = rebuildProjection(events);
	const reverse = rebuildProjection([...events].reverse());
	const shuffled = rebuildProjection([events[2], events[4], events[0], events[3], events[1]]);
	assert.deepEqual(reverse, forward);
	assert.deepEqual(shuffled, forward);
	assert.equal(forward?.trackingCompany, 'FedEx'); // earliest tracked fulfillment (e5 @350) wins over e3 @400
});
