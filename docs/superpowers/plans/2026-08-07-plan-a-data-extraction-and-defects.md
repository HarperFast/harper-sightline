# Plan A — Data Extraction & Defect Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the operational facts Sightline already receives but discards (order name, order value, tracking, fulfillment location, SKUs), latch failed fulfillment attempts and ship a second detector for them, enrich inventory events into readable SKU/location facts, and correct the four defects found in the product review.

**Architecture:** All work is behind the existing capture pipeline — `normalize.ts` (payload → `OperationalEvent`), `projection.ts` (events → `OrderProjection` latches), `detector.ts` (projection → `Expectation`/`GapFinding`). Nothing here adds a read screen (that is Plan B) or a write to Shopify. Two new reference tables (`InventoryItem`, `ShopLocation`) cache Admin API lookups so inventory rows become interpretable, and one new index table (`EventSku`) makes the SKU filter genuinely work instead of silently matching nothing.

**Tech Stack:** Harper v5 native application (TypeScript via TypeStrip, `.ts` import extensions), GraphQL schema DSL for tables, `node:test` + `node:assert/strict`, zero runtime dependencies.

## Global Constraints

Every task's requirements implicitly include this section.

- **Zero runtime dependencies.** `app/package.json` has `devDependencies` only. Do not add a runtime dep for any reason.
- **All tables are `@table @sealed` and PRIVATE.** Never add `@export` to a table.
- **Epoch-ms timestamps are GraphQL `Float`**, never `Int` (GraphQL `Int` is 32-bit — Spike C).
- **No customer PII, ever.** Never store customer name, email, phone, or address. The `PII_KEYS` denylist in `app/src/pii.ts` strips them at every nesting level before storage. Order `name` (`#1001`), line-item `title`/`sku`, and money amounts are Level 1 evidence, not PII.
- **Every query derives `shopId` from the authenticated principal, never from caller input.** Every new table carries `shopId: String! @indexed` and every search constrains on it.
- **Response fields must be allowlisted** in `app/src/apiContract.ts`, then `npm run contract:gen` must be re-run — `test/contract.test.ts` fails CI if `contracts/sightline-api-v1.json` drifts.
- **Non-accusatory copy for absence findings.** `FINDING_DISCLAIMER` in `app/web/src/view.ts` is verbatim from the screen spec: *"This does not prove that a warehouse or carrier failed. It means Shopify has not shown the expected fulfillment confirmation yet."* Do not reword it. Do **not** attach it to the new presence-based detector, where it would be false.
- **The projection reducer must stay commutative and idempotent.** `applyEvent` uses monotonic latches only (earliest-timestamp / max). Every new field must satisfy rebuild equality: folding an order's events in any sequence yields identical state. No counters, no "latest value wins" strings.
- **Log via `log()` from `app/src/observe.ts`.** `console.*` is invisible to Harper's `read_log`. Never log payloads, tokens, or merchant-identifying labels on metrics.
- **Formatting:** tabs for indentation. `npm run format:check` and `npm run lint:required` must pass.
- **After any schema change to a `@sealed` table, verify with `describe_table` after deploying.** `deploy_component` has intermittently dropped a newly-added column on an existing sealed table; `scripts/deploy.mjs` self-heals known cases. Redeploy if a column is missing.
- **Git:** work on a branch, squash-merge, **never assign PR reviewers**. Commit message prefixes: `feat(scope):` / `fix(scope):` / `docs:`.

---

## File Structure

**Created:**
- `app/src/eventSkus.ts` — pure builder for `EventSku` index rows from an event + its SKU list. One responsibility: the event↔SKU fan-out and its cap.
- `app/src/inventoryEnrich.ts` — pure planning + shaping for inventory enrichment (which item ids are unresolved, how an Admin API node maps to an `InventoryItem` row). The I/O loop lives in `jobs.ts`.
- `app/test/fakeTable.test.ts` — covers the write methods added to the shared test harness.
- `app/test/eventSkus.test.ts`
- `app/test/inventoryEnrich.test.ts`

**Modified:**
- `app/schema.graphql` — new fields on `OperationalEvent`, `OrderProjection`, `GapFinding`; new `EventSku`, `InventoryItem`, `ShopLocation` tables.
- `app/src/model.ts` — TypeScript mirror of the above.
- `app/src/normalize.ts` — extract the discarded fields.
- `app/src/projection.ts` — new monotonic latches.
- `app/src/detector.ts` — second detector (`fulfillment_attempt_failed`).
- `app/src/adminApi.ts` — inventory item + location reads.
- `app/src/db.ts` — table handles for the three new tables.
- `app/src/ledgerTargets.ts` — retention + redaction targets for the new tables.
- `app/src/queries.ts` — SKU-filtered event path, event-detail location name, truthful privacy disclosure.
- `app/src/apiContract.ts` — field allowlists.
- `app/jobs.ts` — write `EventSku` rows, run both detectors, inventory enrichment loop.
- `app/test/fakeTable.ts` — add `put`/`patch`.
- `app/test/fixtures/2026-07/*.json` — add the newly whitelisted payload fields.
- `app/shopify.app.toml` — widen `include_fields`.
- `docs/shopify-contract.md`, `docs/data-inventory.md` — record the contract + inventory changes.

---

### Task 1: Test harness — `FakeTable` gains `put` and `patch`

The shared in-memory table only implements `search`/`get`/`delete`, so every write-path test so far had to hand-roll its own fake. Tasks 5–8 all test write paths; give them one harness.

**Files:**
- Modify: `app/test/fakeTable.ts:7-67`
- Test: `app/test/fakeTable.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `FakeTable.put(record: Record<string, unknown>): Promise<void>` (upsert by the constructor's `keyField`), `FakeTable.patch(id: string, partial: Record<string, unknown>): Promise<void>` (shallow merge; no-op when the row is absent, matching Harper's tolerance in `Deliveries.patch` call sites).

- [ ] **Step 1: Write the failing test**

Create `app/test/fakeTable.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTable } from './fakeTable.ts';

test('put upserts by key field and stores a copy', async () => {
	const table = new FakeTable('id');
	const record = { id: 'a', n: 1 };
	await table.put(record);
	record.n = 99; // mutating the caller's object must not affect the stored row
	assert.deepEqual(await table.get('a'), { id: 'a', n: 1 });

	await table.put({ id: 'a', n: 2 });
	assert.deepEqual(await table.get('a'), { id: 'a', n: 2 });
	assert.equal(table.rows.size, 1);
});

