import {
	Shops,
	Credentials,
	AuditEvents,
	DigestSubscriptions,
	DigestOutboxes,
	Deliveries,
	Events,
	Projections,
	Expectations,
	Findings,
	Aggregates,
	EventSkus,
	InventoryItems,
	ShopLocations,
} from './db.ts';
import type { RetentionTarget, PurgeableTable } from './retention.ts';
import type { RedactTarget } from './redaction.ts';

// db.ts types tables as Table<T>; PurgeableTable is the search+delete subset.
function purgeable(table: unknown): PurgeableTable {
	return table as PurgeableTable;
}

// Ledger tables and the timestamp that drives their seven-day retention
// (ADR-003). Core tables (Shop/ShopCredential/AppAuditEvent) are install-time
// identity and persist while the shop is installed — they are NOT purged here;
// they are erased by shop redaction (below) on uninstall/shop-redact.
export const RETENTION_TARGETS: RetentionTarget[] = [
	{ name: 'WebhookDelivery', keyField: 'id', tsField: 'receivedAt', table: purgeable(Deliveries) },
	{ name: 'OperationalEvent', keyField: 'eventId', tsField: 'receivedAt', table: purgeable(Events) },
	{ name: 'EventSku', keyField: 'id', tsField: 'receivedAt', table: purgeable(EventSkus) },
	{ name: 'OrderProjection', keyField: 'id', tsField: 'lastEventAt', table: purgeable(Projections) },
	{ name: 'Expectation', keyField: 'id', tsField: 'createdAt', table: purgeable(Expectations) },
	{ name: 'GapFinding', keyField: 'id', tsField: 'detectedAt', table: purgeable(Findings) },
	{ name: 'FlowAggregate', keyField: 'id', tsField: 'bucket', table: purgeable(Aggregates) },
];

// Compliance redaction targets. shop/redact erases every shop-scoped table
// (ledger + core); customers/redact (by orders_to_redact) targets only the
// order-linked tables — those carrying `orderField`. Inventory events key
// `resourceId` by inventory_item_id, not an order, so they are not order-linked.
export const REDACT_TARGETS: RedactTarget[] = [
	{ name: 'WebhookDelivery', keyField: 'id', shopField: 'shopId', table: purgeable(Deliveries) },
	{ name: 'OperationalEvent', keyField: 'eventId', shopField: 'shopId', orderField: 'resourceId', table: purgeable(Events) },
	{ name: 'EventSku', keyField: 'id', shopField: 'shopId', orderField: 'resourceId', table: purgeable(EventSkus) },
	{ name: 'OrderProjection', keyField: 'id', shopField: 'shopId', orderField: 'orderId', table: purgeable(Projections) },
	{ name: 'Expectation', keyField: 'id', shopField: 'shopId', orderField: 'orderId', table: purgeable(Expectations) },
	{ name: 'GapFinding', keyField: 'id', shopField: 'shopId', orderField: 'orderId', table: purgeable(Findings) },
	{ name: 'FlowAggregate', keyField: 'id', shopField: 'shopId', table: purgeable(Aggregates) },
	{ name: 'Shop', keyField: 'shopId', shopField: 'shopId', table: purgeable(Shops) },
	{ name: 'ShopCredential', keyField: 'shopId', shopField: 'shopId', table: purgeable(Credentials) },
	{ name: 'AppAuditEvent', keyField: 'id', shopField: 'shopId', table: purgeable(AuditEvents) },
	// Reference caches, NOT ledger records: they carry no order or customer linkage
	// and are useless once the shop is gone, so they are erased by shop redaction
	// but deliberately not aged out by the seven-day purge (re-fetching them every
	// week would be pointless Admin API traffic).
	{ name: 'InventoryItem', keyField: 'id', shopField: 'shopId', table: purgeable(InventoryItems) },
	{ name: 'ShopLocation', keyField: 'id', shopField: 'shopId', table: purgeable(ShopLocations) },
	// The notification address and the generated digests. No orderField: neither is
	// linked to a customer or an order, so customers/redact must NOT reach them —
	// only uninstall / shop-redact does.
	{ name: 'DigestSubscription', keyField: 'shopId', shopField: 'shopId', table: purgeable(DigestSubscriptions) },
	{ name: 'DigestOutbox', keyField: 'id', shopField: 'shopId', table: purgeable(DigestOutboxes) },
];

// The digest outbox keeps a longer history than the 7-day ledger: a digest is a
// record of what the merchant was told, which is worth having after the events it
// described have been purged. It is NOT in RETENTION_TARGETS because that list is
// swept with a single seven-day cutoff.
export const OUTBOX_RETENTION_DAYS = 30;
export const OUTBOX_RETENTION_TARGETS: RetentionTarget[] = [
	{ name: 'DigestOutbox', keyField: 'id', tsField: 'createdAt', table: purgeable(DigestOutboxes) },
];
