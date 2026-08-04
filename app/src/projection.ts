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
		if (event.state === 'paid' || event.topic === 'orders/paid') next.paidAt = earliest(base.paidAt, event.occurredAt);
		if (event.topic === 'orders/cancelled') next.cancelledAt = earliest(base.cancelledAt, event.occurredAt);
		if (event.state === 'refunded') next.fullyRefundedAt = earliest(base.fullyRefundedAt, event.occurredAt);
		if ((event.fulfillableItemCount ?? 0) > 0) next.requiresFulfillment = true;
	} else if (event.domain === 'fulfillment') {
		if (event.state === 'success') next.fulfilledAt = earliest(base.fulfilledAt, event.occurredAt);
	}
	// refund domain: contributes timeline evidence (the OperationalEvent) but no
	// speculative order status — a partial refund does not set fullyRefundedAt.

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
