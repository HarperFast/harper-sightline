import type { EventSku, InventoryItem, OperationalEvent, ShopLocation } from './model.ts';
import { eventSkuRows } from './eventSkus.ts';

// Inventory webhooks carry only `inventory_item_id` and a number, which is
// unreadable to a merchant and unsearchable by SKU. This module holds the pure
// parts of resolving those ids into product facts through cached Admin API reads;
// the I/O loop lives in jobs.ts.

// Admin API ids per batch. The GraphQL `nodes(ids:)` call takes a list, so one
// round trip resolves a whole batch — 50 keeps each request small and well inside
// the cost budget of a background sweep.
export const ENRICH_BATCH = 50;

export interface InventoryItemFacts {
	inventoryItemId: string;
	sku?: string;
	productTitle?: string;
	variantTitle?: string;
}

// Distinct inventory item ids from these events that we have not resolved yet,
// capped at one batch. Order is first-seen, so the oldest unresolved item wins a
// slot and the sweep makes forward progress rather than thrashing.
export function unresolvedIds(events: Array<{ resourceId?: string }>, resolved: Set<string>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const event of events) {
		const id = event.resourceId;
		if (!id || seen.has(id) || resolved.has(id)) continue;
		seen.add(id);
		out.push(id);
		if (out.length >= ENRICH_BATCH) break;
	}
	return out;
}

export function inventoryItemRow(shopId: string, facts: InventoryItemFacts, now: number): InventoryItem {
	return {
		id: `${shopId}:${facts.inventoryItemId}`,
		shopId,
		inventoryItemId: facts.inventoryItemId,
		sku: facts.sku,
		productTitle: facts.productTitle,
		variantTitle: facts.variantTitle,
		updatedAt: now,
	};
}

export function locationRow(shopId: string, location: { locationId: string; name?: string }, now: number): ShopLocation {
	return {
		id: `${shopId}:${location.locationId}`,
		shopId,
		locationId: location.locationId,
		name: location.name,
		updatedAt: now,
	};
}

// An inventory event has exactly one SKU once resolved, so it reuses the same
// index-row builder every other domain uses — one code path, one key format.
export function skuRowsForInventoryEvent(event: OperationalEvent, sku: string): EventSku[] {
	return eventSkuRows({ ...event, skus: [sku] });
}
