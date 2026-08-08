import type { EventSku, InventoryItem, OperationalEvent, ShopLocation, WorkerCheckpoint } from './model.ts';
import { eventSkuRows } from './eventSkus.ts';
import { log } from './observe.ts';
import type { fetchInventoryItems, fetchLocations } from './adminApi.ts';

// Inventory webhooks carry only `inventory_item_id` and a number, which is
// unreadable to a merchant and unsearchable by SKU. This module holds both the
// pure parts of resolving those ids into product facts through cached Admin API
// reads, AND the deps-injected sweep that orchestrates them — kept here (rather
// than in jobs.ts) so it stays unit-testable without the Harper runtime, the same
// split accessToken.ts/tokenDeps.ts and processor.ts/jobs.ts already use: this
// module never imports `./db.ts` or the `harper` package, so a test can supply
// FakeTables and fake fetchers directly. jobs.ts wires the real Harper tables,
// the real Admin API calls, and the ticker/schedule.

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

// ─── deps-injected sweep ────────────────────────────────────────────────────────

// Same key shape reconcile's own `reconcile:<shopId>` checkpoint already uses
// (WorkerCheckpoint, one row per shop).
export function checkpointId(shopId: string): string {
	return `enrich:${shopId}`;
}

// The minimal search/get surface the sweep needs from a table — structurally
// satisfied by a Harper Table<T> (cast at the call site, as elsewhere in this
// codebase) and directly by a FakeTable in tests.
export interface EnrichQuerySpec {
	conditions: Array<{ attribute: string; value: unknown; comparator?: string }>;
	operator?: 'and' | 'or';
	select?: string[];
	limit?: number;
}
export interface EnrichReadTable {
	search(spec: EnrichQuerySpec): AsyncIterable<Record<string, unknown>>;
	get(id: string): Promise<Record<string, unknown> | undefined>;
}

// Injected side effects: real Harper tables + the real Admin API + real token
// resolution in the component (jobs.ts wires these); FakeTables + fake fetchers
// + a fake token resolver in tests.
export interface EnrichDeps {
	shops: EnrichReadTable;
	events: EnrichReadTable;
	inventoryItems: EnrichReadTable & { put(row: InventoryItem): Promise<void> };
	shopLocations: EnrichReadTable & { put(row: ShopLocation): Promise<void> };
	eventSkus: { put(row: EventSku): Promise<void> };
	checkpoints: EnrichReadTable & { put(row: WorkerCheckpoint): Promise<void> };
	getToken(shopId: string, now: number): Promise<string | null>;
	fetchItems: typeof fetchInventoryItems;
	fetchLocations: typeof fetchLocations;
}

export interface EnrichResult {
	items: number;
	locations: number;
	indexed: number;
}

const SEVEN_DAYS_MS = 7 * 86_400_000;

