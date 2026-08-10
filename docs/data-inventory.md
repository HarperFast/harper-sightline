# Sightline Data Inventory (privacy webhook behavior)

Maps every stored table/field to its **data-subject-request**, **export**, and **deletion** behavior for the Shopify mandatory privacy webhooks (issue #21). See `docs/shopify-contract.md` §5 for the PCD Level-1 boundary and `docs/adr/ADR-003-retention-deletion.md` for the deletion mechanism.

## Headline

**Sightline stores no customer PII** — no customer name, email, phone, or address (PCD Level 1 only; `include_fields` + PII stripping enforce this). Therefore `customers/data_request` has **nothing to export**. Data is keyed by `shopId` (tenant) and, for order-linked rows, by `orderId` — the only customer-scoped key we hold.

No field added in Plan A is a customer identifier. Money amounts, SKUs, product & variant titles, locations, and tracking presence & carrier are Level 1 order facts; the customer-field exclusion list is unchanged.

The notification address is merchant contact data, disclosed on the Privacy screen and in the public policy. The customer-field exclusion list is unchanged, and `storesCustomerPii` remains false.

## Retention

- **`sightline_ledger.*`** (WebhookDelivery, OperationalEvent, EventSku, OrderProjection, Expectation, GapFinding, FlowAggregate): purged after **7 days** by the explicit-DELETE retention job (ADR-003). `EventSku` shares its retention key (`receivedAt`) with the `OperationalEvent` it indexes.
- **`sightline_core.*`** (Shop, ShopCredential, AppAuditEvent) and `WorkerCheckpoint`: install-time / operational state, retained while installed; erased on `shop/redact`.
- **Admin API reference caches** (`InventoryItem`, `ShopLocation`): deliberately NOT part of the 7-day ledger purge — they carry no order or customer linkage and are useless once the shop is gone, so they are retained while installed and erased only on `shop/redact` (re-fetching them on a schedule would be pointless Admin API traffic).
- **`sightline_core.DigestOutbox`**: a **separate, 30-day** purge, longer than the 7-day ledger cutoff on purpose — a row is a record of what a period looked like (its counts and subject line, never the message), worth keeping after the events it describes have already aged out of the ledger. It holds no order name and no customer data (Task 3 removed the rendered `bodyText`/`bodyHtml` from the row for exactly this reason). `DigestSubscription` (the address itself) is not aged out at all; it is deleted only on clear, uninstall, or `shop/redact`. Both are erased by `shop/redact` regardless of age. See "Plan C additions" below.

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
| `DigestSubscription` | No (merchant's own contact address, not customer PII) | — (not order-linked) | none | — (not customer-linked) | delete by `shopId` |
| `DigestOutbox` | No (counts and a subject line only — no order names, no message body) | — (not order-linked; a digest spans a whole period, not one order) | none | — (not customer-linked) | delete by `shopId` |

## Plan A additions (2026-08-07)

Fields and tables added while extracting operational facts that were previously discarded (order value, tracking, location, product/variant identity) and while fixing the SKU-search defect. Every entry below is Shopify Protected Customer Data **Level 1** (order-scoped operational facts) — none is a customer identifier.

| Table | Field(s) | Purpose | Retention |
|---|---|---|---|
| `OperationalEvent` | `orderName`, `totalPrice`, `currency` | Merchant-readable order identity and value for triage | 7-day purge |
| `OperationalEvent` | `locationId`, `hasTracking`, `trackingCompany`, `shipmentStatus` | Fulfillment context: where it shipped from, whether tracking exists | 7-day purge |
| `OrderProjection` | `orderName`, `orderTotal`, `currency`, `fulfillmentFailedAt`, `hasTracking`, `trackingCompany`, `trackingAt` | Latched order facts for detection and display | 7-day purge |
| `GapFinding` | `detector` | Distinguishes which detector produced a finding. The column existed alongside the single confirmation detector; this plan's `fulfillment_attempt_failed` detector (Task 7) is what makes a second value real | 7-day purge |
| `EventSku` | all | SKU→event index enabling SKU search (fixes the defect where the SKU column and filter always returned nothing) | 7-day purge (shares `receivedAt` with its event) |
| `InventoryItem` | all (`sku`, `productTitle`, `variantTitle`) | Admin API cache: inventory item id → SKU/product/variant title, so an inventory event is readable instead of an opaque number | Erased on uninstall/shop-redact; not aged out |
| `ShopLocation` | all | Admin API cache: location id → location name | Erased on uninstall/shop-redact; not aged out |

## Plan C additions (2026-08-07)

The operations digest (build-only; there is no sender yet — see the "digest-not-building" runbook). Introduces the **first and only merchant-identifying string** Sightline stores: a notification email address, which is the merchant's own contact, not customer data.

| Table | Field(s) | Purpose | Retention |
|---|---|---|---|
| `DigestSubscription` | `email`, `cadence`, `status`, `lastBuiltAt` | Merchant-supplied notification address and frequency. **The only merchant-identifying string stored.** Not customer data. | Deleted on clear, uninstall, or shop-redact; not aged out |
| `DigestOutbox` | `subject`, counts | A durable record of what a period looked like, addressed by `shopId` only, kept after the ledger purges the events it describes. Holds no body: **no `bodyText`/`bodyHtml` column exists** (Task 3 removed them — the message is rendered fresh by a future sender instead of read back from a row), so the row names no order and holds no customer data. Also **no copy of the notification address**: a sender reads that from the subscription when it sends, so clearing the address or uninstalling really does erase it rather than leaving copies to age out with the outbox. | 30-day purge; erased on uninstall/shop-redact |

Two retention windows now apply, and both are disclosed everywhere retention is mentioned (the Privacy screen, the public policy, and this document): the ledger's 7-day purge, and the digest outbox's separate 30-day purge. The outbox deliberately outlives the ledger — a digest row is a record of what a period looked like, worth keeping after the events it describes have aged out, not a copy of the message that would have been sent.

## Guarantees

- **`shop/redact`** erases every `shopId`-scoped row (ledger + core) via targeted DELETE, then re-queries to verify zero residue (`redactShop`).
- **`customers/redact`** removes rows linked to the `orders_to_redact` order ids for the shop, verified (`redactOrders`). Inventory events (keyed by `inventory_item_id`, not an order) are correctly untouched.
- **Retry-safe:** redaction is idempotent (delete-by-condition); each compliance action writes an audit event keyed by the webhook id, so a Shopify retry upserts rather than duplicates.
- **Invalid HMAC → 401 with no mutation** (verification precedes dispatch).
