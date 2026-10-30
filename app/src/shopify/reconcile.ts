import type { OperationalEvent } from '../domain/model.ts';
import type { ReconcileOrder } from './adminApi.ts';

// Financial statuses that mean payment was received at some point.
const PAID_STATUSES = new Set(['PAID', 'PARTIALLY_PAID', 'PARTIALLY_REFUNDED', 'REFUNDED']);

function reconEvent(
	shop: string,
	orderId: string,
	kind: string,
	occurredAt: number,
	extra: Partial<OperationalEvent> & { domain: OperationalEvent['domain'] },
): OperationalEvent {
	return {
		eventId: `recon:${shop}:${orderId}:${kind}`, // deterministic → idempotent upsert
		shopId: shop,
		resourceId: orderId,
		source: 'reconciliation',
		occurredAt,
		receivedAt: occurredAt,
		...extra,
	};
}

// Maps an Admin API order into the events the projection reducer understands. The
// reducer is monotonic, so these merge with webhook-derived state: reconciliation
// fills gaps and never regresses. Timestamps are the order's own.
export function synthesizeEvents(shop: string, order: ReconcileOrder): OperationalEvent[] {
	const events: OperationalEvent[] = [];
	const created = order.createdAt ?? order.updatedAt ?? 0;
	const financial = (order.financialStatus ?? '').toUpperCase();

	if (PAID_STATUSES.has(financial)) {
		events.push(
			reconEvent(shop, order.orderId, 'paid', created, {
				domain: 'order',
				topic: 'orders/paid',
				state: 'paid',
				fulfillableItemCount: order.fulfillableUnits,
			}),
		);
	}
	if (financial === 'REFUNDED') {
		events.push(reconEvent(shop, order.orderId, 'refunded', order.updatedAt ?? created, { domain: 'order', state: 'refunded' }));
	}
	if (order.cancelledAt !== undefined) {
		events.push(
			reconEvent(shop, order.orderId, 'cancelled', order.cancelledAt, { domain: 'order', topic: 'orders/cancelled', state: 'cancelled' }),
		);
	}
	if (order.fulfilledAt !== undefined || (order.fulfillmentStatus ?? '').toUpperCase() === 'FULFILLED') {
		events.push(
			reconEvent(shop, order.orderId, 'fulfilled', order.fulfilledAt ?? order.updatedAt ?? created, {
				domain: 'fulfillment',
				state: 'success',
			}),
		);
	}
	return events;
}
