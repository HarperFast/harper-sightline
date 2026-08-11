import type { EventSku, OperationalEvent } from '../domain/model.ts';
import type { NormalizedEvent } from './normalize.ts';

// EventSku is the index that makes "show me events for SKU X" answerable. The
// events table can hold only a scalar sku and an order has many, so a SKU filter
// pages over this table and hydrates events by id (src/api/queries.ts).
//
// Rows are keyed `${eventId}:${sku}`, so reprocessing a delivery upserts exactly
// the same rows — the same idempotency guarantee the event itself has (ADR-002).

// The minimal write surface, so tests can pass an in-memory table.
export interface WritableTable<T> {
	put(record: T): Promise<void>;
}

// The event as STORED: `skus` is a transport field on the normalizer's output,
// not a column, and must not reach the table.
export function stripSkus(event: NormalizedEvent): OperationalEvent {
	const { skus: _skus, ...stored } = event;
	return stored;
}

export function eventSkuRows(event: NormalizedEvent): EventSku[] {
	return (event.skus ?? []).map((sku) => ({
		id: `${event.eventId}:${sku}`,
		shopId: event.shopId,
		eventId: event.eventId,
		sku,
		quantity: event.quantity,
		domain: event.domain,
		topic: event.topic,
		source: event.source,
		resourceId: event.resourceId,
		occurredAt: event.occurredAt,
		receivedAt: event.receivedAt,
	}));
}

// Write the event and its index rows. The event is written FIRST: an index row
// pointing at a missing event would render as a phantom result, whereas an event
// briefly missing from the SKU index just isn't SKU-searchable yet, and the next
// reprocess or reconciliation pass repairs it.
export async function writeEventWithSkus(
	deps: { events: WritableTable<OperationalEvent>; eventSkus: WritableTable<EventSku> },
	event: NormalizedEvent,
): Promise<void> {
	await deps.events.put(stripSkus(event));
	for (const row of eventSkuRows(event)) await deps.eventSkus.put(row);
}
