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
	RedactionTombstones,
} from '../db.ts';
import type { RetentionTarget, PurgeableTable } from './retention.ts';
import type { RedactTarget } from '../privacy/redaction.ts';

// db.ts types tables as Table<T>; PurgeableTable is the search+delete subset.
function purgeable(table: unknown): PurgeableTable {
	return table as PurgeableTable;
}

// Ledger tables and the timestamp driving their seven-day retention (ADR-003). Core
// tables (Shop, ShopCredential, AppAuditEvent) persist while installed and are
// erased by shop redaction on uninstall.
export const RETENTION_TARGETS: RetentionTarget[] = [
	{ name: 'WebhookDelivery', keyField: 'id', tsField: 'receivedAt', table: purgeable(Deliveries) },
	{ name: 'OperationalEvent', keyField: 'eventId', tsField: 'receivedAt', table: purgeable(Events) },
	{ name: 'EventSku', keyField: 'id', tsField: 'receivedAt', table: purgeable(EventSkus) },
	{ name: 'OrderProjection', keyField: 'id', tsField: 'lastEventAt', table: purgeable(Projections) },
	{ name: 'Expectation', keyField: 'id', tsField: 'createdAt', table: purgeable(Expectations) },
	{ name: 'GapFinding', keyField: 'id', tsField: 'detectedAt', table: purgeable(Findings) },
	{ name: 'FlowAggregate', keyField: 'id', tsField: 'bucket', table: purgeable(Aggregates) },
	{ name: 'RedactionTombstone', keyField: 'id', tsField: 'redactedAt', table: purgeable(RedactionTombstones) },
];

// shop/redact erases every shop-scoped table; customers/redact targets only
// order-linked tables (those with `orderField`). Inventory events key on an item id.
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
	// Reference caches, not ledger records: erased by shop redaction but not aged out by
	// the purge (re-fetching weekly would be pointless Admin API traffic).
	{ name: 'InventoryItem', keyField: 'id', shopField: 'shopId', table: purgeable(InventoryItems) },
	{ name: 'ShopLocation', keyField: 'id', shopField: 'shopId', table: purgeable(ShopLocations) },
	// No orderField: neither is linked to a customer or order, so customers/redact must
	// not reach them; only uninstall and shop-redact do.
	{ name: 'DigestSubscription', keyField: 'shopId', shopField: 'shopId', table: purgeable(DigestSubscriptions) },
	{ name: 'DigestOutbox', keyField: 'id', shopField: 'shopId', table: purgeable(DigestOutboxes) },
	// No orderField: customers/redact must keep the tombstones it writes. Last, so shop
	// redaction deletes the shop's tombstone just before rewriting it (compliance.ts).
	{ name: 'RedactionTombstone', keyField: 'id', shopField: 'shopId', table: purgeable(RedactionTombstones) },
];

// The outbox keeps a longer history (OUTBOX_RETENTION_DAYS in retention.ts), so it
// is not in RETENTION_TARGETS, which is swept with one seven-day cutoff.
export const OUTBOX_RETENTION_TARGETS: RetentionTarget[] = [
	{ name: 'DigestOutbox', keyField: 'id', tsField: 'createdAt', table: purgeable(DigestOutboxes) },
];