test('patch shallow-merges an existing row and ignores a missing one', async () => {
	const table = new FakeTable('id', [{ id: 'a', n: 1, keep: true }]);
	await table.patch('a', { n: 5 });
	assert.deepEqual(await table.get('a'), { id: 'a', n: 5, keep: true });

	await table.patch('missing', { n: 1 });
	assert.equal(await table.get('missing'), undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && node --test test/fakeTable.test.ts`
Expected: FAIL — `table.put is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `app/test/fakeTable.ts`, add these two methods to the `FakeTable` class, immediately after `get`:

```typescript
	// Upsert by the configured key field. Stores a copy so a caller mutating its
	// input afterwards cannot change persisted state (Harper serializes on write).
	async put(record: Record<string, unknown>): Promise<void> {
		this.rows.set(String(record[this.keyField]), { ...record });
	}

	// Shallow merge into an existing row. A missing row is a no-op, matching how
	// the production call sites treat patch (they only patch rows they just read).
	async patch(id: string, partial: Record<string, unknown>): Promise<void> {
		const row = this.rows.get(id);
		if (row) this.rows.set(id, { ...row, ...partial });
	}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && node --test test/fakeTable.test.ts`
Expected: PASS, 2 tests.

Run: `cd app && npm test`
Expected: PASS — the full suite (205 tests before this task) still green.

- [ ] **Step 5: Commit**

```bash
git add app/test/fakeTable.ts app/test/fakeTable.test.ts
git commit -m "test: FakeTable supports put/patch for write-path tests"
```

---

### Task 2: Widen the webhook payload contract

Order value and fulfillment location are not in the current `include_fields` whitelists, so they never arrive. Everything else this plan extracts (`name`, `order_number`, `currency`, `line_items`, `tracking_company`, `tracking_numbers`, `location_id` on inventory) **already arrives and is already discarded** — this task only adds what is genuinely absent.

All added fields are Level 1 protected customer data (order facts and money amounts, no customer identifiers), consistent with the granted PCD Level 1 approval. This task changes the released app config, so it must be reviewed as a deliberate pre-submission change.

**Files:**
- Modify: `shopify.app.toml:33` (orders subscription `include_fields`), `shopify.app.toml:38` (fulfillments subscription `include_fields`)
- Modify: `docs/shopify-contract.md` §3 (topics → payload minimization table), §5 (PCD Level 1 field justification)
- Modify: `app/test/fixtures/2026-07/orders_create.json`, `orders_paid.json`, `orders_updated.json`, `orders_cancelled.json`, `fulfillments_create.json`, `fulfillments_update.json`, `refunds_create.json`, `inventory_levels_update.json`

**Interfaces:**
- Consumes: nothing.
- Produces: payload fields the Task 4 normalizers read — orders: `name`, `order_number`, `currency`, `total_price`, `current_total_price`, `line_items[].sku`, `line_items[].quantity`, `line_items[].requires_shipping`; fulfillments: `location_id`, `tracking_company`, `tracking_numbers`, `shipment_status`, `line_items[].sku`; refunds: `refund_line_items[].line_item.sku`, `refund_line_items[].quantity`; inventory: `location_id`.

- [ ] **Step 1: Add the two missing order money fields**

In `shopify.app.toml`, the orders subscription's `include_fields` becomes (add `total_price` and `current_total_price`; everything else is unchanged):

```toml
  include_fields = [ "id", "admin_graphql_api_id", "name", "order_number", "created_at", "updated_at", "processed_at", "cancelled_at", "closed_at", "confirmed", "financial_status", "fulfillment_status", "currency", "total_price", "current_total_price", "line_items" ]
```

- [ ] **Step 2: Add fulfillment location and shipment status**

In the same file, the fulfillments subscription's `include_fields` becomes (add `location_id` and `shipment_status` — `shipment_status` may already be present; if so, add only `location_id`):

```toml
  include_fields = [ "id", "admin_graphql_api_id", "order_id", "status", "shipment_status", "location_id", "created_at", "updated_at", "tracking_company", "tracking_numbers", "line_items" ]
```

- [ ] **Step 3: Record the contract change in the pinned contract doc**

In `docs/shopify-contract.md` §3, add these rows to the payload-minimization table (match the surrounding table's column layout):

| Topic | Added fields | Why | PCD level |
|---|---|---|---|
| `orders/*` | `total_price`, `current_total_price` | Order value, so a merchant can triage unconfirmed orders by exposure rather than by row order. Money amounts carry no customer identifier. | Level 1 |
| `fulfillments/*` | `location_id` | Which location shipped, so a multi-location merchant can see whether one location is the source of missing confirmations. | Level 1 |

Then, in §5, add one sentence under the Level 1 justification: *"Money amounts (`total_price`, `current_total_price`, `currency`) and operational identifiers (`location_id`, `tracking_company`, `tracking_numbers`) are order facts, not customer identifiers, and remain inside Level 1. No Level 2 identifier is requested."*

- [ ] **Step 4: Add the new fields to the webhook fixtures**

The fixtures are the normalizer's contract tests. **Add fields; never remove any.** Each fixture deliberately carries populated PII containers (`customer`, `billing_address`, `email`, `phone`, …) and `test/normalize.test.ts` asserts that none of the `PII_MARKERS` strings in them (`'example.com'`, `'Jane'`, `'Main St'`, …) survives into a normalized event or a stored payload. Deleting those containers would silently disable the strongest PII test in the suite. For the same reason, none of the values you add below may contain a `PII_MARKERS` string.

In `app/test/fixtures/2026-07/orders_paid.json`, add these keys at the top level (keep every existing key, and give at least two line items with distinct `sku` values so the SKU fan-out in Task 5 has something to test):

```json
	"name": "#1001",
	"order_number": 1001,
	"currency": "USD",
	"total_price": "129.95",
	"current_total_price": "129.95",
	"line_items": [
		{ "id": 1, "sku": "TSHIRT-M-BLK", "title": "T-Shirt M Black", "quantity": 2, "fulfillable_quantity": 2, "requires_shipping": true },
		{ "id": 2, "sku": "STICKER-PK", "title": "Sticker Pack", "quantity": 1, "fulfillable_quantity": 1, "requires_shipping": true }
	]
```

Apply the same `name` / `order_number` / `currency` / `total_price` / `current_total_price` / `line_items` additions to `orders_create.json`, `orders_updated.json`, and `orders_cancelled.json`.

In `fulfillments_create.json` and `fulfillments_update.json`, add:

```json
	"location_id": 987654321,
	"tracking_company": "UPS",
	"tracking_numbers": ["1Z999AA10123456784"],
	"shipment_status": "in_transit",
	"line_items": [{ "id": 1, "sku": "TSHIRT-M-BLK", "quantity": 2 }]
```

In `refunds_create.json`, ensure `refund_line_items` entries carry a nested line item:

```json
	"refund_line_items": [{ "quantity": 1, "line_item": { "id": 1, "sku": "TSHIRT-M-BLK" } }]
```

In `inventory_levels_update.json`, ensure `location_id` is present:

```json
	"location_id": 987654321
```

- [ ] **Step 5: Verify the suite still passes with the widened fixtures**

Run: `cd app && npm test`
Expected: PASS. The normalizers ignore unknown fields by design ("additive-tolerant" — `app/src/normalize.ts:28`), so widening fixtures must not break anything. If any test fails here, it asserted on an exact object shape; update that assertion to the new shape rather than shrinking the fixture.

- [ ] **Step 6: Commit**

```bash
git add shopify.app.toml docs/shopify-contract.md app/test/fixtures
git commit -m "feat(contract): capture order value and fulfillment location (Level 1)"
```

- [ ] **Step 7: Release the subscription change to Shopify**

Run: `shopify app deploy --allow-updates`
Expected: a new app version releases cleanly with no PCD rejection. The CLI rewrites `shopify.app.toml` to match released config — re-read the file afterwards and confirm both `include_fields` lists still contain the added fields. If the CLI reordered or reformatted them, commit that rewrite as-is:

```bash
git add shopify.app.toml && git commit -m "chore(shopify): CLI-normalized app config after deploy"
```

- [ ] **Step 8: Confirm the new fields actually arrive**

Place (or update) a test order on the dev store, then read the stored delivery payload for the resulting `orders/*` delivery and assert `total_price` is present. The payload is stored PII-stripped on `WebhookDelivery.payload`; query it through the ops API the same way the deploy script does (`HARPER_OPS_URL`, `HARPER_USER`, `HARPER_PASS` — see `docs/deployment.md`).

Expected: the stored payload JSON contains `name`, `total_price`, and `currency`. If it does not, the released version did not take — re-run `shopify app deploy --allow-updates` and re-check before starting Task 4, because Task 4's live behavior depends on it. (Unit tests use the fixtures and will pass regardless; do not treat green tests as evidence the release landed.)

---

### Task 3: Schema and model — new fields and tables

One schema change, deployed once, so the sealed-column flake is exercised a single time rather than per task.

**Files:**
- Modify: `app/schema.graphql:65-79` (`OperationalEvent`), `app/schema.graphql:81-98` (`OrderProjection`), `app/schema.graphql:113-123` (`GapFinding`); append three new types
- Modify: `app/src/model.ts:58-71`, `app/src/model.ts:73-89`, `app/src/model.ts:103-112`; append three new interfaces
- Modify: `app/src/db.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the fields and types every later task writes and reads —
  - `OperationalEvent` gains `orderName?: string`, `currency?: string`, `totalPrice?: number`, `locationId?: string`, `trackingCompany?: string`, `hasTracking?: boolean`, `shipmentStatus?: string`.
  - `OrderProjection` gains `orderName?: string`, `orderTotal?: number`, `currency?: string`, `fulfillmentFailedAt?: number`, `hasTracking?: boolean`, `trackingCompany?: string`.
  - `GapFinding` gains `detector?: string`.
  - New `EventSku { id, shopId, eventId, sku, quantity?, domain, topic?, source, resourceId?, occurredAt, receivedAt }`.
  - New `InventoryItem { id, shopId, inventoryItemId, sku?, productTitle?, variantTitle?, updatedAt }`.
  - New `ShopLocation { id, shopId, locationId, name?, updatedAt }`.
  - New table handles from `app/src/db.ts`: `EventSkus`, `InventoryItems`, `ShopLocations`.

- [ ] **Step 1: Add the new fields to `app/schema.graphql`**

In `type OperationalEvent`, add after the existing `fulfillableItemCount` line:

```graphql
	# Merchant-facing order identifier ("#1001"). Level 1 order data, not PII — a
	# merchant cannot act on a bare numeric order id.
	orderName: String
	# Order value at the time payment was observed, and its currency. Money amounts
	# carry no customer identifier.
	totalPrice: Float
	currency: String
	# Fulfillment/inventory location this event happened at (Shopify location id).
	locationId: String
	# Tracking PRESENCE and carrier, never a per-customer shipment lookup: whether
	# the fulfillment carried any tracking number, and which carrier.
	hasTracking: Boolean
	trackingCompany: String
	# Shopify's own shipment progress string (in_transit, label_printed, …).
	shipmentStatus: String
```

In `type OrderProjection`, add after the existing `requiresFulfillment` line:

```graphql
	orderName: String # immutable in Shopify, so safe as a first-seen latch
	orderTotal: Float # value latched from the EARLIEST paid event
	currency: String
	fulfillmentFailedAt: Float # earliest fulfillment event with status error|failure (latch)
	hasTracking: Boolean # any fulfillment carried a tracking number (latch, monotonic true)
	trackingCompany: String
```

In `type GapFinding`, add after the `orderId` line:

```graphql
	detector: String @indexed # fulfillment_confirmation | fulfillment_attempt_failed
```

- [ ] **Step 2: Append the three new tables to `app/schema.graphql`**

Add at the end of the `sightline_ledger` section:

```graphql
type EventSku @table(database: "sightline_ledger") @sealed {
	# One row per (event, SKU) — the index that makes the SKU filter real. The
	# events table can only hold a scalar sku, and an order has many; filtering by
	# SKU therefore has to page over this table and hydrate events by id.
	#
	# The common event filters are DENORMALIZED here on purpose so a SKU-filtered
	# query is an ordinary keyset page with no post-filtering (which would return
	# short pages and break the "more results" signal). Drift is not a risk: both
	# rows are written from the same event in one place and purged/redacted together.
	id: ID! @primaryKey # `${eventId}:${sku}`
	shopId: String! @indexed
	eventId: String! @indexed
	sku: String! @indexed
	quantity: Int
	domain: String!
	topic: String
	source: String!
	resourceId: String
	occurredAt: Float! @indexed
	receivedAt: Float! @indexed # retention key — matches OperationalEvent's
}

type InventoryItem @table(database: "sightline_ledger") @sealed {
	# Admin API cache: inventory_item_id → SKU/product, so an inventory event is
	# readable instead of an opaque number. Reference data, NOT part of the 7-day
	# ledger — it is erased by shop redaction, not by the retention purge.
	id: ID! @primaryKey # `${shopId}:${inventoryItemId}`
	shopId: String! @indexed
	inventoryItemId: String!
	sku: String
	productTitle: String
	variantTitle: String
	updatedAt: Float
}

type ShopLocation @table(database: "sightline_ledger") @sealed {
	# Admin API cache: location_id → location name. Same lifecycle as InventoryItem.
	id: ID! @primaryKey # `${shopId}:${locationId}`
	shopId: String! @indexed
	locationId: String!
	name: String
	updatedAt: Float
}
```

- [ ] **Step 3: Mirror everything in `app/src/model.ts`**

Add to `interface OperationalEvent`:

```typescript
	orderName?: string;
	totalPrice?: number;
	currency?: string;
	locationId?: string;
	hasTracking?: boolean;
	trackingCompany?: string;
	shipmentStatus?: string;
```

Add to `interface OrderProjection`:

```typescript
	orderName?: string;
	orderTotal?: number;
	currency?: string;
	fulfillmentFailedAt?: number;
	hasTracking?: boolean;
	trackingCompany?: string;
```

Add to `interface GapFinding`:

```typescript
	detector?: string;
```

Append the three new interfaces:

```typescript
export interface EventSku {
	id: string; // `${eventId}:${sku}`
	shopId: string;
	eventId: string;
	sku: string;
	quantity?: number;
	domain: EventDomain;
	topic?: string;
	source: EventSource;
	resourceId?: string;
	occurredAt: number;
	receivedAt: number;
}

export interface InventoryItem {
	id: string; // `${shopId}:${inventoryItemId}`
	shopId: string;
	inventoryItemId: string;
	sku?: string;
	productTitle?: string;
	variantTitle?: string;
	updatedAt?: number;
}

export interface ShopLocation {
	id: string; // `${shopId}:${locationId}`
	shopId: string;
	locationId: string;
	name?: string;
	updatedAt?: number;
}
```

- [ ] **Step 4: Export the new table handles**

In `app/src/db.ts`, add `EventSku`, `InventoryItem`, `ShopLocation` to the type import list from `./model.ts`, then add:

```typescript
export const EventSkus = ledger.EventSku as unknown as Table<EventSku>;
export const InventoryItems = ledger.InventoryItem as unknown as Table<InventoryItem>;
export const ShopLocations = ledger.ShopLocation as unknown as Table<ShopLocation>;
```

- [ ] **Step 5: Typecheck**

Run: `cd app && npm run typecheck && npm test`
Expected: PASS. New optional fields and unused table handles are additive; nothing should break.

- [ ] **Step 6: Commit**

```bash
git add app/schema.graphql app/src/model.ts app/src/db.ts
git commit -m "feat(schema): event/projection fields for value, tracking, location, SKUs"
```

- [ ] **Step 7: Deploy and verify every added column materialized**

Run: `cd app && npm run deploy`

Then verify with `describe_table` (via the ops API, as `scripts/deploy.mjs` does) that:
- `sightline_ledger.OperationalEvent` has `orderName`, `totalPrice`, `currency`, `locationId`, `hasTracking`, `trackingCompany`, `shipmentStatus`
- `sightline_ledger.OrderProjection` has `orderName`, `orderTotal`, `currency`, `fulfillmentFailedAt`, `hasTracking`, `trackingCompany`
- `sightline_ledger.GapFinding` has `detector`
- `sightline_ledger.EventSku`, `InventoryItem`, `ShopLocation` all exist

Expected: every column present. `deploy_component` has intermittently dropped newly-added columns on existing sealed tables — if any column is missing, redeploy and re-verify before continuing. Do not start Task 4 on a half-applied schema.

---

### Task 4: Extract the discarded payload fields in `normalize.ts`

**Files:**
- Modify: `app/src/normalize.ts:63-71` (`EventFields`), `:93-108` (`toEvent`), `:112-175` (the four normalizers)
- Test: `app/test/normalize.test.ts`

**Interfaces:**
- Consumes: `OperationalEvent` fields from Task 3; fixture fields from Task 2.
- Produces: `normalizeDelivery` now returns events carrying `orderName`, `totalPrice`, `currency`, `locationId`, `hasTracking`, `trackingCompany`, `shipmentStatus`, and `skus`. **`skus` is returned on the event object but is NOT an `OperationalEvent` column** — Task 5 consumes it to build `EventSku` rows and strips it before the event is stored. Its exported type is `NormalizedEvent = OperationalEvent & { skus?: string[] }`, and `normalizeDelivery` returns `NormalizedEvent[]`. Also produces `MAX_EVENT_SKUS = 20` and `skusFromLineItems(lineItems: unknown, skuPath?: 'direct' | 'nested'): string[]`.

- [ ] **Step 1: Write the failing tests**

Add to `app/test/normalize.test.ts`. The file already provides `fixture(name)` (reads `test/fixtures/2026-07/<name>.json`) and `meta(topic)` (a `DeliveryMeta` for `shop.myshopify.com`) — use those, do not re-read files:

```typescript
test('order events carry the merchant-facing name, value, and currency', () => {
	const [event] = normalizeDelivery(meta('orders/paid'), fixture('orders_paid'));
	assert.equal(event.orderName, '#1001');
	assert.equal(event.totalPrice, 129.95);
	assert.equal(event.currency, 'USD');
});

test('order name falls back to order_number when name is absent', () => {
	const payload = { ...(fixture('orders_paid') as Record<string, unknown>), name: undefined, order_number: 1042 };
	const [event] = normalizeDelivery(meta('orders/paid'), payload);
	assert.equal(event.orderName, '#1042');
});

test('order events carry every distinct line-item SKU, capped', () => {
	const [event] = normalizeDelivery(meta('orders/paid'), fixture('orders_paid'));
	assert.deepEqual(event.skus, ['TSHIRT-M-BLK', 'STICKER-PK']);

	const many = { ...(fixture('orders_paid') as Record<string, unknown>), line_items: Array.from({ length: 30 }, (_u, i) => ({ sku: `SKU-${i}`, quantity: 1 })) };
	const [big] = normalizeDelivery(meta('orders/paid'), many);
	assert.equal(big.skus?.length, MAX_EVENT_SKUS);
});

test('duplicate SKUs across line items collapse to one entry', () => {
	const payload = { ...(fixture('orders_paid') as Record<string, unknown>), line_items: [{ sku: 'A', quantity: 1 }, { sku: 'A', quantity: 2 }] };
	const [event] = normalizeDelivery(meta('orders/paid'), payload);
	assert.deepEqual(event.skus, ['A']);
});

test('fulfillment events carry location, tracking presence, carrier, and shipment status', () => {
	const [event] = normalizeDelivery(meta('fulfillments/create'), fixture('fulfillments_create'));
	assert.equal(event.locationId, '987654321');
	assert.equal(event.hasTracking, true);
	assert.equal(event.trackingCompany, 'UPS');
	assert.equal(event.shipmentStatus, 'in_transit');
});

test('a fulfillment with no tracking numbers reports hasTracking false, not undefined', () => {
	const payload = { ...(fixture('fulfillments_create') as Record<string, unknown>), tracking_numbers: [], tracking_company: undefined };
	const [event] = normalizeDelivery(meta('fulfillments/create'), payload);
	assert.equal(event.hasTracking, false);
	assert.equal(event.trackingCompany, undefined);
});

test('inventory events carry their location', () => {
	const [event] = normalizeDelivery(meta('inventory_levels/update'), fixture('inventory_levels_update'));
	assert.equal(event.locationId, '987654321');
});

test('refund events carry the refunded line items SKUs', () => {
	const [event] = normalizeDelivery(meta('refunds/create'), fixture('refunds_create'));
	assert.deepEqual(event.skus, ['TSHIRT-M-BLK']);
});

test('no normalizer ever emits a customer-identifying field', () => {
	const hostile = { ...(fixture('orders_paid') as Record<string, unknown>), email: 'a@b.com', customer: { first_name: 'X' }, phone: '+1' };
	const [event] = normalizeDelivery(meta('orders/paid'), hostile);
	for (const key of ['email', 'customer', 'phone', 'billing_address', 'shipping_address']) {
		assert.equal(key in event, false, `${key} must never reach a normalized event`);
	}
});
```

Add `MAX_EVENT_SKUS` to the file's existing import from `../src/normalize.ts`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && node --test test/normalize.test.ts`
Expected: FAIL — `event.orderName` is `undefined`, `MAX_EVENT_SKUS` is not exported.

- [ ] **Step 3: Implement the extraction**

In `app/src/normalize.ts`, add the SKU cap and helper after the existing `fulfillableUnits` function:

```typescript
// Cap on SKUs carried per event. An order with hundreds of line items would
// otherwise fan out into hundreds of EventSku index rows (Task 5), which is real
// storage against a 7-day window; twenty is enough to identify what is in an
// order without letting one pathological order dominate the ledger.
export const MAX_EVENT_SKUS = 20;

// Distinct SKUs from a line-item array, in first-seen order, capped. `nested`
// handles refund_line_items, where the SKU lives on an inner `line_item` object.
export function skusFromLineItems(lineItems: unknown, skuPath: 'direct' | 'nested' = 'direct'): string[] {
	if (!Array.isArray(lineItems)) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const line of lineItems) {
		if (!line || typeof line !== 'object') continue;
		const holder = skuPath === 'nested' ? (line as Payload).line_item : line;
		if (!holder || typeof holder !== 'object') continue;
		const sku = asString((holder as Payload).sku);
		if (!sku || seen.has(sku)) continue;
		seen.add(sku);
		out.push(sku);
		if (out.length >= MAX_EVENT_SKUS) break;
	}
	return out;
}

// True when the fulfillment carried any tracking number. Deliberately a
// PRESENCE boolean: "fulfilled with no tracking" is the operational signal, and
// storing the numbers themselves would be per-shipment data we have no use for.
function hasAnyTracking(payload: Payload): boolean {
	const numbers = payload.tracking_numbers;
	if (Array.isArray(numbers)) return numbers.some((n) => asString(n) !== undefined);
	return asString(payload.tracking_number) !== undefined;
}
```

Extend `EventFields` with:

```typescript
	orderName?: string;
	totalPrice?: number;
	currency?: string;
	locationId?: string;
	hasTracking?: boolean;
	trackingCompany?: string;
	shipmentStatus?: string;
	skus?: string[];
```

Add the exported event type above `toEvent`, and carry the new fields through it:

```typescript
// A normalized event plus its SKU list. `skus` is NOT an OperationalEvent column
// — the events table holds a scalar sku only — so the writer strips it and fans
// it out into EventSku index rows instead (src/eventSkus.ts).
export type NormalizedEvent = OperationalEvent & { skus?: string[] };

function toEvent(meta: DeliveryMeta, fields: EventFields): NormalizedEvent {
	return {
		eventId: `${meta.shopId}:${meta.webhookId}`,
		shopId: meta.shopId,
		domain: fields.domain,
		topic: meta.topic,
		resourceId: fields.resourceId,
		// The scalar `sku` column stays meaningful only when the event has exactly
		// one SKU (inventory after enrichment, a single-line order); multi-SKU
		// events are searchable through EventSku instead of by a lossy first-SKU.
		sku: fields.skus?.length === 1 ? fields.skus[0] : undefined,
		quantity: fields.quantity,
		fulfillableItemCount: fields.fulfillableItemCount,
		state: fields.state,
		source: 'webhook',
		occurredAt: fields.occurredAt,
		receivedAt: meta.receivedAt,
		orderName: fields.orderName,
		totalPrice: fields.totalPrice,
		currency: fields.currency,
		locationId: fields.locationId,
		hasTracking: fields.hasTracking,
		trackingCompany: fields.trackingCompany,
		shipmentStatus: fields.shipmentStatus,
		skus: fields.skus,
	};
}
```

Add the order-name helper and update the four normalizers:

```typescript
// Shopify's merchant-facing order label. `name` is authoritative ("#1001"); when
// a payload carries only the bare number, reconstruct the same shape.
function orderName(payload: Payload): string | undefined {
	const name = asString(payload.name);
	if (name) return name;
	const number = asNumber(payload.order_number);
	return number === undefined ? undefined : `#${number}`;
}

function normalizeOrder(payload: Payload, meta: DeliveryMeta): NormalizedEvent {
	const orderId = asId(payload.id);
	if (!orderId) throw new PermanentNormalizeError(`${meta.topic}: missing order id`);
	return toEvent(meta, {
		domain: 'order',
		resourceId: orderId,
		state: asString(payload.financial_status) ?? asString(payload.fulfillment_status),
		fulfillableItemCount: fulfillableUnits(payload.line_items),
		occurredAt: occurredAt(payload, ['updated_at', 'processed_at', 'cancelled_at', 'created_at'], meta),
		orderName: orderName(payload),
		// current_total_price reflects the order after edits; total_price is the
		// original. Prefer current, fall back to original.
		totalPrice: asNumber(payload.current_total_price) ?? asNumber(payload.total_price),
		currency: asString(payload.currency),
		skus: skusFromLineItems(payload.line_items),
	});
}

function normalizeFulfillment(payload: Payload, meta: DeliveryMeta): NormalizedEvent {
	const orderId = asId(payload.order_id);
	if (!orderId) throw new PermanentNormalizeError(`${meta.topic}: missing order_id`);
	return toEvent(meta, {
		domain: 'fulfillment',
		resourceId: orderId,
		state: asString(payload.status), // pending | open | success | cancelled | error | failure
		occurredAt: occurredAt(payload, ['updated_at', 'created_at'], meta),
		locationId: asId(payload.location_id),
		hasTracking: hasAnyTracking(payload),
		trackingCompany: asString(payload.tracking_company),
		shipmentStatus: asString(payload.shipment_status),
		skus: skusFromLineItems(payload.line_items),
	});
}

function normalizeInventory(payload: Payload, meta: DeliveryMeta): NormalizedEvent {
	const inventoryItemId = asId(payload.inventory_item_id);
	if (!inventoryItemId) throw new PermanentNormalizeError(`${meta.topic}: missing inventory_item_id`);
	return toEvent(meta, {
		domain: 'inventory',
		resourceId: inventoryItemId,
		quantity: asNumber(payload.available),
		occurredAt: occurredAt(payload, ['updated_at'], meta),
		locationId: asId(payload.location_id),
		// SKU is not in an inventory payload — it is resolved later from the
		// InventoryItem cache (src/inventoryEnrich.ts).
	});
}

function normalizeRefund(payload: Payload, meta: DeliveryMeta): NormalizedEvent {
	const orderId = asId(payload.order_id);
	if (!orderId) throw new PermanentNormalizeError(`${meta.topic}: missing order_id`);
	return toEvent(meta, {
		domain: 'refund',
		resourceId: orderId,
		state: 'refunded',
		quantity: sumRefundQuantity(payload.refund_line_items),
		occurredAt: occurredAt(payload, ['processed_at', 'created_at'], meta),
		skus: skusFromLineItems(payload.refund_line_items, 'nested'),
	});
}
```

Finally, change the `NORMALIZERS` record type and `normalizeDelivery`'s return type from `OperationalEvent` to `NormalizedEvent`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && node --test test/normalize.test.ts`
Expected: PASS.

Run: `cd app && npm test && npm run typecheck`
Expected: PASS. `jobs.ts` passes `NormalizedEvent` to `Events.put` — which still typechecks because `NormalizedEvent` extends `OperationalEvent`; Task 5 makes the strip explicit.

- [ ] **Step 5: Commit**

```bash
git add app/src/normalize.ts app/test/normalize.test.ts
git commit -m "feat(normalize): extract order name, value, tracking, location, SKUs"
```

---

### Task 5: `EventSku` index — make the SKU filter real

**Defect being fixed:** the Events screen advertises a SKU column and a SKU filter, and `getPrivacy` tells merchants and app reviewers that SKUs are stored — but no normalizer ever set `sku`, so the column was always blank and the filter always returned "No events match". A filter that silently always fails is worse than no filter.

**Files:**
- Create: `app/src/eventSkus.ts`, `app/test/eventSkus.test.ts`
- Modify: `app/jobs.ts:111-148` (the `handle` writer), `app/jobs.ts:302-344` (`reconcileShopWithToken`)
- Modify: `app/src/queries.ts:83-116` (`listEvents`), `app/src/ledgerTargets.ts:14-37`
- Test: `app/test/queries.test.ts`, `app/test/retention.test.ts`

**Interfaces:**
- Consumes: `NormalizedEvent`, `MAX_EVENT_SKUS` (Task 4); `EventSku` model + `EventSkus` table handle (Task 3).
- Produces:
  - `eventSkuRows(event: NormalizedEvent): EventSku[]` — pure fan-out, `[]` when the event has no SKUs.
  - `stripSkus(event: NormalizedEvent): OperationalEvent` — the event as stored (no `skus` key).
  - `writeEventWithSkus(deps: { events: WritableTable<OperationalEvent>; eventSkus: WritableTable<EventSku> }, event: NormalizedEvent): Promise<void>` — writes the event and its index rows.
  - `interface WritableTable<T> { put(record: T): Promise<void> }` — the minimal write surface, so tests can pass `FakeTable`.
  - `listEvents` accepts the same `sku` param but now pages over `EventSku` when it is set.

- [ ] **Step 1: Write the failing tests**

Create `app/test/eventSkus.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTable } from './fakeTable.ts';
import { eventSkuRows, stripSkus, writeEventWithSkus } from '../src/eventSkus.ts';
import type { NormalizedEvent } from '../src/normalize.ts';

const NOW = 1_775_000_000_000;

function event(over: Partial<NormalizedEvent> = {}): NormalizedEvent {
	return {
		eventId: 's1:w1',
		shopId: 's1',
		domain: 'order',
		topic: 'orders/paid',
		resourceId: 'o1',
		source: 'webhook',
		occurredAt: NOW,
		receivedAt: NOW,
		skus: ['A', 'B'],
		...over,
	};
}

test('one index row per SKU, keyed by event and SKU, carrying the filterable fields', () => {
	const rows = eventSkuRows(event());
	assert.equal(rows.length, 2);
	assert.deepEqual(
		rows.map((r) => r.id),
		['s1:w1:A', 's1:w1:B'],
	);
	assert.equal(rows[0].shopId, 's1');
	assert.equal(rows[0].eventId, 's1:w1');
	assert.equal(rows[0].sku, 'A');
	assert.equal(rows[0].domain, 'order');
	assert.equal(rows[0].topic, 'orders/paid');
	assert.equal(rows[0].source, 'webhook');
	assert.equal(rows[0].resourceId, 'o1');
	assert.equal(rows[0].occurredAt, NOW);
	assert.equal(rows[0].receivedAt, NOW);
});

test('an event with no SKUs produces no index rows', () => {
	assert.deepEqual(eventSkuRows(event({ skus: undefined })), []);
	assert.deepEqual(eventSkuRows(event({ skus: [] })), []);
});

test('stripSkus removes the transport-only field so it is never stored', () => {
	const stored = stripSkus(event());
	assert.equal('skus' in stored, false);
	assert.equal(stored.eventId, 's1:w1');
});

test('writing the same event twice is idempotent — deterministic keys upsert', async () => {
	const events = new FakeTable('eventId');
	const eventSkus = new FakeTable('id');
	await writeEventWithSkus({ events, eventSkus }, event());
	await writeEventWithSkus({ events, eventSkus }, event());
	assert.equal(events.rows.size, 1);
	assert.equal(eventSkus.rows.size, 2);
	assert.equal('skus' in (await events.get('s1:w1'))!, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && node --test test/eventSkus.test.ts`
Expected: FAIL — cannot find module `../src/eventSkus.ts`.

- [ ] **Step 3: Implement `app/src/eventSkus.ts`**

```typescript
import type { EventSku, OperationalEvent } from './model.ts';
import type { NormalizedEvent } from './normalize.ts';

// EventSku is the index that makes "show me events for SKU X" answerable. The
// events table can hold only a scalar sku and an order has many, so a SKU filter
// pages over this table and hydrates events by id (src/queries.ts).
//
// Rows are keyed `${eventId}:${sku}`, so reprocessing a delivery upserts exactly
// the same rows — the same idempotency guarantee the event itself has (ADR-002).

// The minimal write surface, so tests can pass an in-memory table.
export interface WritableTable<T> {
	put(record: T): Promise<void>;
}

// The event as STORED: `skus` is a transport field on the normalizer's output,
// not a column, and must not reach the table.
export function stripSkus(event: NormalizedEvent): OperationalEvent {
	const { skus: _skus, ...stored } = event;
	return stored;
}

export function eventSkuRows(event: NormalizedEvent): EventSku[] {
	return (event.skus ?? []).map((sku) => ({
		id: `${event.eventId}:${sku}`,
		shopId: event.shopId,
		eventId: event.eventId,
		sku,
		quantity: event.quantity,
		domain: event.domain,
		topic: event.topic,
		source: event.source,
		resourceId: event.resourceId,
		occurredAt: event.occurredAt,
		receivedAt: event.receivedAt,
	}));
}

// Write the event and its index rows. The event is written FIRST: an index row
// pointing at a missing event would render as a phantom result, whereas an event
// briefly missing from the SKU index just isn't SKU-searchable yet, and the next
// reprocess or reconciliation pass repairs it.
export async function writeEventWithSkus(
	deps: { events: WritableTable<OperationalEvent>; eventSkus: WritableTable<EventSku> },
	event: NormalizedEvent,
): Promise<void> {
	await deps.events.put(stripSkus(event));
	for (const row of eventSkuRows(event)) await deps.eventSkus.put(row);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && node --test test/eventSkus.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit the pure layer**

```bash
git add app/src/eventSkus.ts app/test/eventSkus.test.ts
git commit -m "feat(capture): EventSku index rows for real SKU search"
```

- [ ] **Step 6: Write the failing test for the SKU-filtered query path**

Add to `app/test/queries.test.ts`. The existing `fixtures()` helper builds an `events` FakeTable — add an `eventSkus` FakeTable alongside it, with rows matching the two `s1` order events and one `s2` row sharing the same SKU:

```typescript
function skuFixtures() {
	return new FakeTable('id', [
		{ id: 's1:e1:TSHIRT', shopId: 's1', eventId: 's1:e1', sku: 'TSHIRT', domain: 'order', topic: 'orders/paid', source: 'webhook', resourceId: 'o1', occurredAt: NOW - 1000, receivedAt: NOW - 1000 },
		{ id: 's1:e2:TSHIRT', shopId: 's1', eventId: 's1:e2', sku: 'TSHIRT', domain: 'fulfillment', topic: 'fulfillments/create', source: 'webhook', resourceId: 'o1', occurredAt: NOW - 500, receivedAt: NOW - 500 },
		{ id: 's2:e1:TSHIRT', shopId: 's2', eventId: 's2:e1', sku: 'TSHIRT', domain: 'order', topic: 'orders/paid', source: 'webhook', resourceId: 'o1', occurredAt: NOW - 900, receivedAt: NOW - 900 },
	]);
}

test('a SKU filter returns the shop own matching events, newest first', async () => {
	const { events } = fixtures();
	const page = await listEvents(events, 's1', NOW, { sku: 'TSHIRT' }, skuFixtures());
	assert.deepEqual(
		page.items.map((i) => i.eventId),
		['s1:e2', 's1:e1'],
	);
});

test('a SKU filter never returns another tenant event that shares the SKU', async () => {
	const { events } = fixtures();
	const page = await listEvents(events, 's1', NOW, { sku: 'TSHIRT' }, skuFixtures());
	for (const item of page.items) assert.equal(item.eventId.startsWith('s1:'), true);
});

test('a SKU filter combines with a domain filter without post-filtering the page', async () => {
	const { events } = fixtures();
	const page = await listEvents(events, 's1', NOW, { sku: 'TSHIRT', domain: 'fulfillment' }, skuFixtures());
	assert.deepEqual(
		page.items.map((i) => i.eventId),
		['s1:e2'],
	);
});

test('a SKU with no index rows returns an empty page, not every event', async () => {
	const { events } = fixtures();
	const page = await listEvents(events, 's1', NOW, { sku: 'NOPE' }, skuFixtures());
	assert.deepEqual(page.items, []);
});

test('an index row whose event is missing is skipped, not returned as a phantom', async () => {
	const { events } = fixtures();
	const orphaned = skuFixtures();
	await orphaned.put({ id: 's1:gone:TSHIRT', shopId: 's1', eventId: 's1:gone', sku: 'TSHIRT', domain: 'order', source: 'webhook', occurredAt: NOW - 100, receivedAt: NOW - 100 });
	const page = await listEvents(events, 's1', NOW, { sku: 'TSHIRT' }, orphaned);
	assert.equal(
		page.items.some((i) => i.eventId === 's1:gone'),
		false,
	);
});
```

- [ ] **Step 7: Run tests to verify they fail**

Run: `cd app && node --test test/queries.test.ts`
Expected: FAIL — `listEvents` takes four arguments; the SKU path does not exist.

- [ ] **Step 8: Implement the SKU-filtered path in `app/src/queries.ts`**

Replace `listEvents` with:

```typescript
// GET /events — the searchable 7-day operational ledger, tenant-scoped, filtered,
// cursor-paginated. The window floor is max(caller since, now − 7 days).
//
// A `sku` filter takes a different path: SKUs live in the EventSku index (one row
// per event/SKU) because an order has many and the event row holds one scalar.
// The index carries the other filterable fields, so the SKU path is an ordinary
// keyset page over EventSku followed by a keyed hydrate — no post-filtering, so
// a page is never short and `nextCursor` never lies.
export async function listEvents(
	events: QueryTable,
	shopId: string,
	now: number,
	params: EventQueryParams,
	eventSkus?: QueryTable,
): Promise<Page> {
	const windowStart = Math.max(params.since ?? 0, now - WINDOW_MS);
	const conditions: QuerySpec['conditions'] = [
		{ attribute: 'shopId', value: shopId },
		{ attribute: 'occurredAt', value: windowStart, comparator: 'greater_than_equal' },
	];
	if (params.until !== undefined) conditions.push({ attribute: 'occurredAt', value: params.until, comparator: 'less_than_equal' });
	for (const [attr, val] of [
		['domain', params.domain],
		['topic', params.topic],
		['resourceId', params.resourceId],
		// `source` distinguishes webhook-observed from reconciliation-recovered
		// evidence (screen spec §3 "evidence source" filter).
		['source', params.source],
	] as const) {
		if (val) conditions.push({ attribute: attr, value: val });
	}

	if (params.sku && eventSkus) {
		const indexPage = await keysetPageDesc(
			eventSkus,
			[...conditions, { attribute: 'sku', value: params.sku }],
			'occurredAt',
			'id',
			['eventId'],
			params.cursor,
			params.limit,
		);
		const hydrated: Array<Record<string, unknown>> = [];
		for (const row of indexPage.items) {
			const event = await events.get(String(row.eventId));
			// An index row whose event is gone (purged mid-page, or written before its
			// event landed) is skipped rather than surfaced as a phantom result.
			if (event && event.shopId === shopId) hydrated.push(pick(event, EVENT_FIELDS));
		}
		return { items: hydrated, nextCursor: indexPage.nextCursor };
	}

	return keysetPageDesc(events, conditions, 'occurredAt', 'eventId', EVENT_FIELDS, params.cursor, params.limit);
}
```

Then wire the index table through the resource. In `app/resources.ts`, add `EventSkus as EventSkusTable` to the `./src/db.ts` import, add `const EventSkusQ = EventSkusTable as unknown as QueryTable;` beside the other `*Q` constants, and pass it as `listEvents`'s fifth argument in `EventsResource.get`.

- [ ] **Step 9: Run tests to verify they pass**

Run: `cd app && node --test test/queries.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 10: Wire the writer into both capture paths**

In `app/jobs.ts`:

Add the imports:

```typescript
import { EventSkus } from './src/db.ts';
import { writeEventWithSkus } from './src/eventSkus.ts';
```

In `deps.handle`, replace `await Events.put(event);` with:

```typescript
				await writeEventWithSkus({ events: Events, eventSkus: EventSkus }, event);
```

In `reconcileShopWithToken`, replace `for (const event of synthesizeEvents(shopId, order)) await Events.put(event);` with:

```typescript
			for (const event of synthesizeEvents(shopId, order)) {
				await writeEventWithSkus({ events: Events, eventSkus: EventSkus }, event);
			}
```

(`synthesizeEvents` returns no `skus`, so reconciliation writes zero index rows today — correct, since the reconcile GraphQL query does not select line-item SKUs. The call site is unified so it cannot drift later.)

- [ ] **Step 11: Add `EventSku` to retention and redaction**

In `app/src/ledgerTargets.ts`, add to `RETENTION_TARGETS` (immediately after the `OperationalEvent` entry, sharing its `receivedAt` retention key so index rows never outlive their events):

```typescript
	{ name: 'EventSku', keyField: 'id', tsField: 'receivedAt', table: purgeable(EventSkus) },
```

And to `REDACT_TARGETS` (after the `OperationalEvent` entry — `resourceId` makes it order-linked so `customers/redact` reaches it):

```typescript
	{ name: 'EventSku', keyField: 'id', shopField: 'shopId', orderField: 'resourceId', table: purgeable(EventSkus) },
```

Add `EventSkus` to the import from `./db.ts`.

- [ ] **Step 12: Test retention and redaction reach the new table**

Add to `app/test/retention.test.ts`:

```typescript
test('EventSku rows are purged with their events', async () => {
	const eventSkus = new FakeTable('id', [
		{ id: 'old:A', shopId: 's1', eventId: 'old', sku: 'A', receivedAt: NOW - 8 * DAY, occurredAt: NOW - 8 * DAY },
		{ id: 'new:A', shopId: 's1', eventId: 'new', sku: 'A', receivedAt: NOW - 1 * DAY, occurredAt: NOW - 1 * DAY },
	]);
	const result = await purgeExpired([{ name: 'EventSku', keyField: 'id', tsField: 'receivedAt', table: eventSkus }], NOW);
	assert.equal(result.deleted, 1);
	assert.equal(result.residue, 0);
	assert.equal(await eventSkus.get('old:A'), undefined);
	assert.notEqual(await eventSkus.get('new:A'), undefined);
});
```

Run: `cd app && npm test`
Expected: PASS. (`NOW` and `DAY` already exist in that file; reuse them.)

- [ ] **Step 13: Commit**

```bash
git add app/jobs.ts app/resources.ts app/src/queries.ts app/src/ledgerTargets.ts app/test/queries.test.ts app/test/retention.test.ts
git commit -m "fix(events): SKU filter and column now return real data"
```

---

### Task 6: Projection latches for failed fulfillment, tracking, name, and value

**Files:**
- Modify: `app/src/projection.ts:25-47` (`applyEvent`)
- Test: `app/test/projection.test.ts`

**Interfaces:**
- Consumes: `OperationalEvent` and `OrderProjection` fields from Task 3.
- Produces: `applyEvent` now maintains `fulfillmentFailedAt`, `hasTracking`, `trackingCompany`, `orderName`, `orderTotal`, `currency`; and exports `FAILED_FULFILLMENT_STATES = new Set(['error', 'failure'])` for the detector in Task 7.

- [ ] **Step 1: Write the failing tests**

Add to `app/test/projection.test.ts` (reuse the file's existing event-builder helper if present; otherwise define `ev()` as below):

```typescript
test('a fulfillment with status error latches fulfillmentFailedAt at the earliest attempt', () => {
	const p = rebuildProjection([
		ev({ eventId: 'e1', domain: 'order', topic: 'orders/paid', state: 'paid', occurredAt: 100, fulfillableItemCount: 2 }),
		ev({ eventId: 'e2', domain: 'fulfillment', state: 'error', occurredAt: 300 }),
		ev({ eventId: 'e3', domain: 'fulfillment', state: 'failure', occurredAt: 200 }),
	]);
	assert.equal(p?.fulfillmentFailedAt, 200);
	assert.equal(p?.fulfilledAt, undefined);
});

test('a successful fulfillment does not clear an earlier failure — history is preserved', () => {
	const p = rebuildProjection([
		ev({ eventId: 'e1', domain: 'order', topic: 'orders/paid', state: 'paid', occurredAt: 100, fulfillableItemCount: 2 }),
		ev({ eventId: 'e2', domain: 'fulfillment', state: 'error', occurredAt: 200 }),
		ev({ eventId: 'e3', domain: 'fulfillment', state: 'success', occurredAt: 400 }),
	]);
	assert.equal(p?.fulfillmentFailedAt, 200);
	assert.equal(p?.fulfilledAt, 400);
});

test('pending and open fulfillments are not failures', () => {
	const p = rebuildProjection([
		ev({ eventId: 'e1', domain: 'fulfillment', state: 'pending', occurredAt: 100 }),
		ev({ eventId: 'e2', domain: 'fulfillment', state: 'open', occurredAt: 200 }),
	]);
	assert.equal(p?.fulfillmentFailedAt, undefined);
});

test('tracking presence latches true and never back to false', () => {
	const p = rebuildProjection([
		ev({ eventId: 'e1', domain: 'fulfillment', state: 'success', occurredAt: 100, hasTracking: true, trackingCompany: 'UPS' }),
		ev({ eventId: 'e2', domain: 'fulfillment', state: 'success', occurredAt: 200, hasTracking: false }),
	]);
	assert.equal(p?.hasTracking, true);
	assert.equal(p?.trackingCompany, 'UPS');
});

test('order value is latched from the EARLIEST paid event, with its currency', () => {
	const p = rebuildProjection([
		ev({ eventId: 'e1', domain: 'order', topic: 'orders/paid', state: 'paid', occurredAt: 200, totalPrice: 50, currency: 'USD' }),
		ev({ eventId: 'e2', domain: 'order', topic: 'orders/paid', state: 'paid', occurredAt: 100, totalPrice: 40, currency: 'USD' }),
	]);
	assert.equal(p?.paidAt, 100);
	assert.equal(p?.orderTotal, 40);
	assert.equal(p?.currency, 'USD');
});

test('order name is carried onto the projection', () => {
	const p = rebuildProjection([ev({ eventId: 'e1', domain: 'order', topic: 'orders/paid', state: 'paid', occurredAt: 100, orderName: '#1001' })]);
	assert.equal(p?.orderName, '#1001');
});

test('rebuild equality holds for every new latch under shuffled event order', () => {
	const events = [
		ev({ eventId: 'e1', domain: 'order', topic: 'orders/paid', state: 'paid', occurredAt: 100, fulfillableItemCount: 2, orderName: '#1001', totalPrice: 40, currency: 'USD' }),
		ev({ eventId: 'e2', domain: 'fulfillment', state: 'error', occurredAt: 200 }),
		ev({ eventId: 'e3', domain: 'fulfillment', state: 'success', occurredAt: 400, hasTracking: true, trackingCompany: 'UPS' }),
		ev({ eventId: 'e4', domain: 'order', topic: 'orders/paid', state: 'paid', occurredAt: 300, totalPrice: 55, currency: 'USD' }),
	];
	const forward = rebuildProjection(events);
	const reverse = rebuildProjection([...events].reverse());
	const shuffled = rebuildProjection([events[2], events[0], events[3], events[1]]);
	assert.deepEqual(reverse, forward);
	assert.deepEqual(shuffled, forward);
});
```

If the file has no `ev()` helper, add:

```typescript
function ev(over: Partial<OperationalEvent> & { eventId: string; domain: OperationalEvent['domain']; occurredAt: number }): OperationalEvent {
	return { shopId: 's1', resourceId: 'o1', source: 'webhook', receivedAt: over.occurredAt, ...over };
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && node --test test/projection.test.ts`
Expected: FAIL — `fulfillmentFailedAt` is `undefined`.

- [ ] **Step 3: Implement the latches**

In `app/src/projection.ts`, add above `applyEvent`:

```typescript
// Fulfillment statuses that mean an attempt was made and did not succeed. These
// are Shopify's own status strings on a fulfillment record — direct evidence of a
// failed attempt, not an inference from absence.
export const FAILED_FULFILLMENT_STATES = new Set(['error', 'failure']);
```

Then extend the domain branches inside `applyEvent`:

```typescript
		if (event.domain === 'order') {
			if (event.state === 'paid' || event.topic === 'orders/paid') {
				// Latch the order's value from the EARLIEST paid event, so the stored
				// value is the one that was true at payment. Comparing against the
				// pre-update paidAt keeps this commutative: whichever order the events
				// arrive in, the value from the lowest paid timestamp wins.
				if (base.paidAt === undefined || event.occurredAt < base.paidAt) {
					if (event.totalPrice !== undefined) next.orderTotal = event.totalPrice;
					if (event.currency !== undefined) next.currency = event.currency;
				}
				next.paidAt = earliest(base.paidAt, event.occurredAt);
			}
			if (event.topic === 'orders/cancelled') next.cancelledAt = earliest(base.cancelledAt, event.occurredAt);
			if (event.state === 'refunded') next.fullyRefundedAt = earliest(base.fullyRefundedAt, event.occurredAt);
			if ((event.fulfillableItemCount ?? 0) > 0) next.requiresFulfillment = true;
		} else if (event.domain === 'fulfillment') {
			if (event.state === 'success') next.fulfilledAt = earliest(base.fulfilledAt, event.occurredAt);
			// A failed attempt is recorded and never cleared by a later success: the
			// merchant needs to know an attempt failed even if a retry worked.
			if (event.state !== undefined && FAILED_FULFILLMENT_STATES.has(event.state)) {
				next.fulfillmentFailedAt = earliest(base.fulfillmentFailedAt, event.occurredAt);
			}
			// Monotonic true: "some fulfillment carried tracking" can only become true.
			if (event.hasTracking === true) {
				next.hasTracking = true;
				if (event.trackingCompany !== undefined) next.trackingCompany = event.trackingCompany;
			}
		}
		// Order name is immutable in Shopify, so first-seen-wins is stable across
		// any event ordering.
		if (next.orderName === undefined && event.orderName !== undefined) next.orderName = event.orderName;
```

Note: the `orderName` line goes after the domain branches, at the same indentation as them, before the `return next;`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && node --test test/projection.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/projection.ts app/test/projection.test.ts
git commit -m "feat(projection): latch failed fulfillments, tracking, order name and value"
```

---

### Task 7: Second detector — `fulfillment_attempt_failed`

A presence detector, not an absence detector. It fires on evidence Shopify itself recorded (a fulfillment with status `error`/`failure`), so its copy must **not** carry the absence disclaimer — that sentence would be false here. It still never names or blames a specific downstream party.

**Files:**
- Modify: `app/src/detector.ts`
- Modify: `app/jobs.ts:57-83` (`runDetectorForOrder`)
- Modify: `app/src/queries.ts:164-208` (`listFindings` gains a `detector` filter; `getFindingDetail` describes per detector)
- Modify: `app/src/apiContract.ts` (`FINDING_FIELDS` gains `detector`; findings filters gain `detector`)
- Test: `app/test/detector.test.ts`, `app/test/queries.test.ts`

**Interfaces:**
- Consumes: `FAILED_FULFILLMENT_STATES` and `OrderProjection.fulfillmentFailedAt` (Task 6); `GapFinding.detector` (Task 3).
- Produces:
  - `DETECTOR_FAILED = 'fulfillment_attempt_failed'`, `FAILED_RULE: DetectorRule`
  - `evaluateFailedFulfillment(input: { projection: OrderProjection; now: number; evidenceEventIds?: string[]; prior?: { finding?: GapFinding }; rule?: DetectorRule }): { finding: GapFinding | null }`
  - `describeFinding(finding: GapFinding): string` — unchanged signature, now branches on `finding.detector`
  - `evaluateOrder` unchanged, but the expectation/finding it returns now carries `detector: rule.detector`
  - `listFindings`/`getFindingDetail` accept `detector` filtering; `FindingQueryParams` gains `detector?: string`

- [ ] **Step 1: Write the failing tests**

Add to `app/test/detector.test.ts`:

```typescript
test('a failed fulfillment attempt yields an unconfirmed finding immediately — no deadline', () => {
	const projection = { id: 's1:o1', shopId: 's1', orderId: 'o1', paidAt: 100, requiresFulfillment: true, fulfillmentFailedAt: 200 };
	const { finding } = evaluateFailedFulfillment({ projection, now: 250, evidenceEventIds: ['s1:e2'] });
	assert.equal(finding?.status, 'unconfirmed');
	assert.equal(finding?.detector, DETECTOR_FAILED);
	assert.equal(finding?.detectedAt, 200, 'detected when the failure occurred, not when we noticed');
	assert.equal(finding?.id, detectorKey('s1', 'o1', FAILED_RULE));
	assert.deepEqual(finding?.evidenceEventIds, ['s1:e2']);
});

test('no failed attempt yields no finding', () => {
	const projection = { id: 's1:o1', shopId: 's1', orderId: 'o1', paidAt: 100, requiresFulfillment: true };
	assert.equal(evaluateFailedFulfillment({ projection, now: 250 }).finding, null);
});

test('a later success resolves the failed-attempt finding but keeps its history', () => {
	const projection = { id: 's1:o1', shopId: 's1', orderId: 'o1', paidAt: 100, requiresFulfillment: true, fulfillmentFailedAt: 200, fulfilledAt: 400 };
	const prior = { finding: { id: detectorKey('s1', 'o1', FAILED_RULE), shopId: 's1', orderId: 'o1', detector: DETECTOR_FAILED, status: 'unconfirmed' as const, detectedAt: 200, evidenceEventIds: ['s1:e2'] } };
	const { finding } = evaluateFailedFulfillment({ projection, now: 500, prior });
	assert.equal(finding?.status, 'resolved');
	assert.equal(finding?.detectedAt, 200);
	assert.deepEqual(finding?.evidenceEventIds, ['s1:e2']);
});

test('cancellation suppresses a failed-attempt finding', () => {
	const projection = { id: 's1:o1', shopId: 's1', orderId: 'o1', paidAt: 100, requiresFulfillment: true, fulfillmentFailedAt: 200, cancelledAt: 300 };
	const { finding } = evaluateFailedFulfillment({ projection, now: 400 });
	assert.equal(finding?.status, 'suppressed');
});

test('evaluating twice is idempotent', () => {
	const projection = { id: 's1:o1', shopId: 's1', orderId: 'o1', paidAt: 100, requiresFulfillment: true, fulfillmentFailedAt: 200 };
	const first = evaluateFailedFulfillment({ projection, now: 250, evidenceEventIds: ['s1:e2'] }).finding;
	const second = evaluateFailedFulfillment({ projection, now: 999, evidenceEventIds: ['s1:e2'], prior: { finding: first! } }).finding;
	assert.deepEqual(second, first);
});

test('the failed-attempt description states the observation without blaming a party', () => {
	const text = describeFinding({ id: 'x', shopId: 's1', orderId: 'o1', detector: DETECTOR_FAILED, status: 'unconfirmed' });
	assert.match(text, /fulfillment attempt/i);
	assert.match(text, /Shopify/);
	// It is direct evidence, so it must NOT hedge as an absence finding does...
	assert.doesNotMatch(text, /has not shown/i);
	// ...and must still not accuse a specific downstream party.
	assert.doesNotMatch(text, /warehouse|carrier|vendor|3PL/i);
});

test('the absence detector description is unchanged', () => {
	const text = describeFinding({ id: 'x', shopId: 's1', orderId: 'o1', detector: DETECTOR, status: 'unconfirmed' });
	assert.equal(text, 'No Shopify fulfillment confirmation was observed for this paid, fulfillment-eligible order by the expected time.');
});

test('a finding with no detector field defaults to the absence detector copy', () => {
	const text = describeFinding({ id: 'x', shopId: 's1', orderId: 'o1', status: 'unconfirmed' });
	assert.match(text, /No Shopify fulfillment confirmation/);
});

test('the absence detector stamps its own name on what it writes', () => {
	const projection = { id: 's1:o1', shopId: 's1', orderId: 'o1', paidAt: 100, requiresFulfillment: true };
	const result = evaluateOrder({ projection, now: 100 + FULFILLMENT_DEADLINE_MS });
	assert.equal(result.finding?.detector, DETECTOR);
	assert.equal(result.expectation?.detector, DETECTOR);
});
```

Extend the file's import from `../src/detector.ts` with `DETECTOR_FAILED`, `FAILED_RULE`, and `evaluateFailedFulfillment`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && node --test test/detector.test.ts`
Expected: FAIL — `evaluateFailedFulfillment` is not exported.

- [ ] **Step 3: Implement the detector**

In `app/src/detector.ts`, add after the existing `DEFAULT_RULE`:

```typescript
// ── Failed-fulfillment-attempt detector (ruleVersion 1) ──────────────────────
//
// A PRESENCE detector: it fires on evidence Shopify itself recorded — a
// fulfillment whose status is `error` or `failure` — so unlike the confirmation
// detector it needs no deadline and infers nothing from absence. That makes its
// copy different in kind: it may state that an attempt failed, because Shopify
// says so. It still never names or blames a downstream party.
//
//   fulfillmentFailedAt | fulfilledAt (later) | cancelled/refunded | finding
//   ────────────────────┼─────────────────────┼────────────────────┼──────────────
//   unset               |          –          |         –          | (none)
//   set                 |        unset        |       unset        | unconfirmed
//   set                 |         set         |         –          | resolved
//   set                 |        unset        |        set         | suppressed
export const DETECTOR_FAILED = 'fulfillment_attempt_failed';

// deadlineMs is 0: this detector has no waiting period. It is in the rule only
// because DetectorRule is the shared shape that keys and versions a detector.
export const FAILED_RULE: DetectorRule = {
	detector: DETECTOR_FAILED,
	ruleVersion: 1,
	deadlineMs: 0,
};

export interface FailedEvaluateInput {
	projection: OrderProjection;
	now: number;
	evidenceEventIds?: string[];
	prior?: { finding?: GapFinding };
	rule?: DetectorRule;
}

export function evaluateFailedFulfillment(input: FailedEvaluateInput): { finding: GapFinding | null } {
	const rule = input.rule ?? FAILED_RULE;
	const p = input.projection;
	const prior = input.prior ?? {};
	if (p.fulfillmentFailedAt === undefined) return { finding: prior.finding ?? null };

	// detectedAt is the failure's own timestamp, not when the sweep noticed — the
	// merchant's question is "when did this break", and it makes the record stable
	// across re-evaluation.
	const detectedAt = prior.finding?.detectedAt ?? p.fulfillmentFailedAt;
	let status: GapFinding['status'] = 'unconfirmed';
	if (p.fulfilledAt !== undefined) status = 'resolved';
	else if (p.cancelledAt !== undefined || p.fullyRefundedAt !== undefined) status = 'suppressed';

	const terminal = status !== 'unconfirmed';
	return {
		finding: {
			id: detectorKey(p.shopId, p.orderId, rule),
			shopId: p.shopId,
			orderId: p.orderId,
			detector: rule.detector,
			ruleVersion: rule.ruleVersion,
			status,
			detectedAt,
			resolvedAt: terminal ? (prior.finding?.resolvedAt ?? input.now) : undefined,
			evidenceEventIds: prior.finding?.evidenceEventIds ?? input.evidenceEventIds ?? [],
		},
	};
}
```

Stamp the detector name on what `evaluateOrder` writes: inside `evaluateOrder`, add `detector: rule.detector,` to the `expectation` object literal (it already has `detector`) — verify it is present — and add `detector: rule.detector,` to **both** `finding` object literals (the `state === 'expired'` branch, and leave the transition branch's spread alone since it inherits it).

Replace `describeFinding` with:

```typescript
// Approved, non-accusatory finding copy, per detector.
//
// The absence detector must hedge: absence of a confirmation is not proof that
// anything failed. The presence detector must NOT hedge in the same words — a
// fulfillment Shopify recorded as `error` did fail, and saying "Shopify has not
// shown confirmation yet" would understate it. Neither ever names a warehouse,
// carrier, or vendor.
export function describeFinding(finding: GapFinding): string {
	if (finding.detector === DETECTOR_FAILED) {
		switch (finding.status) {
			case 'unconfirmed':
				return 'Shopify recorded a fulfillment attempt for this order that did not succeed.';
			case 'resolved':
				return 'A later fulfillment succeeded; this order is now fulfilled in Shopify.';
			case 'suppressed':
				return 'This order was cancelled or fully refunded, so the failed attempt no longer needs action.';
			default:
				return 'This order is awaiting evaluation.';
		}
	}
	switch (finding.status) {
		case 'unconfirmed':
			return 'No Shopify fulfillment confirmation was observed for this paid, fulfillment-eligible order by the expected time.';
		case 'resolved':
			return 'A fulfillment confirmation was later observed; this order no longer lacks confirmation.';
		case 'suppressed':
			return 'This order was cancelled or fully refunded, so fulfillment confirmation is no longer expected.';
		default:
			return 'This order is awaiting evaluation.';
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && node --test test/detector.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit the detector**

```bash
git add app/src/detector.ts app/test/detector.test.ts
git commit -m "feat(detect): failed-fulfillment-attempt detector"
```

- [ ] **Step 6: Run both detectors per order**

In `app/jobs.ts`, extend `runDetectorForOrder` so both detectors evaluate from the same projection read and the same evidence scan:

```typescript
// Run every detector for one order (#14 + failed-attempt detector): evaluate the
// projection against each rule and upsert its expectation/finding. Deterministic
// keys make this idempotent; evidence is the order's normalized event ids.
//
// The failed-attempt detector writes NO expectation — it has no deadline, so
// there is nothing for the periodic sweep to expire. It is therefore evaluated
// only on order events (which is sufficient: its state changes only when a new
// fulfillment/cancel/refund event arrives).
async function runDetectorForOrder(shopId: string, orderId: string, now = Date.now()): Promise<void> {
	const projection = await Projections.get(`${shopId}:${orderId}`);
	if (!projection) return;
	const evidenceEventIds: string[] = [];
	for await (const e of Events.search({
		conditions: [
			{ attribute: 'shopId', value: shopId },
			{ attribute: 'resourceId', value: orderId },
		],
		operator: 'and',
		select: ['eventId'],
	})) {
		const eid = (e as { eventId?: unknown }).eventId;
		if (typeof eid === 'string') evidenceEventIds.push(eid);
	}
	evidenceEventIds.sort();

	const confirmationId = detectorKey(shopId, orderId);
	const [expectation, finding] = await Promise.all([Expectations.get(confirmationId), Findings.get(confirmationId)]);
	const result = evaluateOrder({
		projection,
		now,
		evidenceEventIds,
		prior: { expectation: expectation as Expectation | undefined, finding: finding as GapFinding | undefined },
	});
	if (result.expectation) await Expectations.put(result.expectation);
	if (result.finding) await Findings.put(result.finding);

	const failedId = detectorKey(shopId, orderId, FAILED_RULE);
	const priorFailed = (await Findings.get(failedId)) as GapFinding | undefined;
	const failed = evaluateFailedFulfillment({
		projection,
		now,
		evidenceEventIds,
		prior: { finding: priorFailed },
	});
	if (failed.finding) await Findings.put(failed.finding);
}
```

Extend the `./src/detector.ts` import in `jobs.ts` with `FAILED_RULE` and `evaluateFailedFulfillment`.

- [ ] **Step 7: Add the `detector` filter to the read layer**

In `app/src/apiContract.ts`:
- add `'detector'` to `FINDING_FIELDS` (after `'orderId'`)
- change the `findings` resource's `filters` to `['status', 'detector', 'cursor', 'limit']`

In `app/src/queries.ts`, add `detector?: string;` to `FindingQueryParams`, and inside `listFindings` add after the status condition:

```typescript
	if (params.detector) conditions.push({ attribute: 'detector', value: params.detector });
```

In `app/resources.ts`, in `FindingsResource.get`, add `detector: p.get('detector') ?? undefined,` to the `listFindings` params object.

- [ ] **Step 8: Test the filter and regenerate the contract**

Add to `app/test/queries.test.ts`:

```typescript
test('findings can be filtered to one detector', async () => {
	const { findings, expectations, projections } = fixtures();
	await findings.put({ id: 'fulfillment_attempt_failed:s1:o1:1', shopId: 's1', orderId: 'o1', detector: 'fulfillment_attempt_failed', status: 'unconfirmed', detectedAt: NOW - 100 });
	const page = await listFindings(findings, expectations, projections, 's1', { detector: 'fulfillment_attempt_failed' });
	assert.equal(page.items.length, 1);
	assert.equal(page.items[0].detector, 'fulfillment_attempt_failed');
});
```

Run: `cd app && npm run contract:gen && npm test && npm run typecheck`
Expected: PASS, and `contracts/sightline-api-v1.json` updated with `detector` in the findings item fields and filters.

- [ ] **Step 9: Commit**

```bash
git add app/jobs.ts app/resources.ts app/src/queries.ts app/src/apiContract.ts contracts/sightline-api-v1.json app/test/queries.test.ts
git commit -m "feat(detect): run both detectors and expose a detector filter"
```

---

### Task 8: Inventory enrichment — make inventory events readable

Today an inventory row is a bare `inventory_item_id` and a number: uninterpretable, and inventory is the highest-volume domain. This resolves item ids to SKU/product and location ids to names via cached Admin API reads, and backfills `EventSku` rows so inventory events become SKU-searchable like every other domain.

**Files:**
- Create: `app/src/inventoryEnrich.ts`, `app/test/inventoryEnrich.test.ts`
- Modify: `app/src/adminApi.ts`, `app/jobs.ts`, `app/src/ledgerTargets.ts`, `app/src/queries.ts:121-151` (`getEventDetail`), `app/src/apiContract.ts`
- Test: `app/test/queries.test.ts`

**Interfaces:**
- Consumes: `InventoryItem`/`ShopLocation` models and `InventoryItems`/`ShopLocations` handles (Task 3); `eventSkuRows`-style writes (Task 5); `adminGraphql` and `getUsableAccessToken` (existing).
- Produces:
  - `adminApi.ts`: `fetchInventoryItems(shop, token, ids: string[], fetchImpl?): Promise<InventoryItemFacts[]>` where `InventoryItemFacts = { inventoryItemId: string; sku?: string; productTitle?: string; variantTitle?: string }`; `fetchLocations(shop, token, fetchImpl?): Promise<Array<{ locationId: string; name?: string }>>`
  - `inventoryEnrich.ts`: `ENRICH_BATCH = 50`; `unresolvedIds(events: Array<{ resourceId?: string }>, resolved: Set<string>): string[]`; `inventoryItemRow(shopId, facts, now): InventoryItem`; `locationRow(shopId, location, now): ShopLocation`; `skuRowsForInventoryEvent(event: OperationalEvent, sku: string): EventSku[]`
  - `jobs.ts`: `runInventoryEnrichment(now?): Promise<{ items: number; locations: number; indexed: number }>`, `startInventoryEnrichmentLoop(): void`
  - `getEventDetail` response gains `locationName` and `inventorySku`

- [ ] **Step 1: Write the failing tests for the pure layer**

Create `app/test/inventoryEnrich.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENRICH_BATCH, inventoryItemRow, locationRow, skuRowsForInventoryEvent, unresolvedIds } from '../src/inventoryEnrich.ts';
import type { OperationalEvent } from '../src/model.ts';

const NOW = 1_775_000_000_000;

test('unresolved ids are distinct, exclude already-resolved items, and are capped', () => {
	const events = [{ resourceId: 'i1' }, { resourceId: 'i2' }, { resourceId: 'i1' }, { resourceId: undefined }];
	assert.deepEqual(unresolvedIds(events, new Set(['i2'])), ['i1']);
	const many = Array.from({ length: ENRICH_BATCH + 10 }, (_u, i) => ({ resourceId: `i${i}` }));
	assert.equal(unresolvedIds(many, new Set()).length, ENRICH_BATCH);
});

test('an inventory item row is keyed by shop and item and carries the product facts', () => {
	const row = inventoryItemRow('s1', { inventoryItemId: 'i1', sku: 'TSHIRT', productTitle: 'T-Shirt', variantTitle: 'M / Black' }, NOW);
	assert.equal(row.id, 's1:i1');
	assert.equal(row.shopId, 's1');
	assert.equal(row.sku, 'TSHIRT');
	assert.equal(row.productTitle, 'T-Shirt');
	assert.equal(row.variantTitle, 'M / Black');
	assert.equal(row.updatedAt, NOW);
});

test('a location row is keyed by shop and location', () => {
	const row = locationRow('s1', { locationId: 'l1', name: 'Brooklyn' }, NOW);
	assert.equal(row.id, 's1:l1');
	assert.equal(row.name, 'Brooklyn');
});

test('an enriched inventory event gets exactly one SKU index row', () => {
	const event: OperationalEvent = { eventId: 's1:w9', shopId: 's1', domain: 'inventory', topic: 'inventory_levels/update', resourceId: 'i1', quantity: 4, source: 'webhook', occurredAt: NOW, receivedAt: NOW };
	const rows = skuRowsForInventoryEvent(event, 'TSHIRT');
	assert.equal(rows.length, 1);
	assert.equal(rows[0].id, 's1:w9:TSHIRT');
	assert.equal(rows[0].sku, 'TSHIRT');
	assert.equal(rows[0].domain, 'inventory');
	assert.equal(rows[0].receivedAt, NOW);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && node --test test/inventoryEnrich.test.ts`
Expected: FAIL — cannot find module `../src/inventoryEnrich.ts`.

- [ ] **Step 3: Implement `app/src/inventoryEnrich.ts`**

```typescript
import type { EventSku, InventoryItem, OperationalEvent, ShopLocation } from './model.ts';
import { eventSkuRows } from './eventSkus.ts';

// Inventory webhooks carry only `inventory_item_id` and a number, which is
// unreadable to a merchant and unsearchable by SKU. This module holds the pure
// parts of resolving those ids into product facts through cached Admin API reads;
// the I/O loop lives in jobs.ts.

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && node --test test/inventoryEnrich.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing test for the Admin API readers**

Add to `app/test/reconcile.test.ts` (which already tests `adminApi` shaping with an injected `fetch`; match its existing fake-fetch helper):

```typescript
test('fetchInventoryItems maps GraphQL nodes to inventory item facts', async () => {
	const body = {
		data: {
			nodes: [
				{ id: 'gid://shopify/InventoryItem/111', sku: 'TSHIRT', variant: { title: 'M / Black', product: { title: 'T-Shirt' } } },
				null,
			],
		},
	};
	const fetchImpl = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
	const facts = await fetchInventoryItems('s.myshopify.com', 't', ['111', '222'], fetchImpl);
	assert.deepEqual(facts, [{ inventoryItemId: '111', sku: 'TSHIRT', productTitle: 'T-Shirt', variantTitle: 'M / Black' }]);
});

test('fetchLocations maps GraphQL nodes to location facts', async () => {
	const body = { data: { locations: { nodes: [{ id: 'gid://shopify/Location/987', name: 'Brooklyn' }] } } };
	const fetchImpl = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
	assert.deepEqual(await fetchLocations('s.myshopify.com', 't', fetchImpl), [{ locationId: '987', name: 'Brooklyn' }]);
});
```

- [ ] **Step 6: Run test to verify it fails, then implement the readers**

Run: `cd app && node --test test/reconcile.test.ts`
Expected: FAIL — `fetchInventoryItems` is not exported.

Add to `app/src/adminApi.ts`:

```typescript
const INVENTORY_ITEMS_QUERY = `query($ids:[ID!]!){nodes(ids:$ids){... on InventoryItem{id sku variant{title product{title}}}}}`;

// Resolve inventory item ids to their SKU/product facts. Ids arrive as numeric
// strings (matching the webhook's inventory_item_id) and are widened to gids for
// the API. Nodes that no longer exist come back null and are skipped.
export async function fetchInventoryItems(
	shop: string,
	token: string,
	ids: string[],
	fetchImpl: typeof fetch = fetch,
): Promise<Array<{ inventoryItemId: string; sku?: string; productTitle?: string; variantTitle?: string }>> {
	if (ids.length === 0) return [];
	const data = await adminGraphql<{
		nodes: Array<{ id?: unknown; sku?: unknown; variant?: { title?: unknown; product?: { title?: unknown } } } | null>;
	}>(shop, token, INVENTORY_ITEMS_QUERY, { ids: ids.map((id) => `gid://shopify/InventoryItem/${id}`) }, fetchImpl);
	const out: Array<{ inventoryItemId: string; sku?: string; productTitle?: string; variantTitle?: string }> = [];
	for (const node of data.nodes ?? []) {
		if (!node) continue;
		const inventoryItemId = numericId(node.id);
		if (!inventoryItemId) continue;
		out.push({
			inventoryItemId,
			sku: typeof node.sku === 'string' && node.sku.length > 0 ? node.sku : undefined,
			productTitle: typeof node.variant?.product?.title === 'string' ? node.variant.product.title : undefined,
			variantTitle: typeof node.variant?.title === 'string' ? node.variant.title : undefined,
		});
	}
	return out;
}

const LOCATIONS_QUERY = `{locations(first:100){nodes{id name}}}`;

// A shop's locations. Small and slow-changing, so the whole set is cached in one
// call rather than resolved per event.
export async function fetchLocations(
	shop: string,
	token: string,
	fetchImpl: typeof fetch = fetch,
): Promise<Array<{ locationId: string; name?: string }>> {
	const data = await adminGraphql<{ locations: { nodes: Array<{ id?: unknown; name?: unknown }> } }>(
		shop,
		token,
		LOCATIONS_QUERY,
		{},
		fetchImpl,
	);
	const out: Array<{ locationId: string; name?: string }> = [];
	for (const node of data.locations?.nodes ?? []) {
		const locationId = numericId(node.id);
		if (!locationId) continue;
		out.push({ locationId, name: typeof node.name === 'string' ? node.name : undefined });
	}
	return out;
}
```

Run: `cd app && node --test test/reconcile.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit the pure + transport layers**

```bash
git add app/src/inventoryEnrich.ts app/src/adminApi.ts app/test/inventoryEnrich.test.ts app/test/reconcile.test.ts
git commit -m "feat(inventory): Admin API readers and pure enrichment helpers"
```

- [ ] **Step 8: Add the enrichment loop to `app/jobs.ts`**

Add after the reconcile loop section:

```typescript
// Inventory enrichment. An inventory webhook carries only inventory_item_id and
// a quantity, which is unreadable to a merchant and unsearchable by SKU. This
// sweep resolves unseen item ids (and the shop's locations) through the Admin API
// once, caches them, and backfills EventSku rows so inventory events become
// SKU-searchable like every other domain.
//
// Cheap by construction: it only ever looks at inventory events from the read
// window, only resolves ids not already cached, and stops after one batch per
// tick — a shop with a stable catalog converges and then does nothing.
const ENRICH_INTERVAL_MS = 900_000; // 15 minutes
const ENRICH_INITIAL_DELAY_MS = 60_000;
const enrichTicker = ticker('inventory.enrich', 30 * 60_000);

export async function runInventoryEnrichment(now = Date.now()): Promise<{ items: number; locations: number; indexed: number }> {
	let items = 0;
	let locations = 0;
	let indexed = 0;
	for await (const s of Shops.search({ conditions: [{ attribute: 'status', value: 'active' }] })) {
		const shopId = (s as { shopId: string }).shopId;
		const token = await getUsableAccessToken(tokenDeps, shopId, now);
		if (!token) continue;

		// Locations: one small call, refreshed when we have none cached.
		let cachedLocations = 0;
		for await (const _l of ShopLocations.search({ conditions: [{ attribute: 'shopId', value: shopId }], select: ['id'], limit: 1 })) {
			cachedLocations++;
		}
		if (cachedLocations === 0) {
			try {
				for (const location of await fetchLocations(shopId, token)) {
					await ShopLocations.put(locationRow(shopId, location, now));
					locations++;
				}
			} catch (e: unknown) {
				log('warn', 'enrich.locations.failed', { shop: shopId, message: (e as Error).message });
			}
		}

		// Inventory events in the window, and which item ids we already know.
		const inventoryEvents: OperationalEvent[] = [];
		for await (const e of Events.search({
			conditions: [
				{ attribute: 'shopId', value: shopId },
				{ attribute: 'domain', value: 'inventory' },
				{ attribute: 'receivedAt', value: now - 7 * 86_400_000, comparator: 'greater_than_equal' },
			],
			operator: 'and',
		})) {
			inventoryEvents.push(e as unknown as OperationalEvent);
		}
		if (inventoryEvents.length === 0) continue;

		const resolved = new Set<string>();
		const skuById = new Map<string, string>();
		for await (const row of InventoryItems.search({ conditions: [{ attribute: 'shopId', value: shopId }] })) {
			const item = row as unknown as InventoryItem;
			resolved.add(item.inventoryItemId);
			if (item.sku) skuById.set(item.inventoryItemId, item.sku);
		}

		const wanted = unresolvedIds(inventoryEvents, resolved);
		if (wanted.length > 0) {
			try {
				for (const facts of await fetchInventoryItems(shopId, token, wanted)) {
					await InventoryItems.put(inventoryItemRow(shopId, facts, now));
					resolved.add(facts.inventoryItemId);
					if (facts.sku) skuById.set(facts.inventoryItemId, facts.sku);
					items++;
				}
			} catch (e: unknown) {
				log('warn', 'enrich.items.failed', { shop: shopId, message: (e as Error).message });
			}
		}

		// Backfill the SKU index for every event whose item we can now name. Keys are
		// deterministic, so re-running writes the same rows.
		for (const event of inventoryEvents) {
			const sku = event.resourceId ? skuById.get(event.resourceId) : undefined;
			if (!sku) continue;
			for (const row of skuRowsForInventoryEvent(event, sku)) {
				await EventSkus.put(row);
				indexed++;
			}
		}
	}
	return { items, locations, indexed };
}

function enrichTick(): void {
	void enrichTicker.run(async () => {
		try {
			const r = await runInventoryEnrichment();
			if (r.items || r.locations || r.indexed) log('trace', 'enrich.tick', r);
		} catch (e: unknown) {
			log('error', 'enrich.error', { message: (e as Error).message });
		}
	});
}

export function startInventoryEnrichmentLoop(): void {
	setTimeout(enrichTick, ENRICH_INITIAL_DELAY_MS);
	setInterval(enrichTick, ENRICH_INTERVAL_MS);
}
```

Add `startInventoryEnrichmentLoop();` to the block of loop starts at the bottom of the file, and extend the imports: `InventoryItems, ShopLocations` from `./src/db.ts`; `fetchInventoryItems, fetchLocations` from `./src/adminApi.ts`; `ENRICH_BATCH` is not needed here but `inventoryItemRow, locationRow, skuRowsForInventoryEvent, unresolvedIds` are, from `./src/inventoryEnrich.ts`; and `InventoryItem` from `./src/model.ts`.

- [ ] **Step 9: Add the caches to redaction (not to retention)**

In `app/src/ledgerTargets.ts`, add to `REDACT_TARGETS` only:

```typescript
	{ name: 'InventoryItem', keyField: 'id', shopField: 'shopId', table: purgeable(InventoryItems) },
	{ name: 'ShopLocation', keyField: 'id', shopField: 'shopId', table: purgeable(ShopLocations) },
```

Add a comment above them:

```typescript
	// Reference caches, NOT ledger records: they carry no order or customer linkage
	// and are useless once the shop is gone, so they are erased by shop redaction
	// but deliberately not aged out by the seven-day purge (re-fetching them every
	// week would be pointless Admin API traffic).
```

Add `InventoryItems, ShopLocations` to the `./db.ts` import.

- [ ] **Step 10: Surface the resolved names on event detail**

In `app/src/queries.ts`, extend `getEventDetail`'s signature and body so an inventory event reports what it is about:

```typescript
export async function getEventDetail(
	events: QueryTable,
	projections: QueryTable,
	findings: QueryTable,
	shopId: string,
	eventId: string,
	inventoryItems?: QueryTable,
	locations?: QueryTable,
): Promise<Record<string, unknown> | null> {
```

Then, immediately before the return, add:

```typescript
	// Human-readable context for the opaque ids on an inventory event. Both are
	// keyed gets against this shop's own cache rows; a cache miss simply omits the
	// field rather than blocking the detail view.
	let inventorySku: string | undefined;
	let productTitle: string | undefined;
	if (row.domain === 'inventory' && row.resourceId && inventoryItems) {
		const item = await inventoryItems.get(`${shopId}:${row.resourceId}`);
		if (item && item.shopId === shopId) {
			inventorySku = typeof item.sku === 'string' ? item.sku : undefined;
			productTitle = typeof item.productTitle === 'string' ? item.productTitle : undefined;
		}
	}
	let locationName: string | undefined;
	if (row.locationId && locations) {
		const location = await locations.get(`${shopId}:${row.locationId}`);
		if (location && location.shopId === shopId) {
			locationName = typeof location.name === 'string' ? location.name : undefined;
		}
	}
```

And widen the returned object:

```typescript
	return {
		...pick(row as unknown as Record<string, unknown>, EVENT_FIELDS),
		relatedEventIds,
		affectedProjection,
		affectedFinding,
		...(inventorySku ? { inventorySku } : {}),
		...(productTitle ? { productTitle } : {}),
		...(locationName ? { locationName } : {}),
	};
```

In `app/src/apiContract.ts`:
- add `'orderName'`, `'totalPrice'`, `'currency'`, `'locationId'`, `'hasTracking'`, `'trackingCompany'`, `'shipmentStatus'` to `EVENT_FIELDS`
- change the `eventDetail` entry's fields to `[...EVENT_FIELDS, 'relatedEventIds', 'affectedProjection', 'affectedFinding', 'inventorySku', 'productTitle', 'locationName']`
- add `'orderName'`, `'orderTotal'`, `'currency'`, `'fulfillmentFailedAt'`, `'hasTracking'`, `'trackingCompany'` to `PROJECTION_FIELDS`

In `app/resources.ts`, add `InventoryItems as InventoryItemsTable, ShopLocations as ShopLocationsTable` to the db import, add `const InventoryItemsQ = InventoryItemsTable as unknown as QueryTable;` and `const ShopLocationsQ = ShopLocationsTable as unknown as QueryTable;`, and pass both as the last two arguments of the `getEventDetail` call.

- [ ] **Step 11: Test the join and its tenant safety**

Add to `app/test/queries.test.ts`:

```typescript
test('an inventory event detail names its SKU, product, and location', async () => {
	const { events, projections, findings } = fixtures();
	const items = new FakeTable('id', [{ id: 's1:inv9', shopId: 's1', inventoryItemId: 'inv9', sku: 'TSHIRT', productTitle: 'T-Shirt' }]);
	const locations = new FakeTable('id', [{ id: 's1:987', shopId: 's1', locationId: '987', name: 'Brooklyn' }]);
	await events.put({ eventId: 's1:inv', shopId: 's1', domain: 'inventory', resourceId: 'inv9', locationId: '987', quantity: 4, source: 'webhook', occurredAt: NOW, receivedAt: NOW });
	const detail = await getEventDetail(events, projections, findings, 's1', 's1:inv', items, locations);
	assert.equal(detail?.inventorySku, 'TSHIRT');
	assert.equal(detail?.productTitle, 'T-Shirt');
	assert.equal(detail?.locationName, 'Brooklyn');
});

test('another tenant cache row can never name this shop event', async () => {
	const { events, projections, findings } = fixtures();
	const items = new FakeTable('id', [{ id: 's2:inv9', shopId: 's2', inventoryItemId: 'inv9', sku: 'LEAKED' }]);
	const locations = new FakeTable('id', []);
	await events.put({ eventId: 's1:inv', shopId: 's1', domain: 'inventory', resourceId: 'inv9', source: 'webhook', occurredAt: NOW, receivedAt: NOW });
	const detail = await getEventDetail(events, projections, findings, 's1', 's1:inv', items, locations);
	assert.equal(detail?.inventorySku, undefined);
});
```

Also add the same second case to `app/test/crossTenant.test.ts`, following that file's victim/attacker pattern, so the adversarial suite covers the new join.

Run: `cd app && npm run contract:gen && npm test && npm run typecheck && npm run lint:required && npm run format:check`
Expected: all PASS.

- [ ] **Step 12: Commit**

```bash
git add app/jobs.ts app/resources.ts app/src/queries.ts app/src/apiContract.ts app/src/ledgerTargets.ts contracts/sightline-api-v1.json app/test/queries.test.ts app/test/crossTenant.test.ts
git commit -m "feat(inventory): resolve item SKUs and location names, index inventory SKUs"
```

---

### Task 9: Truthful privacy disclosure and data inventory

The Privacy screen and `docs/data-inventory.md` are read by merchants **and by App Store reviewers**. Before this plan they claimed SKUs were stored when nothing populated them; after Tasks 4–8 the app additionally stores order value, tracking presence and carrier, locations, and product titles. Both directions have to be corrected in the same task the data lands, or the app ships a new inaccuracy in place of the old one.

**Files:**
- Modify: `app/src/queries.ts:351-418` (`EXCLUDED_CUSTOMER_FIELDS`, `getPrivacy`)
- Modify: `docs/data-inventory.md`
- Test: `app/test/queries.test.ts`, `app/test/privacyPolicy.test.ts`

**Interfaces:**
- Consumes: everything stored by Tasks 4–8.
- Produces: `getPrivacy`'s `dataCategories` reflects exactly what is stored; `excludedFields` unchanged.

- [ ] **Step 1: Write the failing test**

Add to `app/test/queries.test.ts`:

```typescript
test('the privacy disclosure lists every category actually stored, and no more', async () => {
	const { events, findings, projections, deliveries, shops } = fixtures();
	const privacy = await getPrivacy({ events, findings, projections, deliveries, shops }, 's1', NOW);
	const categories = privacy.dataCategories as string[];
	for (const expected of [
		'order status & timestamps',
		'order value & currency',
		'fulfillment status, location & tracking presence',
		'inventory levels',
		'refund status',
		'SKUs, product titles & quantities',
	]) {
		assert.ok(categories.includes(expected), `missing disclosure: ${expected}`);
	}
	// The exclusion list is the load-bearing promise and must not have widened.
	assert.deepEqual(privacy.excludedFields, ['customer name', 'customer email', 'customer phone', 'shipping & billing address']);
	assert.equal(privacy.storesCustomerPii, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && node --test test/queries.test.ts`
Expected: FAIL — `order value & currency` is not in the disclosure.

- [ ] **Step 3: Correct the disclosure**

In `app/src/queries.ts`, replace the `dataCategories` array in `getPrivacy` with:

```typescript
		// Exactly what the pipeline stores, in merchant language. Every entry here
		// must be true of the current schema — this list is read by merchants and by
		// App Store reviewers, so a stale entry is a compliance defect, not cosmetics.
		dataCategories: [
			'order status & timestamps',
			'order name (e.g. #1001)',
			'order value & currency',
			'fulfillment status, location & tracking presence',
			'inventory levels',
			'refund status',
			'SKUs, product titles & quantities',
		],
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && npm test`
Expected: PASS. If `app/test/view.test.ts` asserts on the old category strings, update those assertions to the new list.

- [ ] **Step 5: Update the data inventory document**

In `docs/data-inventory.md`, add rows for every new field and table, matching the file's existing table format. The additions to record:

| Table | Field(s) | Purpose | Retention |
|---|---|---|---|
| `OperationalEvent` | `orderName`, `totalPrice`, `currency` | Merchant-readable order identity and value for triage | 7-day purge |
| `OperationalEvent` | `locationId`, `hasTracking`, `trackingCompany`, `shipmentStatus` | Fulfillment context: where it shipped from, whether tracking exists | 7-day purge |
| `OrderProjection` | `orderName`, `orderTotal`, `currency`, `fulfillmentFailedAt`, `hasTracking`, `trackingCompany` | Latched order facts for detection and display | 7-day purge |
| `GapFinding` | `detector` | Which detector produced the finding | 7-day purge |
| `EventSku` | all | SKU→event index enabling SKU search | 7-day purge (shares `receivedAt` with its event) |
| `InventoryItem` | all | Admin API cache: item id → SKU/product title | Erased on uninstall/shop-redact; not aged out |
| `ShopLocation` | all | Admin API cache: location id → name | Erased on uninstall/shop-redact; not aged out |

Add one line to the document's summary: *"No field added in Plan A is a customer identifier. Money amounts, SKUs, product titles, locations, and tracking presence are Level 1 order facts; the customer-field exclusion list is unchanged."*

- [ ] **Step 6: Full verification**

Run: `cd app && npm test && npm run typecheck && npm run lint:required && npm run format:check && npm run build`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add app/src/queries.ts app/test/queries.test.ts docs/data-inventory.md
git commit -m "fix(privacy): disclosure now matches what is actually stored"
```

- [ ] **Step 8: Deploy, verify live, and open the PR**

Run: `cd app && npm run deploy && npm run smoke`
Expected: smoke passes (health, unauth 401, webhook bad-HMAC 401, authed endpoints).

Then verify on the dev store, because unit tests cannot prove the pipeline end-to-end:
1. Place an order with two distinct SKUs and pay it. Confirm via `/api/v1/events` that the `orders/paid` event carries `orderName`, `totalPrice`, `currency`.
2. Confirm `/api/v1/events?sku=<one of the SKUs>` returns that event — the defect fix, live.
3. Fulfil the order with a tracking number. Confirm the fulfillment event carries `hasTracking: true`, `trackingCompany`, `locationId`.
4. Wait for one enrichment tick (≈1 min after boot, then every 15 min) and confirm an inventory event's detail now returns `inventorySku` and `locationName`.
5. Confirm `describe_table` still shows every column added in Task 3.

Open the PR with no reviewers, then squash-merge:

```bash
gh pr create --title "feat: extract discarded operational facts, fix SKU/disclosure defects" --body "$(cat <<'EOF'
Implements Plan A (docs/superpowers/plans/2026-08-07-plan-a-data-extraction-and-defects.md).

- Captures order value + fulfillment location (widened include_fields, Level 1)
- Extracts order name, currency, tracking presence/carrier, shipment status, location, SKUs
- EventSku index makes the SKU column and filter real (they always returned nothing)
- Latches failed fulfillment attempts; new fulfillment_attempt_failed detector with its own non-hedged copy
- Inventory enrichment: item id -> SKU/product, location id -> name, plus SKU indexing
- Privacy disclosure and data inventory corrected to match what is stored

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Deferred from this plan

- **Read screens for all of this.** Nothing in Plan A puts the new facts on screen — that is Plan B, which adds the orders worklist, order detail, failed-fulfillment surfacing, CSV export, and Admin deep links. Until Plan B lands, the new fields are reachable only through the API.
- **Defect 4 (Overview "last 7 days" vs unfiltered order counts).** Fixed in Plan B, where the summary/flows query work happens.
- **Reconciliation does not populate SKUs.** `synthesizeEvents` writes no `skus` because the reconcile GraphQL query does not select line items. Adding `lineItems{nodes{sku}}` to `ORDERS_QUERY` would fix it at the cost of a larger reconcile payload; deliberately left out until reconciliation-sourced SKU search is actually wanted.
</content>
</invoke>
