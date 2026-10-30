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

// `skus` and `skusDropped` are transport fields on the normalizer's output, not columns.
export function stripSkus(event: NormalizedEvent): OperationalEvent {
	const { skus: _skus, skusDropped: _skusDropped, ...stored } = event;
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

// Harper's transaction(): the writes inside commit together, or none do if `work` throws.
export type Transact = <T>(work: () => Promise<T>) => Promise<T>;

// The event and its index rows (at most MAX_EVENT_SKUS) commit in one transaction, so
// a failed put leaves neither an event missing from the SKU filter nor an index row
// pointing at no event. One commit is also faster than one per row (DESIGN.md,
// Measured costs).
export async function writeEventWithSkus(
	deps: { events: WritableTable<OperationalEvent>; eventSkus: WritableTable<EventSku>; transaction: Transact },
	event: NormalizedEvent,
): Promise<void> {
	await deps.transaction(async () => {
		await deps.events.put(stripSkus(event));
		await Promise.all(eventSkuRows(event).map((row) => deps.eventSkus.put(row)));
	});
}
