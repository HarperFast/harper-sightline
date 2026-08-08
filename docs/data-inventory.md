# Sightline Data Inventory (privacy webhook behavior)

Maps every stored table/field to its **data-subject-request**, **export**, and **deletion** behavior for the Shopify mandatory privacy webhooks (issue #21). See `docs/shopify-contract.md` §5 for the PCD Level-1 boundary and `docs/adr/ADR-003-retention-deletion.md` for the deletion mechanism.

## Headline

**Sightline stores no customer PII** — no customer name, email, phone, or address (PCD Level 1 only; `include_fields` + PII stripping enforce this). Therefore `customers/data_request` has **nothing to export**. Data is keyed by `shopId` (tenant) and, for order-linked rows, by `orderId` — the only customer-scoped key we hold.

No field added in Plan A is a customer identifier. Money amounts, SKUs, product titles, locations, and tracking presence are Level 1 order facts; the customer-field exclusion list is unchanged.

## Retention

- **`sightline_ledger.*`** (WebhookDelivery, OperationalEvent, EventSku, OrderProjection, Expectation, GapFinding, FlowAggregate): purged after **7 days** by the explicit-DELETE retention job (ADR-003). `EventSku` shares its retention key (`receivedAt`) with the `OperationalEvent` it indexes.
- **`sightline_core.*`** (Shop, ShopCredential, AppAuditEvent) and `WorkerCheckpoint`: install-time / operational state, retained while installed; erased on `shop/redact`.
- **Admin API reference caches** (`InventoryItem`, `ShopLocation`): deliberately NOT part of the 7-day ledger purge — they carry no order or customer linkage and are useless once the shop is gone, so they are retained while installed and erased only on `shop/redact` (re-fetching them on a schedule would be pointless Admin API traffic).

## Behavior per table

| Table | Contains customer PII? | Customer-linked key | `customers/data_request` | `customers/redact` | `shop/redact` |
|---|---|---|---|---|---|
| `Shop` | No | — | none | — (not customer-linked) | delete by `shopId` |
| `ShopCredential` | No (encrypted app token) | — | none | — | delete by `shopId` |
| `AppAuditEvent` | No | — | none | — | delete by `shopId` |
| `WebhookDelivery` | No (PII-stripped body, 7-day) | — | none | — | delete by `shopId` |
| `OperationalEvent` | No | `resourceId` (=orderId) | none | delete where `resourceId ∈ orders_to_redact` | delete by `shopId` |
| `EventSku` | No | `resourceId` (=orderId) | none | delete where `resourceId ∈ orders_to_redact` | delete by `shopId` |
| `OrderProjection` | No | `orderId` | none | delete where `orderId ∈ orders_to_redact` | delete by `shopId` |
| `Expectation` | No | `orderId` | none | delete where `orderId ∈ orders_to_redact` | delete by `shopId` |
| `GapFinding` | No | `orderId` | none | delete where `orderId ∈ orders_to_redact` | delete by `shopId` |
| `FlowAggregate` | No | — | none | — | delete by `shopId` |
| `WorkerCheckpoint` | No | — | none | — | (global worker state; no tenant data) |
| `InventoryItem` | No (reference cache, keyed by `inventory_item_id`) | — (not order-linked) | none | — (not order-linked) | delete by `shopId` |
| `ShopLocation` | No (reference cache) | — (not order-linked) | none | — (not order-linked) | delete by `shopId` |

## Plan A additions (2026-08-07)

Fields and tables added while extracting operational facts that were previously discarded (order value, tracking, location, product/variant identity) and while fixing the SKU-search defect. Every entry below is Shopify Protected Customer Data **Level 1** (order-scoped operational facts) — none is a customer identifier.

| Table | Field(s) | Purpose | Retention |
|---|---|---|---|
| `OperationalEvent` | `orderName`, `totalPrice`, `currency` | Merchant-readable order identity and value for triage | 7-day purge |
| `OperationalEvent` | `locationId`, `hasTracking`, `trackingCompany`, `shipmentStatus` | Fulfillment context: where it shipped from, whether tracking exists | 7-day purge |
| `OrderProjection` | `orderName`, `orderTotal`, `currency`, `fulfillmentFailedAt`, `hasTracking`, `trackingCompany`, `trackingAt` | Latched order facts for detection and display | 7-day purge |
| `GapFinding` | `detector` | Which detector produced the finding | 7-day purge |
| `EventSku` | all | SKU→event index enabling SKU search (fixes the defect where the SKU column and filter always returned nothing) | 7-day purge (shares `receivedAt` with its event) |
| `InventoryItem` | all (`sku`, `productTitle`, `variantTitle`) | Admin API cache: inventory item id → SKU/product/variant title, so an inventory event is readable instead of an opaque number | Erased on uninstall/shop-redact; not aged out |
| `ShopLocation` | all | Admin API cache: location id → location name | Erased on uninstall/shop-redact; not aged out |

## Guarantees

- **`shop/redact`** erases every `shopId`-scoped row (ledger + core) via targeted DELETE, then re-queries to verify zero residue (`redactShop`).
- **`customers/redact`** removes rows linked to the `orders_to_redact` order ids for the shop, verified (`redactOrders`). Inventory events (keyed by `inventory_item_id`, not an order) are correctly untouched.
- **Retry-safe:** redaction is idempotent (delete-by-condition); each compliance action writes an audit event keyed by the webhook id, so a Shopify retry upserts rather than duplicates.
- **Invalid HMAC → 401 with no mutation** (verification precedes dispatch).
