# Sightline — Pinned Shopify API Contract (Spike D)

- Status: **Accepted** (Phase 0, Spike D — GitHub issue #3)
- Date: 2026-08-04
- Scope: the read-only "Record" MVP (orders → fulfillment → inventory → refunds)
- **Re-verify every versioned detail at implementation start** — Shopify ships quarterly and PCD rules tighten over time (see §8). This document is the pinned baseline, not a substitute for re-checking `shopify.dev` at build time.

## 1. Admin API version

- **Pin `2026-07`** — the current stable (Latest) Admin API version as of August 2026 (released 2026-07-01, supported until ~2027-07-16).
- Cadence: a new version each quarter (Jan/Apr/Jul/Oct); each supported ≥12 months with ≥9 months overlap.
- **Maintenance obligation:** app-specific webhook subscriptions are pinned to the `[webhooks] api_version` in `shopify.app.toml`, which fixes payload shape. On deprecation Shopify "falls forward" to the oldest still-supported version, which can silently change payloads and can lead to App Store delisting. **We must bump `api_version` and redeploy each cycle** — track as a recurring maintenance task.

## 2. Access scopes (minimal read set)

Request only:

| Scope | Why |
|---|---|
| `read_orders` | orders (paid/updated/cancelled) and refunds topics; also grants Fulfillment + Refund object reads (60-day window) |
| `read_fulfillments` | required to subscribe to the `fulfillments/*` topics |
| `read_inventory` | inventory level updates |
| `read_products` | Admin API read to resolve an inventory item's product/variant title for display (`InventoryItem.variant.product.title`, `InventoryItem.variant.title`) — inventory webhooks carry only an id and a quantity |
| `read_locations` | Admin API read to resolve a location's name for display (`locations { nodes { name } }`) — fulfillment/inventory events carry only a `location_id` |

**No write scopes.** **Do NOT request `read_all_orders`** — the MVP needs only a rolling 7-day window, which sits well inside Shopify's default **60-day** order-access window; `read_all_orders` adds a Shopify approval gate and access risk for no benefit.

`read_products` and `read_locations` are **read-only Admin API reads, not webhook subscriptions** — no product or location webhook topic is subscribed, and neither scope adds a customer identifier (both stay PCD Level 1 — see §5). Customers and returns remain out of scope entirely; nothing about them is requested or read.

## 3. Webhook topics → scopes → payload minimization

App-specific subscriptions (declared in `shopify.app.toml`). `include_fields` is a **whitelist** — Shopify serializes and sends *only* the listed top-level fields (null = all). We use it to avoid receiving customer PII (see §5).

| Domain | Topic(s) | Scope | `include_fields` (non-PII whitelist — re-verify names against 2026-07 payloads) |
|---|---|---|---|
| Orders | `orders/create`, `orders/paid`, `orders/updated`, `orders/cancelled` | `read_orders` | `id`, `admin_graphql_api_id`, `name`, `order_number`, `created_at`, `updated_at`, `processed_at`, `cancelled_at`, `closed_at`, `confirmed`, `financial_status`, `fulfillment_status`, `currency`, `total_price`, `current_total_price`, `line_items` |
| Fulfillment | `fulfillments/create`, `fulfillments/update` | `read_fulfillments` | `id`, `admin_graphql_api_id`, `order_id`, `status`, `shipment_status`, `location_id`, `created_at`, `updated_at`, `tracking_company`, `tracking_numbers`, `line_items` — **exclude `destination`** (address) |
| Inventory | `inventory_levels/update` | `read_inventory` | `inventory_item_id`, `location_id`, `available`, `updated_at` |
| Refunds | `refunds/create` | `read_orders` | `id`, `admin_graphql_api_id`, `order_id`, `created_at`, `processed_at`, `refund_line_items`, `transactions` — **exclude `note`** (free text) |

| Topic | Added fields | Why | PCD level |
|---|---|---|---|
| `orders/*` | `total_price`, `current_total_price` | Order value, so a merchant can triage unconfirmed orders by exposure rather than by row order. Money amounts carry no customer identifier. | Level 1 |
| `fulfillments/*` | `location_id` | Which location shipped, so a multi-location merchant can see whether one location is the source of missing confirmations. | Level 1 |

Notes:
- `line_items` carries `sku`, `quantity`, `fulfillable_quantity`, `requires_shipping`, `fulfillment_status`, and product `title` — all Level 1 (not customer PII), and exactly the detector/evidence facts we store.
- There **is** a dedicated `refunds/create` topic — refunds are captured directly, not derived from `orders/updated`.
- `orders/create` is included so the ledger sees an order before payment; the detector's expectation is created on `orders/paid` (or reconciled paid state).

## 4. App-lifecycle & mandatory compliance webhooks (no scope)

`app/uninstalled` and the three privacy webhooks require **no access scope**. The compliance webhooks are **mandatory for any App-Store app** and are declared in a separate block:

```toml
[webhooks.privacy_compliance]
customer_data_request_url = "https://<host>/webhooks/shopify/compliance/customers/data_request"
customer_deletion_url     = "https://<host>/webhooks/shopify/compliance/customers/redact"
shop_deletion_url         = "https://<host>/webhooks/shopify/compliance/shop/redact"
```

- `customers/data_request` — provide the customer's stored data to the merchant.
- `customers/redact` — delete a customer's data (Shopify delays if they ordered in the last 6 months).
- `shop/redact` — erase a shop's data ~48h after uninstall.

These pair with the ADR-003 purge/redaction mechanism (targeted `DELETE` by shop/customer key, idempotent).

## 5. Protected Customer Data (PCD): Level 1 only

**Orders, fulfillments, and refunds are classified as protected customer data**, so subscribing requires PCD approval — **Level 1 is required even though we never use the PII fields.**

- **Level 1** = all customer-related data *excluding* name, address, phone, email.
- **Level 2** = name, email, phone, address (billing + shipping: address1/2, geolocation, zip). **We do not request Level 2.**

**Everything Sightline stores is Level 1:** ids, statuses (`financial_status`, `fulfillment_status`), timestamps, SKU/quantity, and fulfillment tracking evidence. We explicitly do **not** store customer name, email, phone, or address.

**Triple protection against PII:** (a) without Level 2 approval, Shopify redacts PII from webhook payloads anyway; (b) our `include_fields` whitelists exclude PII fields so they are never sent; (c) ingress stores only those fields, and inside `line_items`/`refund_line_items` only the SKU and quantity fields the normalizer reads (`app/src/privacy/pii.ts`, kept equal to `shopify.app.toml` by a test), so a drifted subscription or a new Shopify field is not stored. `line_items[].properties` (customer-typed text) is never stored. Webhooks carry no PII to begin with; the two Admin API reads we do make (§6, `read_products`/`read_locations`) resolve product/variant/location **names**, never a customer field.

Money amounts (`total_price`, `current_total_price`, `currency`) and operational identifiers (`location_id`, `tracking_company`, `tracking_numbers`) are order facts, not customer identifiers, and remain inside Level 1. Product and variant titles (`read_products`) and location names (`read_locations`) are likewise order/catalog facts, not customer identifiers, and remain inside Level 1. No Level 2 identifier is requested.

### Level 1 approval checklist (Partner Dashboard → API Access → Protected Customer Data Access)

1. Process only the **minimum** data required (our minimal field set favors approval).
2. **Inform merchants** what data we process and why (privacy disclosure / app-health screen).
3. Limit processing to **stated purposes** (operational recording + absence detection).
4. Respect customer **consent** / **opt-out** where applicable.
5. Provide an opt-out if used for automated decisions (n/a — no automated decisions about customers).
6. **Data-protection agreement** with merchants.
7. **Retention periods** — 7-day window enforced by the ADR-003 purge.
8. **Encrypt at rest and in transit** — tokens in Harper native secrets (ADR-001); TLS.

Declare in the PCDA form: which protected data we use + reasons; Data-protection details attestation. (We select **no** Level 2 fields, so the per-field justification and the heavier Level-2 controls — DLP, backup encryption attestation, staff access logging, etc. — do not apply.)

## 6. Domain → detector mapping (why these fields)

- **Paid state:** `orders/paid` / `financial_status` → creates the detector expectation.
- **Fulfillment eligibility:** `line_items.requires_shipping` / `fulfillable_quantity`.
- **Suppression:** `cancelled_at`, fully-refunded (via `refunds/create` + `refund_line_items`), already-fulfilled (`fulfillment_status`).
- **Confirmation evidence:** `fulfillments/create|update` `status` + tracking.
- **Inventory lane / refund context:** `inventory_levels/update`, `refunds/create`.

### Admin API reads

| Query | Fields | Why | Scope |
|---|---|---|---|
| `orders(query: "updated_at:>=…", sortKey: UPDATED_AT)` | `id createdAt updatedAt cancelledAt displayFinancialStatus displayFulfillmentStatus lineItems{quantity requiresShipping} fulfillments{status createdAt}` | Gap-fill for missed webhooks + install backfill (#13) | `read_orders`, `read_fulfillments` |
| `shop { ianaTimezone }` | `ianaTimezone` | Render merchant-facing timestamps in the store's configured timezone (screen spec). Cached once per install; **display only** — a failure never blocks reconciliation. Shop-level setting, **not** protected customer data. | none beyond the above |
| `shop { name }` | `name` | Liveness probe that the offline token works | none beyond the above |
| `nodes(ids: […]) { … on InventoryItem { id sku variant { title product { title } } } }` | `id`, `sku`, `variant.title`, `variant.product.title` | An `inventory_levels/update` webhook carries only `inventory_item_id` and a quantity, which is unreadable to a merchant and unsearchable by SKU. Periodic background sweep (not reconciliation) resolves unseen item ids into the SKU/product/variant title shown in the UI. Product/variant title is order-fact product data, not a customer identifier — Level 1. | `read_products` |
| `locations(first: 100) { nodes { id name } }` | `id`, `name` | Resolves a `location_id` (from `fulfillments/*`/`inventory_levels/update`) to a human-readable location name for the UI. Small, slow-changing set cached once per shop. | `read_locations` |

## 7. `shopify.app.toml` sketch (illustrative — not the final config)

```toml
[webhooks]
api_version = "2026-07"

  [[webhooks.subscriptions]]
  topics = ["orders/create", "orders/paid", "orders/updated", "orders/cancelled"]
  uri = "https://<host>/webhooks/shopify/events"
  include_fields = ["id","admin_graphql_api_id","name","order_number","created_at","updated_at","processed_at","cancelled_at","closed_at","confirmed","financial_status","fulfillment_status","currency","line_items"]

  [[webhooks.subscriptions]]
  topics = ["fulfillments/create", "fulfillments/update"]
  uri = "https://<host>/webhooks/shopify/events"
  include_fields = ["id","admin_graphql_api_id","order_id","status","shipment_status","created_at","updated_at","tracking_company","tracking_numbers","line_items"]

  [[webhooks.subscriptions]]
  topics = ["inventory_levels/update"]
  uri = "https://<host>/webhooks/shopify/events"
  include_fields = ["inventory_item_id","location_id","available","updated_at"]

  [[webhooks.subscriptions]]
  topics = ["refunds/create"]
  uri = "https://<host>/webhooks/shopify/events"
  include_fields = ["id","admin_graphql_api_id","order_id","created_at","processed_at","refund_line_items","transactions"]

[webhooks.privacy_compliance]
customer_data_request_url = "https://<host>/webhooks/shopify/compliance/customers/data_request"
customer_deletion_url     = "https://<host>/webhooks/shopify/compliance/customers/redact"
shop_deletion_url         = "https://<host>/webhooks/shopify/compliance/shop/redact"
```

## 8. Re-verify before launch (open items)

- Confirm `2026-07` is still the version to pin at build time (or move to the then-current stable); set the quarterly bump reminder.
- Re-verify exact **payload field names** per topic against the 2026-07 webhook payload schemas (webhook JSON is REST-style; names above are the expected set).
- Re-verify the **`WebhookSubscriptionTopic` required-scope lines** for each topic at build time.
- Re-verify **PCD Level 1/2 field boundaries** and the `include_fields`↔redaction behavior in the live Partner Dashboard PCDA form (Shopify has tightened PCD gating across 2024–2025).
- Confirm whether `orders/create` is needed or whether starting at `orders/paid` is sufficient (reduces volume) — decide with dev-store data.

## 9. Sources

- API versioning (cadence, support, fall-forward): https://shopify.dev/docs/api/usage/versioning
- Access scopes / `read_all_orders` / 60-day window: https://shopify.dev/docs/api/usage/access-scopes
- Webhook topics + per-topic scopes: https://shopify.dev/docs/api/admin-graphql/latest/enums/WebhookSubscriptionTopic
- Subscribe / `include_fields` / `filter` in `shopify.app.toml`: https://shopify.dev/docs/apps/build/webhooks/subscribe
- Delivery/field filtering: https://shopify.dev/docs/apps/build/webhooks/customize/filters
- Protected customer data (L1/L2, approval): https://shopify.dev/docs/apps/launch/protected-customer-data
- Privacy-law compliance (mandatory webhooks): https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
