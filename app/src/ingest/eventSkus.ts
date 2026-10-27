import type { EventSku, OperationalEvent } from '../domain/model.ts';
import type { NormalizedEvent } from './normalize.ts';

// EventSku makes "events for SKU X" answerable: the events table holds one scalar
// sku and an order has many, so a SKU filter pages this table and hydrates events by
// id (src/api/queries.ts). Rows are keyed `${eventId}:${sku}`, so reprocessing
// upserts the same rows (ADR-002).

// The minimal write surface, so tests can pass an in-memory table.
export interface WritableTable<T> {
	put(record: T): Promise<void>;
}

// `skus` is a transport field on the normalizer's output, not a column.
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

// The event is written first: an index row pointing at a missing event would render
// as a phantom result, while an event briefly missing from the index is repaired by
// the next reprocess or reconciliation pass.
export async function writeEventWithSkus(
	deps: { events: WritableTable<OperationalEvent>; eventSkus: WritableTable<EventSku> },
	event: NormalizedEvent,
): Promise<void> {
	await deps.events.put(stripSkus(event));
	for (const row of eventSkuRows(event)) await deps.eventSkus.put(row);
}
