import type { OperationalEvent, OrderProjection } from '../domain/model.ts';
import { deriveOrderLane } from '../domain/orders.ts';

// Domains that update an order's projection; inventory events key on an item id and are excluded.
const ORDER_LINKED_DOMAINS = new Set(['order', 'fulfillment', 'refund']);

export function isOrderLinked(event: OperationalEvent): boolean {
	return ORDER_LINKED_DOMAINS.has(event.domain) && typeof event.resourceId === 'string' && event.resourceId.length > 0;
}

function earliest(existing: number | undefined, candidate: number): number {
	return existing === undefined ? candidate : Math.min(existing, candidate);
}

// Shopify's own fulfillment statuses for an attempt that did not succeed.
export const FAILED_FULFILLMENT_STATES = new Set(['error', 'failure']);

// Folds one order-linked event into a projection. Every field is a monotonic latch
// (earliest timestamp) or a max, so the reducer is commutative and idempotent:
// duplicate, delayed or reordered events converge and never regress it. The caller
// guarantees isOrderLinked(event).
//
// Mutable "current status" strings are not stored: a shared version guard would make
// them order-dependent and break rebuild equality. `state` is the exception only in
// appearance: it is recomputed from this record's own latches on every call.
export function applyEvent(current: OrderProjection | undefined, event: OperationalEvent): OrderProjection {
	const orderId = event.resourceId as string;
	const base: OrderProjection = current ?? { id: `${event.shopId}:${orderId}`, shopId: event.shopId, orderId };

	const next: OrderProjection = {
		...base,
		lastEventAt: Math.max(base.lastEventAt ?? 0, event.receivedAt),
		firstEventAt: Math.min(base.firstEventAt ?? event.receivedAt, event.receivedAt),
		lastSourceVersion: Math.max(base.lastSourceVersion ?? event.occurredAt, event.occurredAt),
	};

	if (event.domain === 'order') {
		if (event.state === 'paid' || event.topic === 'orders/paid') {
			// Latch from the earliest paid event; comparing against the pre-update paidAt keeps this commutative.
			if (base.paidAt === undefined || event.occurredAt < base.paidAt) {
				if (event.totalPrice !== undefined) next.orderTotal = event.totalPrice;
				if (event.currency !== undefined) next.currency = event.currency;
			}
			next.paidAt = earliest(base.paidAt, event.occurredAt);
		}
		if (event.topic === 'orders/cancelled') next.cancelledAt = earliest(base.cancelledAt, event.occurredAt);
		if (event.state === 'refunded') next.fullyRefundedAt = earliest(base.fullyRefundedAt, event.occurredAt);
		if ((event.fulfillableItemCount ?? 0) > 0) next.requiresFulfillment = true;
	} else if (event.domain === 'fulfillment') {
		if (event.state === 'success') next.fulfilledAt = earliest(base.fulfilledAt, event.occurredAt);
		// Never cleared by a later success: the merchant needs to know an attempt failed.
		if (event.state !== undefined && FAILED_FULFILLMENT_STATES.has(event.state)) {
			next.fulfillmentFailedAt = earliest(base.fulfillmentFailedAt, event.occurredAt);
		}
		// Monotonic true. The carrier is latched to the earliest tracked fulfillment (a split
		// shipment can have two), so it does not depend on fold order.
		if (event.hasTracking === true) {
			next.hasTracking = true;
			if (base.trackingAt === undefined || event.occurredAt < base.trackingAt) {
				if (event.trackingCompany !== undefined) next.trackingCompany = event.trackingCompany;
			}
			next.trackingAt = earliest(base.trackingAt, event.occurredAt);
		}
	}
	// refund domain: timeline evidence only; a partial refund does not set fullyRefundedAt.

	// Immutable in Shopify, so first-seen-wins is order-independent.
	if (next.orderName === undefined && event.orderName !== undefined) next.orderName = event.orderName;

	// Derived from the latches above, so it is rebuild-equal. Stored in the indexed
	// `state` column so the worklist can filter and page in the database.
	next.state = deriveOrderLane(next);

	return next;
}

// Same state as incremental application, since applyEvent is commutative; undefined
// when no order-linked events exist.
export function rebuildProjection(events: OperationalEvent[]): OrderProjection | undefined {
	let projection: OrderProjection | undefined;
	let eventCount = 0;
	for (const event of events) {
		if (!isOrderLinked(event)) continue;
		projection = applyEvent(projection, event);
		eventCount++;
	}
	return projection && { ...projection, eventCount };
}
