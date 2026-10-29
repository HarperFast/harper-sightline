import type { EventSku, InventoryItem, OperationalEvent, ShopLocation, WorkerCheckpoint } from '../domain/model.ts';
import { eventSkuRows } from './eventSkus.ts';
import { log, metrics, M } from '../observability/observe.ts';
import { isPermanentAdminError, type fetchInventoryItems, type fetchLocations } from '../shopify/adminApi.ts';

// Resolves inventory webhook item ids (which carry no SKU) into product facts via
// cached Admin API reads, and backfills EventSku rows. Deps-injected and free of
// `./db.ts` / `harper` imports so tests can use FakeTables; jobs.ts wires the real ones.

// Ids per `nodes(ids:)` Admin API call; keeps each request small.
export const ENRICH_BATCH = 50;

// Inventory events one tick reads per shop.
export const ENRICH_READ_LIMIT = 10_000;

export interface InventoryItemFacts {
	inventoryItemId: string;
	sku?: string;
	productTitle?: string;
	variantTitle?: string;
}

// Unresolved item ids, capped at one batch, first-seen order so the oldest gets a slot.
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

function inventoryItemKey(shopId: string, inventoryItemId: string): string {
	return `${shopId}:${inventoryItemId}`;
}

export function inventoryItemRow(shopId: string, facts: InventoryItemFacts, now: number): InventoryItem {
	return {
		id: inventoryItemKey(shopId, facts.inventoryItemId),
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

// An inventory event has one SKU once resolved, so it reuses the shared index-row builder.
export function skuRowsForInventoryEvent(event: OperationalEvent, sku: string): EventSku[] {
	return eventSkuRows({ ...event, skus: [sku] });
}

// Called as the event is written: an event that lands after the sweep passed its
// receivedAt (late replication) is indexed here if its item is cached.
export async function indexCachedInventoryEvent(
	deps: { inventoryItems: Pick<EnrichReadTable, 'get'>; eventSkus: { put(row: EventSku): Promise<void> } },
	event: OperationalEvent,
): Promise<number> {
	if (event.domain !== 'inventory' || !event.resourceId) return 0;
	const item = ((await deps.inventoryItems.get(inventoryItemKey(event.shopId, event.resourceId))) ?? undefined) as
		InventoryItem | undefined;
	if (!item?.sku) return 0;
	const rows = skuRowsForInventoryEvent(event, item.sku);
	for (const row of rows) await deps.eventSkus.put(row);
	return rows.length;
}

// The `limit` oldest rows by receivedAt plus every row sharing the last kept
// receivedAt. receivedAt is not indexed, so a sorted query would buffer every match;
// this streams with bounded memory.
export async function oldestByReceivedAt(rows: AsyncIterable<Record<string, unknown>>, limit: number): Promise<OperationalEvent[]> {
	let kept: OperationalEvent[] = [];
	let compactAt = limit * 2;
	for await (const row of rows) {
		kept.push(row as unknown as OperationalEvent);
		if (kept.length >= compactAt) {
			kept = keepOldest(kept, limit);
			compactAt = kept.length + limit;
		}
	}
	return keepOldest(kept, limit);
}

function keepOldest(events: OperationalEvent[], limit: number): OperationalEvent[] {
	events.sort((a, b) => a.receivedAt - b.receivedAt);
	if (events.length <= limit) return events;
	const boundary = events[limit - 1].receivedAt;
	let end = limit;
	while (end < events.length && events[end].receivedAt === boundary) end++;
	return events.slice(0, end);
}

// Its events are not written yet, and deliveries are not processed in receivedAt order.
async function oldestQueuedDelivery(deliveries: EnrichReadTable, shopId: string): Promise<number> {
	let oldest = Number.POSITIVE_INFINITY;
	for await (const d of deliveries.search({
		conditions: [
			{ attribute: 'shopId', value: shopId },
			{ attribute: 'status', value: 'accepted' },
		],
		operator: 'and',
		select: ['receivedAt'],
	})) {
		const receivedAt = Number(d.receivedAt);
		if (receivedAt < oldest) oldest = receivedAt;
	}
	return oldest;
}

// Same shape as reconcile's `reconcile:<shopId>` checkpoint.
export function checkpointId(shopId: string): string {
	return `enrich:${shopId}`;
}

// Minimal search/get surface the sweep needs; satisfied by a Harper Table<T> and by FakeTable.
export interface EnrichQuerySpec {
	conditions: Array<{ attribute: string; value: unknown; comparator?: string }>;
	operator?: 'and' | 'or';
	select?: string[];
	limit?: number;
}
export interface EnrichReadTable {
	search(spec: EnrichQuerySpec): AsyncIterable<Record<string, unknown>>;
	get(id: string): Promise<Record<string, unknown> | null>;
}

// Injected side effects: real tables, Admin API and token resolution (jobs.ts), or fakes in tests.
export interface EnrichDeps {
	shops: EnrichReadTable;
	events: EnrichReadTable;
	inventoryItems: EnrichReadTable & { put(row: InventoryItem): Promise<void> };
	shopLocations: EnrichReadTable & { put(row: ShopLocation): Promise<void> };
	eventSkus: { put(row: EventSku): Promise<void> };
	checkpoints: EnrichReadTable & { put(row: WorkerCheckpoint): Promise<void> };
	deliveries: EnrichReadTable;
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

// Convergence comes from a durable per-shop checkpoint (`enrich:<shopId>`), not from
// ENRICH_BATCH, which only caps new ids per tick. The checkpoint holds a `receivedAt`
// frontier: each tick reads the oldest ENRICH_READ_LIMIT inventory events at or after
// it and advances past events whose SKU is known, never past the shop's oldest
// queued delivery. A call that throws holds the frontier for retry. A successful
// call that omits a requested id means the item was deleted in Shopify, so it is
// tombstoned (resolved, no SKU) and stops pinning the frontier.
export async function runInventoryEnrichment(now: number, deps: EnrichDeps): Promise<EnrichResult> {
	let items = 0;
	let locations = 0;
	let indexed = 0;
	// Read out before any network work: a live iterator holds a Harper read snapshot that expires
	// after maxTransactionOpenTime (30 s), and one slow shop made the next advance throw and skip the rest.
	const shopIds: string[] = [];
	for await (const s of deps.shops.search({ conditions: [{ attribute: 'status', value: 'active' }], select: ['shopId'] })) {
		shopIds.push((s as { shopId: string }).shopId);
	}
	for (const shopId of shopIds) {
		let token: string | null;
		try {
			token = await deps.getToken(shopId, now);
		} catch (e: unknown) {
			// A transient failure for one shop must not starve the shops after it.
			metrics.inc(M.enrichError);
			log('error', 'enrich.shop.error', { shop: shopId, message: (e as Error).message });
			continue;
		}
		if (!token) continue;

		// Refreshed when none is cached.
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
				// A missing-scope failure never resolves on retry, so it is an error, not a warn.
				log(isPermanentAdminError(e) ? 'error' : 'warn', 'enrich.locations.failed', { shop: shopId, message: (e as Error).message });
			}
		}

		// The frontier is the durable checkpoint, not the retention window; otherwise a
		// stable catalog would re-read and re-index the whole window every tick.
		const checkpoint = await deps.checkpoints.get(checkpointId(shopId));
		const cursor = Number((checkpoint as { cursor?: unknown } | undefined)?.cursor ?? now - SEVEN_DAYS_MS);

		// Read before the events so a delivery processed in between has its events in the read below.
		const queuedFloor = await oldestQueuedDelivery(deps.deliveries, shopId);
		const inventoryEvents = await oldestByReceivedAt(
			deps.events.search({
				conditions: [
					{ attribute: 'shopId', value: shopId },
					{ attribute: 'domain', value: 'inventory' },
					{ attribute: 'receivedAt', value: cursor, comparator: 'greater_than_equal' },
				],
				operator: 'and',
			}),
			ENRICH_READ_LIMIT,
		);
		// Nothing in the window: nothing to advance past.
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
				const fetched = await deps.fetchItems(shopId, token, wanted);
				for (const facts of fetched) {
					await deps.inventoryItems.put(inventoryItemRow(shopId, facts, now));
					resolved.add(facts.inventoryItemId);
					if (facts.sku) skuById.set(facts.inventoryItemId, facts.sku);
					items++;
				}
				// A successful call that omits an id means Shopify no longer has it (deleted
				// product or variant). Tombstone it so it counts as resolved and stops pinning the
				// frontier; only reachable after a call that succeeded, since the catch below is
				// transient and must stay retryable.
				const returned = new Set(fetched.map((f) => f.inventoryItemId));
				for (const id of wanted) {
					if (returned.has(id)) continue;
					await deps.inventoryItems.put(inventoryItemRow(shopId, { inventoryItemId: id }, now));
					resolved.add(id);
					items++;
				}
			} catch (e: unknown) {
				// A missing-scope failure never resolves on retry, so it is an error, not a warn.
				log(isPermanentAdminError(e) ? 'error' : 'warn', 'enrich.items.failed', { shop: shopId, message: (e as Error).message });
			}
		}

		// Keys are deterministic, so re-running writes the same rows.
		for (const event of inventoryEvents) {
			const sku = event.resourceId ? skuById.get(event.resourceId) : undefined;
			if (!sku) continue;
			for (const row of skuRowsForInventoryEvent(event, sku)) {
				await deps.eventSkus.put(row);
				indexed++;
			}
		}

		// Advance past everything resolved but hold at the oldest event still waiting on
		// the Admin API. An event with no resourceId can never gain a SKU, so it never blocks.
		const oldestUnknown = inventoryEvents.find((e) => e.resourceId && !resolved.has(e.resourceId));
		const next = Math.min(
			oldestUnknown ? oldestUnknown.receivedAt : inventoryEvents[inventoryEvents.length - 1].receivedAt + 1,
			queuedFloor,
		);
		await deps.checkpoints.put({ id: checkpointId(shopId), cursor: String(next), updatedAt: now });
	}
	return { items, locations, indexed };
}