// The sweep. An inventory webhook carries only inventory_item_id and a
// quantity; this resolves unseen item ids (and the shop's locations) through
// the Admin API, caches them, and backfills EventSku rows so inventory events
// become SKU-searchable like every other domain.
//
// Convergence is enforced by a durable per-shop checkpoint (WorkerCheckpoint,
// keyed `enrich:<shopId>`), NOT by ENRICH_BATCH alone — ENRICH_BATCH only caps
// how many NEW item ids one tick resolves through the Admin API. The checkpoint
// holds a `receivedAt` frontier: each tick reads only inventory events at or
// after it, and advances it only past events whose SKU is now known. An item
// the Admin API can't (yet) resolve holds the frontier at its receivedAt, so it
// is retried next tick instead of being silently skipped forever, while
// everything already indexed is never re-read or re-indexed. A shop with a
// stable, fully-resolved catalog therefore converges to one small (empty)
// event query and zero writes per tick.
export async function runInventoryEnrichment(now: number, deps: EnrichDeps): Promise<EnrichResult> {
	let items = 0;
	let locations = 0;
	let indexed = 0;
	for await (const s of deps.shops.search({ conditions: [{ attribute: 'status', value: 'active' }] })) {
		const shopId = (s as { shopId: string }).shopId;
		const token = await deps.getToken(shopId, now);
		if (!token) continue;

		// Locations: one small call, refreshed when we have none cached.
		let cachedLocations = 0;
		for await (const _l of deps.shopLocations.search({ conditions: [{ attribute: 'shopId', value: shopId }], select: ['id'], limit: 1 })) {
			cachedLocations++;
		}
		if (cachedLocations === 0) {
			try {
				for (const location of await deps.fetchLocations(shopId, token)) {
					await deps.shopLocations.put(locationRow(shopId, location, now));
					locations++;
				}
			} catch (e: unknown) {
				log('warn', 'enrich.locations.failed', { shop: shopId, message: (e as Error).message });
			}
		}

		// The read frontier is the durable checkpoint, not the fixed retention
		// window — without it, a stable catalog would re-read and re-index the
		// WHOLE window every tick forever (the defect this checkpoint closes).
		const checkpoint = await deps.checkpoints.get(checkpointId(shopId));
		const cursor = Number((checkpoint as { cursor?: unknown } | undefined)?.cursor ?? now - SEVEN_DAYS_MS);

		const inventoryEvents: OperationalEvent[] = [];
		for await (const e of deps.events.search({
			conditions: [
				{ attribute: 'shopId', value: shopId },
				{ attribute: 'domain', value: 'inventory' },
				{ attribute: 'receivedAt', value: cursor, comparator: 'greater_than_equal' },
			],
			operator: 'and',
		})) {
			inventoryEvents.push(e as unknown as OperationalEvent);
		}
		// Nothing in the window: leave the checkpoint untouched (nothing was
		// processed, so there is nothing to advance past).
		if (inventoryEvents.length === 0) continue;

		const resolved = new Set<string>();
		const skuById = new Map<string, string>();
		for await (const row of deps.inventoryItems.search({ conditions: [{ attribute: 'shopId', value: shopId }] })) {
			const item = row as unknown as InventoryItem;
			resolved.add(item.inventoryItemId);
			if (item.sku) skuById.set(item.inventoryItemId, item.sku);
		}

		const wanted = unresolvedIds(inventoryEvents, resolved);
		if (wanted.length > 0) {
			try {
				for (const facts of await deps.fetchItems(shopId, token, wanted)) {
					await deps.inventoryItems.put(inventoryItemRow(shopId, facts, now));
					resolved.add(facts.inventoryItemId);
					if (facts.sku) skuById.set(facts.inventoryItemId, facts.sku);
					items++;
				}
			} catch (e: unknown) {
				log('warn', 'enrich.items.failed', { shop: shopId, message: (e as Error).message });
			}
		}

		// Backfill the SKU index for every event whose item we can now name. Keys
		// are deterministic, so re-running writes the same rows.
		for (const event of inventoryEvents) {
			const sku = event.resourceId ? skuById.get(event.resourceId) : undefined;
			if (!sku) continue;
			for (const row of skuRowsForInventoryEvent(event, sku)) {
				await deps.eventSkus.put(row);
				indexed++;
			}
		}

		// Advance the frontier past everything now resolved, but hold it at the
		// oldest event still waiting on the Admin API — retried next tick rather
		// than skipped forever. An event with no resourceId can never gain a SKU,
		// so it never blocks the frontier (unresolvedIds already excludes it, and
		// `resolved` is never checked against it here either).
		const stillUnknown = inventoryEvents.filter((e) => e.resourceId && !resolved.has(e.resourceId));
		const next =
			stillUnknown.length > 0
				? Math.min(...stillUnknown.map((e) => e.receivedAt))
				: Math.max(...inventoryEvents.map((e) => e.receivedAt)) + 1;
		await deps.checkpoints.put({ id: checkpointId(shopId), cursor: String(next), updatedAt: now });
	}
	return { items, locations, indexed };
}
