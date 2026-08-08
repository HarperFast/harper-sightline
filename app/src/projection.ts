import type { OperationalEvent, OrderProjection } from './model.ts';

// Order-linked domains — the ones that update an order's projection. Inventory
// events key `resourceId` by inventory_item_id (not an order) and are excluded.
const ORDER_LINKED_DOMAINS = new Set(['order', 'fulfillment', 'refund']);

export function isOrderLinked(event: OperationalEvent): boolean {
	return ORDER_LINKED_DOMAINS.has(event.domain) && typeof event.resourceId === 'string' && event.resourceId.length > 0;
}

function earliest(existing: number | undefined, candidate: number): number {
	return existing === undefined ? candidate : Math.min(existing, candidate);
}

// Fulfillment statuses that mean an attempt was made and did not succeed. These
// are Shopify's own status strings on a fulfillment record — direct evidence of a
// failed attempt, not an inference from absence.
export const FAILED_FULFILLMENT_STATES = new Set(['error', 'failure']);

// Fold one order-linked event into an order projection. Every maintained field
// is a monotonic latch (earliest-timestamp) or a max, so the reducer is
// COMMUTATIVE and IDEMPOTENT: duplicate, delayed, or reordered events converge to
// the same state and can never regress it (issue #12, out-of-order safety). The
// caller guarantees isOrderLinked(event).
//
// Only latch fields are maintained here; mutable "current status" strings
// (financialStatus/fulfillmentStatus) are intentionally NOT stored — a shared
// version guard would make them order-dependent, breaking rebuild equality. The
// detector (#14) and UI (#18) derive display status from these latches instead.
export function applyEvent(current: OrderProjection | undefined, event: OperationalEvent): OrderProjection {
	const orderId = event.resourceId as string;
	const base: OrderProjection = current ?? { id: `${event.shopId}:${orderId}`, shopId: event.shopId, orderId };

	const next: OrderProjection = {
		...base,
		lastEventAt: Math.max(base.lastEventAt ?? 0, event.receivedAt),
		lastSourceVersion: Math.max(base.lastSourceVersion ?? event.occurredAt, event.occurredAt),
	};

	if (event.domain === 'order') {
		if (event.state === 'paid' || event.topic === 'orders/paid') {
			// Latch the order's value from the EARLIEST paid event, so the stored
			// value is the one that was true at payment. Comparing against the
			// pre-update paidAt keeps this commutative: whichever order the events
			// arrive in, the value from the lowest paid timestamp wins.
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
		// A failed attempt is recorded and never cleared by a later success: the
		// merchant needs to know an attempt failed even if a retry worked.
		if (event.state !== undefined && FAILED_FULFILLMENT_STATES.has(event.state)) {
			next.fulfillmentFailedAt = earliest(base.fulfillmentFailedAt, event.occurredAt);
		}
		// Monotonic true: "some fulfillment carried tracking" can only become true.
		if (event.hasTracking === true) {
			next.hasTracking = true;
			if (event.trackingCompany !== undefined) next.trackingCompany = event.trackingCompany;
		}
	}
	// refund domain: contributes timeline evidence (the OperationalEvent) but no
	// speculative order status — a partial refund does not set fullyRefundedAt.

	// Order name is immutable in Shopify, so first-seen-wins is stable across
	// any event ordering.
	if (next.orderName === undefined && event.orderName !== undefined) next.orderName = event.orderName;

	return next;
}

// Rebuild an order's projection from its normalized events (any order). Because
// applyEvent is commutative, this yields the same state as incremental
// application — the acceptance-criterion invariant (#12). Returns undefined when
// no order-linked events exist.
export function rebuildProjection(events: OperationalEvent[]): OrderProjection | undefined {
	let projection: OrderProjection | undefined;
	for (const event of events) {
		if (isOrderLinked(event)) projection = applyEvent(projection, event);
	}
	return projection;
}
