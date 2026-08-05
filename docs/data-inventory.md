# Sightline Data Inventory (privacy webhook behavior)

Maps every stored table/field to its **data-subject-request**, **export**, and **deletion** behavior for the Shopify mandatory privacy webhooks (issue #21). See `docs/shopify-contract.md` §5 for the PCD Level-1 boundary and `docs/adr/ADR-003-retention-deletion.md` for the deletion mechanism.

## Headline

**Sightline stores no customer PII** — no customer name, email, phone, or address (PCD Level 1 only; `include_fields` + PII stripping enforce this). Therefore `customers/data_request` has **nothing to export**. Data is keyed by `shopId` (tenant) and, for order-linked rows, by `orderId` — the only customer-scoped key we hold.

## Retention

- **`sightline_ledger.*`** (WebhookDelivery, OperationalEvent, OrderProjection, Expectation, GapFinding, FlowAggregate): purged after **7 days** by the explicit-DELETE retention job (ADR-003).
- **`sightline_core.*`** (Shop, ShopCredential, AppAuditEvent) and `WorkerCheckpoint`: install-time / operational state, retained while installed; erased on `shop/redact`.

## Behavior per table

| Table | Contains customer PII? | Customer-linked key | `customers/data_request` | `customers/redact` | `shop/redact` |
|---|---|---|---|---|---|
| `Shop` | No | — | none | — (not customer-linked) | delete by `shopId` |
| `ShopCredential` | No (encrypted app token) | — | none | — | delete by `shopId` |
| `AppAuditEvent` | No | — | none | — | delete by `shopId` |
| `WebhookDelivery` | No (PII-stripped body, 7-day) | — | none | — | delete by `shopId` |
| `OperationalEvent` | No | `resourceId` (=orderId) | none | delete where `resourceId ∈ orders_to_redact` | delete by `shopId` |
| `OrderProjection` | No | `orderId` | none | delete where `orderId ∈ orders_to_redact` | delete by `shopId` |
| `Expectation` | No | `orderId` | none | delete where `orderId ∈ orders_to_redact` | delete by `shopId` |
| `GapFinding` | No | `orderId` | none | delete where `orderId ∈ orders_to_redact` | delete by `shopId` |
| `FlowAggregate` | No | — | none | — | delete by `shopId` |
| `WorkerCheckpoint` | No | — | none | — | (global worker state; no tenant data) |

## Guarantees

- **`shop/redact`** erases every `shopId`-scoped row (ledger + core) via targeted DELETE, then re-queries to verify zero residue (`redactShop`).
- **`customers/redact`** removes rows linked to the `orders_to_redact` order ids for the shop, verified (`redactOrders`). Inventory events (keyed by `inventory_item_id`, not an order) are correctly untouched.
- **Retry-safe:** redaction is idempotent (delete-by-condition); each compliance action writes an audit event keyed by the webhook id, so a Shopify retry upserts rather than duplicates.
- **Invalid HMAC → 401 with no mutation** (verification precedes dispatch).
