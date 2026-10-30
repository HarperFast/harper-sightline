import type { RedactionTombstone } from '../domain/model.ts';

// Redaction tombstones. A customers/redact or shop/redact request deletes what is
// stored, but a delivery accepted before it and still queued would write the order
// back on the next drain. A tombstone records the request for the ledger's seven days
// (the purge removes it), and the worker and the reconcile sweep drop matching data
// without writing it. It holds only ids the request carried.

export interface TombstoneTable {
	get(id: string): Promise<{ redactedAt?: unknown } | null | undefined>;
	put(row: RedactionTombstone): Promise<void>;
}

// Shopify order ids are numeric, so this cannot collide with one.
const WHOLE_SHOP = '*';

// A shop tombstone covers deliveries received this long after the request, for
// clock skew between the node that accepted a delivery and the one that took the
// request. Ingress refuses the shop until it reinstalls, so nothing legitimate arrives in it.
export const SHOP_TOMBSTONE_SKEW_MS = 5 * 60_000;

export function tombstoneId(shopId: string, orderId?: string): string {
	return `${shopId}:${orderId ?? WHOLE_SHOP}`;
}

// A retried request rewrites the same keys and restarts their seven days.
export async function tombstoneOrders(table: TombstoneTable, shopId: string, orderIds: string[], now: number): Promise<void> {
	for (const orderId of new Set(orderIds)) await table.put({ id: tombstoneId(shopId, orderId), shopId, orderId, redactedAt: now });
}

export async function tombstoneShop(table: TombstoneTable, shopId: string, now: number): Promise<void> {
	await table.put({ id: tombstoneId(shopId), shopId, redactedAt: now });
}

// Whether data received at `receivedAt` for `orderId` (undefined: not about an order)
// must be dropped. An order tombstone drops everything for the order while it lasts.
// A shop tombstone drops only what was received before the request, so a shop that
// reinstalls within the seven days records normally. At most two primary-key reads.
export async function isRedacted(
	table: Pick<TombstoneTable, 'get'>,
	shopId: string,
	orderId: string | undefined,
	receivedAt: number,
): Promise<boolean> {
	if (orderId !== undefined && (await table.get(tombstoneId(shopId, orderId)))) return true;
	const shop = await table.get(tombstoneId(shopId));
	return !!shop && receivedAt <= (shop.redactedAt as number) + SHOP_TOMBSTONE_SKEW_MS;
}
