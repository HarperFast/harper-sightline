import { Shops, Credentials, AuditEvents, Deliveries, Events, Projections, Expectations, Findings, Aggregates } from './db.ts';
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
	{ name: 'OrderProjection', keyField: 'id', shopField: 'shopId', orderField: 'orderId', table: purgeable(Projections) },
	{ name: 'Expectation', keyField: 'id', shopField: 'shopId', orderField: 'orderId', table: purgeable(Expectations) },
	{ name: 'GapFinding', keyField: 'id', shopField: 'shopId', orderField: 'orderId', table: purgeable(Findings) },
	{ name: 'FlowAggregate', keyField: 'id', shopField: 'shopId', table: purgeable(Aggregates) },
	{ name: 'Shop', keyField: 'shopId', shopField: 'shopId', table: purgeable(Shops) },
	{ name: 'ShopCredential', keyField: 'shopId', shopField: 'shopId', table: purgeable(Credentials) },
	{ name: 'AppAuditEvent', keyField: 'id', shopField: 'shopId', table: purgeable(AuditEvents) },
];
