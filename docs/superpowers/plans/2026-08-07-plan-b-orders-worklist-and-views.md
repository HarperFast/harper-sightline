# Plan B — Orders Worklist, Integrity Views & Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Sightline's aggregate numbers into an operational worklist — a drillable orders list with aging, an order timeline, the failed-fulfillment and webhook-delivery-gap signals surfaced as first-class views, merchant-readable order names with deep links into Shopify Admin, and CSV export of any filtered list.

**Architecture:** Read-only additions only. Two new query functions (`listOrders`, `getOrderDetail`) over the existing `OrderProjection` table, one new derived-and-indexed `state` column so the worklist can be filtered and paged in the database rather than post-filtered, three new screens in the existing pure-function SPA (`app/web/src/view.ts` → markup, `main.ts` → fetch/route), and a CSV export resource that streams an allowlisted projection of the same query results. No writes to Shopify, no new scopes, no capability changes.

**Tech Stack:** Harper v5 native application (TypeScript via TypeStrip, `.ts` import extensions), Polaris web components (`s-*`) loaded from Shopify's CDN, App Bridge for Admin navigation, `node:test` + `node:assert/strict`, zero runtime dependencies.

## Global Constraints

Every task's requirements implicitly include this section.

- **Plan A must be merged first.** This plan reads `orderName`, `orderTotal`, `currency`, `fulfillmentFailedAt`, `hasTracking`, `trackingCompany`, and `GapFinding.detector` — all introduced in Plan A.
- **Read-only.** No screen may render a replay, repair, re-announce, tag, or any other write affordance. `capabilitiesFor()` grants `record` only; do not change it.
- **Zero runtime dependencies.** `app/package.json` has `devDependencies` only.
- **All tables `@table @sealed`, PRIVATE.** Never add `@export`.
- **Epoch-ms timestamps are GraphQL `Float`**, never `Int`.
- **Every query derives `shopId` from the authenticated principal, never caller input.** Every new endpoint must be covered in `app/test/crossTenant.test.ts` with a hostile-id and hostile-filter case.
- **Response fields must be allowlisted** in `app/src/apiContract.ts`, then `npm run contract:gen` re-run — `test/contract.test.ts` fails CI on drift.
- **Product-truth copy.** `FINDING_DISCLAIMER` is verbatim from the screen spec and appears on **unconfirmed absence findings only**: *"This does not prove that a warehouse or carrier failed. It means Shopify has not shown the expected fulfillment confirmation yet."* Never attach it to a `fulfillment_attempt_failed` finding (Plan A gave that detector its own accurate copy). Never write "failed" about an absence observation. Never name a warehouse, carrier, vendor, or 3PL outside the two sentences that explicitly deny the claim.
- **Every screen must handle loading, empty, partial, stale, auth-expired, and recoverable-error states**, be keyboard operable with visible focus, and give any visualization a text/table equivalent (`docs/free_mvp_screen_spec.md` global behavior; `docs/ux-review.md` §1–2).
- **Meaning must survive without colour.** Every badge pairs its tone with the status word.
- **`app/web/src/view.ts` stays pure** — no DOM, no network, no Shopify globals. That is what makes `app/test/view.test.ts` runnable in plain node. All fetching, DOM writes, and listeners live in `main.ts`.
- **Timestamps render in the store's timezone** via the existing `ts()` helper, which emits `<time datetime>` plus an exact title. Never format a date by hand.
- **Log via `log()` from `app/src/observe.ts`.** Never `console.*`.
- **Formatting:** tabs. `npm run format:check` and `npm run lint:required` must pass.
- **After any schema change to a `@sealed` table, verify with `describe_table` after deploying** — `deploy_component` intermittently drops newly-added columns.
- **Git:** branch, squash-merge, **never assign PR reviewers**. Prefixes: `feat(scope):` / `fix(scope):` / `docs:`.

---

## File Structure

**Created:**
- `app/src/orders.ts` — pure order-state derivation and aging bucketing. One responsibility: turning projection latches into the lane and age facts the worklist and summary both need, so the API and the UI cannot disagree about what "awaiting" means.
- `app/src/csv.ts` — pure CSV serialization (RFC 4180 quoting + formula-injection neutralization) and the export column maps.
- `app/test/orders.test.ts`
- `app/test/csv.test.ts`

**Modified:**
- `app/schema.graphql` — index `OrderProjection.paidAt`; redefine the (currently unwritten) `state` column's value set.
- `app/src/model.ts` — `ProjectionState` value set.
- `app/src/projection.ts` — write the derived `state`.
- `app/src/queries.ts` — `keysetPage` generalization, `listOrders`, `getOrderDetail`, aging + integrity counts in `getSummary`, window-consistency fix.
- `app/src/apiContract.ts` — order/export allowlists and filters.
- `app/resources.ts` — `OrdersResource`, `ExportResource`.
- `app/web/src/api.ts` — client types + calls for orders, order detail, export.
- `app/web/src/view.ts` — orders, order detail, integrity views; deep links; aging section; failed-fulfillment surfacing; export buttons.
- `app/web/src/main.ts` — routes, export download, filter binding.
- `app/web/index.html` — nav entries for the new screens.
- `app/test/queries.test.ts`, `app/test/view.test.ts`, `app/test/crossTenant.test.ts`, `app/test/contract.test.ts`.
- `docs/free_mvp_screen_spec.md`, `docs/ux-review.md` — record the new screens and their states.

---

### Task 1: Derived order state — one definition, filterable in the database

`OrderProjection.state` and `deadline` exist in the schema and are `@indexed`, but **nothing has ever written them** — like `sku` before Plan A, they are dead columns. Meanwhile "awaiting confirmation" is computed inline in three places (`getSummary`, `computeFlows`, and the detector's eligibility rule) with the same five-clause condition copy-pasted. This task gives that condition one home, writes the result to the existing indexed column, and thereby makes the worklist filterable and pageable in the database instead of post-filtered in code (which would return short pages and a lying "load more").

**Files:**
- Create: `app/src/orders.ts`, `app/test/orders.test.ts`
- Modify: `app/schema.graphql` (`OrderProjection.paidAt` gains `@indexed`; `state` comment), `app/src/model.ts:8` (`ProjectionState`), `app/src/projection.ts:25-47`
- Test: `app/test/projection.test.ts`

**Interfaces:**
- Consumes: `OrderProjection` latches including Plan A's `fulfillmentFailedAt`.
- Produces:
  - `type OrderLane = 'unpaid' | 'awaiting' | 'fulfilled' | 'cancelled' | 'refunded'`
  - `deriveOrderLane(p: OrderProjection): OrderLane` — the single definition of every lane
  - `isAwaitingConfirmation(p: OrderProjection): boolean` — the old five-clause condition, now named once
  - `AGE_BUCKETS: ReadonlyArray<{ key: string; label: string; minHours: number; maxHours?: number }>` — `under24`, `h24to48`, `h48to72`, `over72`
  - `ageBucketKey(paidAt: number | undefined, now: number): string | undefined`
  - `ageHours(paidAt: number | undefined, now: number): number | undefined`
  - `ProjectionState` in `model.ts` becomes `OrderLane`'s value set
  - `applyEvent` now sets `state`

- [ ] **Step 1: Write the failing tests**

Create `app/test/orders.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGE_BUCKETS, ageBucketKey, ageHours, deriveOrderLane, isAwaitingConfirmation } from '../src/orders.ts';
import type { OrderProjection } from '../src/model.ts';

const NOW = 1_775_000_000_000;
const HOUR = 3_600_000;

function p(over: Partial<OrderProjection> = {}): OrderProjection {
	return { id: 's1:o1', shopId: 's1', orderId: 'o1', ...over };
}

test('an unpaid order is unpaid whatever else is true', () => {
	assert.equal(deriveOrderLane(p({ requiresFulfillment: true })), 'unpaid');
});

test('a paid, fulfillment-eligible, unfulfilled order is awaiting', () => {
	assert.equal(deriveOrderLane(p({ paidAt: NOW, requiresFulfillment: true })), 'awaiting');
	assert.equal(isAwaitingConfirmation(p({ paidAt: NOW, requiresFulfillment: true })), true);
});

test('a digital order needs no fulfillment, so it is never awaiting', () => {
	assert.equal(deriveOrderLane(p({ paidAt: NOW, requiresFulfillment: false })), 'fulfilled');
	assert.equal(isAwaitingConfirmation(p({ paidAt: NOW, requiresFulfillment: false })), false);
});

test('fulfilled beats awaiting; cancelled and refunded beat fulfilled', () => {
	assert.equal(deriveOrderLane(p({ paidAt: NOW, requiresFulfillment: true, fulfilledAt: NOW })), 'fulfilled');
	assert.equal(deriveOrderLane(p({ paidAt: NOW, requiresFulfillment: true, fulfilledAt: NOW, cancelledAt: NOW })), 'cancelled');
	assert.equal(deriveOrderLane(p({ paidAt: NOW, requiresFulfillment: true, fullyRefundedAt: NOW })), 'refunded');
});

test('a failed fulfillment attempt does not change the lane — the order is still awaiting', () => {
	// The lane answers "where is this order", the finding answers "what went wrong".
	// Conflating them would hide a failed attempt inside a separate lane and drop it
	// out of the awaiting worklist, which is exactly where it needs to be seen.
	assert.equal(deriveOrderLane(p({ paidAt: NOW, requiresFulfillment: true, fulfillmentFailedAt: NOW })), 'awaiting');
});

test('age in hours is measured from payment and floors', () => {
	assert.equal(ageHours(NOW - 90 * 60_000, NOW), 1);
	assert.equal(ageHours(undefined, NOW), undefined);
});

test('age buckets partition the timeline with no gap and no overlap', () => {
	assert.equal(ageBucketKey(NOW - 1 * HOUR, NOW), 'under24');
	assert.equal(ageBucketKey(NOW - 30 * HOUR, NOW), 'h24to48');
	assert.equal(ageBucketKey(NOW - 60 * HOUR, NOW), 'h48to72');
	assert.equal(ageBucketKey(NOW - 100 * HOUR, NOW), 'over72');
	assert.equal(ageBucketKey(undefined, NOW), undefined);
	// Boundaries land in exactly one bucket.
	assert.equal(ageBucketKey(NOW - 24 * HOUR, NOW), 'h24to48');
	assert.equal(ageBucketKey(NOW - 72 * HOUR, NOW), 'over72');
	assert.equal(AGE_BUCKETS.length, 4);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && node --test test/orders.test.ts`
Expected: FAIL — cannot find module `../src/orders.ts`.

- [ ] **Step 3: Implement `app/src/orders.ts`**

```typescript
import type { OrderProjection } from './model.ts';

// The single definition of where an order sits and how old it is.
//
// Before this module, "paid and fulfillment-eligible and not fulfilled and not
// cancelled and not fully refunded" was copy-pasted into getSummary, computeFlows,
// and the detector's eligibility rule. Three copies of a five-clause predicate is
// three chances for the Overview tile, the flow lane, and the finding list to
// disagree about the same order. Everything derives from here now.

export type OrderLane = 'unpaid' | 'awaiting' | 'fulfilled' | 'cancelled' | 'refunded';

// Awaiting = Shopify has shown payment for an order that needs shipping, and has
// not yet shown a fulfillment confirmation, and the order has not been called off.
export function isAwaitingConfirmation(p: OrderProjection): boolean {
	return (
		p.paidAt !== undefined &&
		p.requiresFulfillment === true &&
		p.fulfilledAt === undefined &&
		p.cancelledAt === undefined &&
		p.fullyRefundedAt === undefined
	);
}

// Lanes are ordered by finality: a cancelled order is cancelled even if it was
// fulfilled first, and an unpaid order is unpaid regardless of anything else.
//
// A failed fulfillment attempt deliberately does NOT get its own lane. The lane
// answers "where is this order in the flow"; a failed attempt is a FINDING about
// an order that is still awaiting confirmation. Giving it a lane would quietly
// remove those orders from the awaiting worklist — the one list where a merchant
// most needs to see them.
export function deriveOrderLane(p: OrderProjection): OrderLane {
	if (p.paidAt === undefined) return 'unpaid';
	if (p.cancelledAt !== undefined) return 'cancelled';
	if (p.fullyRefundedAt !== undefined) return 'refunded';
	if (isAwaitingConfirmation(p)) return 'awaiting';
	return 'fulfilled';
}

const HOUR_MS = 3_600_000;

export function ageHours(paidAt: number | undefined, now: number): number | undefined {
	if (paidAt === undefined) return undefined;
	return Math.max(0, Math.floor((now - paidAt) / HOUR_MS));
}

// Aging buckets for the Overview. The 72-hour boundary is the confirmation
// detector's deadline (FULFILLMENT_DEADLINE_MS), so "over72" is exactly the set
// that has already produced findings and the earlier buckets are the ones a
// merchant can still act on before the deadline bites.
export const AGE_BUCKETS = [
	{ key: 'under24', label: 'Under 24h', minHours: 0, maxHours: 24 },
	{ key: 'h24to48', label: '24–48h', minHours: 24, maxHours: 48 },
	{ key: 'h48to72', label: '48–72h', minHours: 48, maxHours: 72 },
	{ key: 'over72', label: 'Over 72h', minHours: 72 },
] as const;

// Half-open intervals [min, max), so every age lands in exactly one bucket.
export function ageBucketKey(paidAt: number | undefined, now: number): string | undefined {
	const hours = ageHours(paidAt, now);
	if (hours === undefined) return undefined;
	for (const bucket of AGE_BUCKETS) {
		if (hours >= bucket.minHours && (bucket.maxHours === undefined || hours < bucket.maxHours)) return bucket.key;
	}
	return AGE_BUCKETS[AGE_BUCKETS.length - 1].key;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && node --test test/orders.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Redefine `ProjectionState` and write it from the reducer**

In `app/src/model.ts`, replace the `ProjectionState` line:

```typescript
// The order's lane, derived from the latches by src/orders.ts. NOTE: this
// replaces an earlier value set ('pending' | 'awaiting_window' | 'confirmed' |
// 'unconfirmed') that was declared but never written by any code path — no stored
// row has ever carried it, so redefining the column's meaning is safe.
export type ProjectionState = 'unpaid' | 'awaiting' | 'fulfilled' | 'cancelled' | 'refunded';
```

In `app/src/projection.ts`, add the import and set the state as the last step of the fold, immediately before `return next;`:

```typescript
import { deriveOrderLane } from './orders.ts';
```

```typescript
		// Derived, not latched: a pure function of the latches above, so it is
		// rebuild-equal under any event ordering. Written to the (indexed) `state`
		// column so the orders worklist can filter and page in the database rather
		// than post-filtering, which would return short pages and a false "load more".
		next.state = deriveOrderLane(next);
```

In `app/schema.graphql`, update the `OrderProjection` comments and index `paidAt`:

```graphql
	paidAt: Float @indexed # earliest paid time (latch) — indexed: the worklist sorts/filters by order age
```

```graphql
	state: String @indexed # unpaid | awaiting | fulfilled | cancelled | refunded (derived, src/orders.ts)
	deadline: Float @indexed # RESERVED — not written; the expectation owns the deadline
```

- [ ] **Step 6: Test that the reducer writes the state and stays rebuild-equal**

Add to `app/test/projection.test.ts`:

```typescript
test('the reducer writes the derived lane', () => {
	assert.equal(rebuildProjection([ev({ eventId: 'e1', domain: 'order', topic: 'orders/paid', state: 'paid', occurredAt: 100, fulfillableItemCount: 2 })])?.state, 'awaiting');
	assert.equal(
		rebuildProjection([
			ev({ eventId: 'e1', domain: 'order', topic: 'orders/paid', state: 'paid', occurredAt: 100, fulfillableItemCount: 2 }),
			ev({ eventId: 'e2', domain: 'fulfillment', state: 'success', occurredAt: 200 }),
		])?.state,
		'fulfilled',
	);
});

test('the derived lane is rebuild-equal under shuffled event order', () => {
	const events = [
		ev({ eventId: 'e1', domain: 'order', topic: 'orders/paid', state: 'paid', occurredAt: 100, fulfillableItemCount: 2 }),
		ev({ eventId: 'e2', domain: 'fulfillment', state: 'success', occurredAt: 300 }),
		ev({ eventId: 'e3', domain: 'order', topic: 'orders/cancelled', occurredAt: 400 }),
	];
	assert.equal(rebuildProjection([...events].reverse())?.state, rebuildProjection(events)?.state);
	assert.equal(rebuildProjection(events)?.state, 'cancelled');
});
```

Run: `cd app && npm test && npm run typecheck`
Expected: PASS. If any test asserted a `ProjectionState` from the old value set, update it — no stored row ever used those values.

- [ ] **Step 7: Commit, deploy, verify the column**

```bash
git add app/src/orders.ts app/src/projection.ts app/src/model.ts app/schema.graphql app/test/orders.test.ts app/test/projection.test.ts
git commit -m "feat(orders): one derived order lane, written to the indexed state column"
```

Run: `cd app && npm run deploy`

Verify with `describe_table` that `sightline_ledger.OrderProjection` still has every column and that `paidAt` is now indexed. If a column is missing, redeploy before continuing.

Existing rows have no `state` until their next event rebuilds them. That is acceptable — rows are at most 7 days old and the worklist treats a missing state as "not matching a lane filter" — but to backfill immediately, wait one reconcile sweep (10 minutes), which rebuilds every order it touches. Confirm a known paid-unfulfilled order has `state: 'awaiting'` before starting Task 2.

---

### Task 2: `/api/v1/orders` — the worklist API

**Files:**
- Modify: `app/src/queries.ts` (generalize `keysetPageDesc` → `keysetPage`; add `listOrders`, `getOrderDetail`), `app/src/apiContract.ts`, `app/resources.ts`
- Test: `app/test/queries.test.ts`, `app/test/crossTenant.test.ts`

**Interfaces:**
- Consumes: `deriveOrderLane`, `ageHours`, `isAwaitingConfirmation` (Task 1); Plan A's projection fields.
- Produces:
  - `keysetPage(table, baseConditions, sortField, idField, fields, cursorRaw, limitRaw, descending?)` — the existing helper with an ascending mode. All prior call sites keep descending behavior.
  - `ORDER_LIST_FIELDS`, `ORDER_FIELDS` in `apiContract.ts`
  - `listOrders(projections, shopId, now, params: OrderQueryParams): Promise<Page>` where `OrderQueryParams = { state?: string; minAgeHours?: number; sort?: 'oldest' | 'newest'; cursor?: string; limit?: unknown }`
  - `getOrderDetail(projections, events, findings, shopId, orderId): Promise<Record<string, unknown> | null>` — projection + its events (window-bounded, newest first, capped) + its findings
  - `GET /api/v1/orders` and `GET /api/v1/orders/:orderId`

- [ ] **Step 1: Write the failing tests**

Add to `app/test/queries.test.ts`. Extend the `fixtures()` helper's `projections` FakeTable with rows covering each lane and age (keep the existing rows; add these):

```typescript
// Added to fixtures(): four s1 orders across lanes/ages plus an s2 order that
// shares an order id, so tenant bleed is testable.
//	{ id: 's1:oA', shopId: 's1', orderId: 'oA', orderName: '#1001', paidAt: NOW - 2 * HOUR,  requiresFulfillment: true, state: 'awaiting',  lastEventAt: NOW - 2 * HOUR,  orderTotal: 50, currency: 'USD' },
//	{ id: 's1:oB', shopId: 's1', orderId: 'oB', orderName: '#1002', paidAt: NOW - 30 * HOUR, requiresFulfillment: true, state: 'awaiting',  lastEventAt: NOW - 30 * HOUR, orderTotal: 90, currency: 'USD', fulfillmentFailedAt: NOW - 20 * HOUR },
//	{ id: 's1:oC', shopId: 's1', orderId: 'oC', orderName: '#1003', paidAt: NOW - 80 * HOUR, requiresFulfillment: true, state: 'awaiting',  lastEventAt: NOW - 80 * HOUR },
//	{ id: 's1:oD', shopId: 's1', orderId: 'oD', orderName: '#1004', paidAt: NOW - 5 * HOUR,  requiresFulfillment: true, state: 'fulfilled', lastEventAt: NOW - 4 * HOUR, fulfilledAt: NOW - 4 * HOUR },
//	{ id: 's2:oA', shopId: 's2', orderId: 'oA', orderName: '#9999', paidAt: NOW - 2 * HOUR,  requiresFulfillment: true, state: 'awaiting',  lastEventAt: NOW - 2 * HOUR },

test('orders default to newest-paid first and carry the worklist columns', async () => {
	const { projections } = fixtures();
	const page = await listOrders(projections, 's1', NOW, {});
	assert.deepEqual(
		page.items.map((i) => i.orderId),
		['oD', 'oA', 'oB', 'oC'],
	);
	const first = page.items.find((i) => i.orderId === 'oA')!;
	assert.equal(first.orderName, '#1001');
	assert.equal(first.state, 'awaiting');
	assert.equal(first.orderTotal, 50);
	assert.equal(first.currency, 'USD');
	assert.equal(first.ageHours, 2);
});

test('the worklist can be sorted oldest-first, which is what triage needs', async () => {
	const { projections } = fixtures();
	const page = await listOrders(projections, 's1', NOW, { sort: 'oldest' });
	assert.deepEqual(
		page.items.map((i) => i.orderId),
		['oC', 'oB', 'oD', 'oA'],
	);
});

test('orders filter by lane', async () => {
	const { projections } = fixtures();
	const page = await listOrders(projections, 's1', NOW, { state: 'awaiting' });
	assert.deepEqual(new Set(page.items.map((i) => i.orderId)), new Set(['oA', 'oB', 'oC']));
});

test('orders filter by minimum age, which is the sub-deadline aging view', async () => {
	const { projections } = fixtures();
	const page = await listOrders(projections, 's1', NOW, { state: 'awaiting', minAgeHours: 24 });
	assert.deepEqual(new Set(page.items.map((i) => i.orderId)), new Set(['oB', 'oC']));
});

test('orders never leak another tenant order that shares an id', async () => {
	const { projections } = fixtures();
	const page = await listOrders(projections, 's1', NOW, {});
	for (const item of page.items) assert.notEqual(item.orderName, '#9999');
});

test('a hostile state filter returns nothing rather than everything', async () => {
	const { projections } = fixtures();
	const page = await listOrders(projections, 's1', NOW, { state: "awaiting' OR 1=1" });
	assert.deepEqual(page.items, []);
});

test('orders page with a stable cursor and no duplicates across pages', async () => {
	const { projections } = fixtures();
	const first = await listOrders(projections, 's1', NOW, { limit: 2 });
	const second = await listOrders(projections, 's1', NOW, { limit: 2, cursor: first.nextCursor });
	const ids = [...first.items, ...second.items].map((i) => i.orderId);
	assert.equal(new Set(ids).size, ids.length);
	assert.equal(ids.length, 4);
});

test('order detail returns the projection, its events, and its findings', async () => {
	const { projections, events, findings } = fixtures();
	const detail = await getOrderDetail(projections, events, findings, 's1', 'o1');
	assert.equal(detail?.orderId, 'o1');
	assert.ok(Array.isArray(detail?.events));
	assert.ok(Array.isArray(detail?.findings));
});

test('order detail for another tenant order returns null, whatever id is supplied', async () => {
	const { projections, events, findings } = fixtures();
	assert.equal(await getOrderDetail(projections, events, findings, 's1', '../s2:oA'), null);
	// s2 genuinely has order oA; s1 must not see it.
	const detail = await getOrderDetail(projections, events, findings, 's1', 'oA');
	assert.notEqual(detail?.orderName, '#9999');
});
```

Add `HOUR` to the file's constants if absent (`const HOUR = 3_600_000;`) and extend the imports from `../src/queries.ts` with `listOrders`, `getOrderDetail`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && node --test test/queries.test.ts`
Expected: FAIL — `listOrders` is not exported.

- [ ] **Step 3: Generalize the keyset helper**

In `app/src/queries.ts`, replace `keysetPageDesc` with:

```typescript
// Keyset pagination over a numeric sort field with the row id as a tiebreak.
// Over-fetches a small buffer and finalizes the cursor boundary in code so
// equal-timestamp rows page correctly. `descending` is the default because every
// ledger view is newest-first; the orders worklist also needs oldest-first, where
// the most overdue order belongs at the top.
async function keysetPage(
	table: QueryTable,
	baseConditions: QuerySpec['conditions'],
	sortField: string,
	idField: string,
	fields: readonly string[],
	cursorRaw: string | undefined,
	limitRaw: unknown,
	descending = true,
): Promise<Page> {
	const limit = clampLimit(limitRaw);
	const cursor = decodeCursor(cursorRaw);
	const conditions = [...baseConditions];
	if (cursor) {
		conditions.push({
			attribute: sortField,
			value: cursor.sortValue,
			comparator: descending ? 'less_than_equal' : 'greater_than_equal',
		});
	}

	const rows: Array<Record<string, unknown>> = [];
	for await (const row of table.search({
		conditions,
		operator: 'and',
		sort: { attribute: sortField, descending },
		limit: limit + 25,
	})) {
		rows.push(row);
	}
	rows.sort((a, b) => {
		const av = Number(a[sortField]);
		const bv = Number(b[sortField]);
		if (av !== bv) return descending ? bv - av : av - bv;
		const aid = String(a[idField]);
		const bid = String(b[idField]);
		return descending ? bid.localeCompare(aid) : aid.localeCompare(bid);
	});

	let start = 0;
	if (cursor) {
		start = rows.findIndex((r) => {
			const v = Number(r[sortField]);
			const id = String(r[idField]);
			return descending ? v < cursor.sortValue || (v === cursor.sortValue && id < cursor.id) : v > cursor.sortValue || (v === cursor.sortValue && id > cursor.id);
		});
		if (start < 0) start = rows.length;
	}
	const page = rows.slice(start, start + limit);
	const items = page.map((r) => pick(r, fields));
	let nextCursor: string | undefined;
	if (page.length === limit && page.length > 0) {
		const last = page[page.length - 1];
		nextCursor = encodeCursor(Number(last[sortField]), String(last[idField]));
	}
	return { items, nextCursor };
}
```

Update the three existing call sites (`listEvents`'s two paths and `listFindings`) from `keysetPageDesc(` to `keysetPage(` — their behavior is unchanged because `descending` defaults to `true`.

- [ ] **Step 4: Implement the order queries**

Add to `app/src/queries.ts`:

```typescript
export interface OrderQueryParams {
	state?: string;
	minAgeHours?: number;
	sort?: 'oldest' | 'newest';
	cursor?: string;
	limit?: unknown;
}

// GET /orders — the operational worklist the Overview's counts drill into.
//
// Sorted and filtered in the DATABASE on the indexed `paidAt` and `state`
// columns. Post-filtering in code was the alternative and is wrong here: it
// returns short pages and a `nextCursor` that implies more matches than exist.
//
// `ageHours` is computed per row rather than stored, because it changes every
// hour and a stored copy would be stale the moment it was written.
export async function listOrders(projections: QueryTable, shopId: string, now: number, params: OrderQueryParams): Promise<Page> {
	const windowStart = now - WINDOW_MS;
	const conditions: QuerySpec['conditions'] = [
		{ attribute: 'shopId', value: shopId },
		// Same window bound the flow lanes use, so the worklist and the lane counts
		// describe the same set of orders.
		{ attribute: 'lastEventAt', value: windowStart, comparator: 'greater_than_equal' },
	];
	if (params.state) conditions.push({ attribute: 'state', value: params.state });
	// "At least N hours old" is "paid at or before now − N hours".
	if (params.minAgeHours !== undefined && Number.isFinite(params.minAgeHours)) {
		conditions.push({ attribute: 'paidAt', value: now - params.minAgeHours * 3_600_000, comparator: 'less_than_equal' });
	}

	const page = await keysetPage(projections, conditions, 'paidAt', 'id', ORDER_LIST_FIELDS, params.cursor, params.limit, params.sort !== 'oldest');
	return {
		items: page.items.map((item) => {
			const hours = ageHours(item.paidAt as number | undefined, now);
			return hours === undefined ? item : { ...item, ageHours: hours };
		}),
		nextCursor: page.nextCursor,
	};
}

// GET /orders/:orderId — one order's latched facts, its normalized events in the
// window (newest first, bounded), and any findings about it. This is the
// order-centric forensics view: everything Sightline observed about one order,
// without needing a finding to exist first.
export async function getOrderDetail(
	projections: QueryTable,
	events: QueryTable,
	findings: QueryTable,
	shopId: string,
	orderId: string,
): Promise<Record<string, unknown> | null> {
	// Keyed by `${shopId}:${orderId}`, so a manipulated orderId can only ever miss.
	const projection = await projections.get(`${shopId}:${orderId}`);
	if (!projection || projection.shopId !== shopId) return null;

	const eventRows: Array<Record<string, unknown>> = [];
	for await (const row of events.search({
		conditions: [
			{ attribute: 'shopId', value: shopId },
			{ attribute: 'resourceId', value: orderId },
		],
		operator: 'and',
		sort: { attribute: 'occurredAt', descending: true },
		limit: MAX_LIMIT,
	})) {
		eventRows.push(pick(row, EVENT_FIELDS));
	}

	const findingRows: Array<Record<string, unknown>> = [];
	for await (const row of findings.search({
		conditions: [
			{ attribute: 'shopId', value: shopId },
			{ attribute: 'orderId', value: orderId },
		],
		operator: 'and',
	})) {
		findingRows.push({ ...pick(row, FINDING_FIELDS), description: describeFinding(row as unknown as GapFinding) });
	}

	return {
		...pick(projection, ORDER_FIELDS),
		events: eventRows,
		findings: findingRows,
	};
}
```

Add `ageHours` to the imports from `./orders.ts`, and `MAX_LIMIT`, `ORDER_FIELDS`, `ORDER_LIST_FIELDS` to the imports from `./apiContract.ts`.

- [ ] **Step 5: Add the contract entries**

In `app/src/apiContract.ts`, add after `PROJECTION_FIELDS`:

```typescript
// The orders worklist. `ageHours` is computed per request, not stored.
export const ORDER_LIST_FIELDS = [
	'orderId',
	'orderName',
	'state',
	'paidAt',
	'fulfilledAt',
	'cancelledAt',
	'fullyRefundedAt',
	'fulfillmentFailedAt',
	'hasTracking',
	'trackingCompany',
	'orderTotal',
	'currency',
	'lastEventAt',
	'ageHours',
] as const;
export const ORDER_FIELDS = [...ORDER_LIST_FIELDS, 'requiresFulfillment', 'fulfillableItemCount'] as const;
```

And add to `API_CONTRACT.resources`:

```typescript
			orders: {
				path: '/api/v1/orders',
				item: ORDER_LIST_FIELDS,
				paginated: true,
				filters: ['state', 'minAgeHours', 'sort', 'cursor', 'limit'],
			},
			orderDetail: { path: '/api/v1/orders/:orderId', fields: [...ORDER_FIELDS, 'events', 'findings'] },
```

- [ ] **Step 6: Add the resource**

In `app/resources.ts`, add after `FlowsResource`:

```typescript
// The operational worklist (orders and one order's full observed history). Every
// count on the Overview drills in here, so this is the endpoint that turns
// aggregates into something a merchant can act on.
export class OrdersResource extends Resource {
	static path = '/api/v1/orders';
	allowRead() {
		return true;
	}
	async get() {
		const ctx = this.getContext();
		const shopId = (await identity.authenticate(ctx)).shopId;
		const url = parseUrl(ctx.url);
		const orderId = trailingId(url.pathname, '/api/v1/orders');
		if (orderId) {
			const detail = await getOrderDetail(ProjectionsQ, EventsQ, FindingsQ, shopId, orderId);
			if (!detail) throw httpError('order not found', 404);
			return detail;
		}
		const p = url.searchParams;
		return listOrders(ProjectionsQ, shopId, Date.now(), {
			state: p.get('state') ?? undefined,
			minAgeHours: numParam(p, 'minAgeHours'),
			sort: p.get('sort') === 'oldest' ? 'oldest' : 'newest',
			cursor: p.get('cursor') ?? undefined,
			limit: p.get('limit') ?? undefined,
		});
	}
}
```

Add `listOrders, getOrderDetail` to the import from `./src/queries.ts`.

- [ ] **Step 7: Add the adversarial cross-tenant cases**

Add to `app/test/crossTenant.test.ts`, following that file's victim/attacker pattern, cases asserting that: `listOrders` for the attacker never returns a victim order that shares an order id; `getOrderDetail` returns `null` for the victim's order id; a crafted cursor from the victim's page does not surface victim rows for the attacker; and a hostile `state`/`minAgeHours` cannot widen the result set beyond the attacker's own shop.

- [ ] **Step 8: Run everything**

Run: `cd app && npm run contract:gen && npm test && npm run typecheck && npm run lint:required && npm run format:check`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add app/src/queries.ts app/src/apiContract.ts app/resources.ts contracts/sightline-api-v1.json app/test/queries.test.ts app/test/crossTenant.test.ts
git commit -m "feat(api): orders worklist and order detail endpoints"
```

---

### Task 3: Orders screen — the worklist

**Files:**
- Modify: `app/web/src/api.ts`, `app/web/src/view.ts`, `app/web/src/main.ts`, `app/web/index.html`
- Test: `app/test/view.test.ts`

**Interfaces:**
- Consumes: `GET /api/v1/orders` (Task 2).
- Produces:
  - `api.ts`: `interface OrderItem { orderId: string; orderName?: string; state: string; paidAt?: number; fulfilledAt?: number; cancelledAt?: number; fullyRefundedAt?: number; fulfillmentFailedAt?: number; hasTracking?: boolean; trackingCompany?: string; orderTotal?: number; currency?: string; lastEventAt?: number; ageHours?: number }`, `apiOrders(params)`
  - `view.ts`: `ORDER_STATES`, `ORDER_SORTS`, `ORDER_FILTER_KEYS`, `orderQuery(params)`, `money(amount, currency)`, `ordersView(params, items, hasMore, strip)`
  - `main.ts`: the `#/orders` route

- [ ] **Step 1: Add the client types and call**

In `app/web/src/api.ts`, add the interface above `Page`, and the call at the bottom:

```typescript
export interface OrderItem {
	orderId: string;
	orderName?: string;
	state: string;
	paidAt?: number;
	fulfilledAt?: number;
	cancelledAt?: number;
	fullyRefundedAt?: number;
	fulfillmentFailedAt?: number;
	hasTracking?: boolean;
	trackingCompany?: string;
	orderTotal?: number;
	currency?: string;
	lastEventAt?: number;
	ageHours?: number;
}
export interface OrderDetail extends OrderItem {
	requiresFulfillment?: boolean;
	fulfillableItemCount?: number;
	events: EventItem[];
	findings: Array<FindingItem & { description: string }>;
}
```

```typescript
export const apiOrders = (params: Record<string, string | undefined>) => get<Page<OrderItem>>(`/api/v1/orders${qs(params)}`);
export const apiOrder = (orderId: string) => get<OrderDetail>(`/api/v1/orders/${encodeURIComponent(orderId)}`);
```

- [ ] **Step 2: Write the failing view tests**

Add to `app/test/view.test.ts`:

```typescript
function order(over: Partial<OrderItem> = {}): OrderItem {
	return { orderId: '7518851989809', orderName: '#1001', state: 'awaiting', paidAt: NOW - 30 * HOUR, ageHours: 30, orderTotal: 129.95, currency: 'USD', ...over };
}

test('the orders worklist shows the merchant-facing name, lane, age and value', () => {
	const html = ordersView({}, [order()], false, '');
	assert.match(html, /#1001/);
	assert.match(html, /awaiting/);
	assert.match(html, /30h/);
	assert.match(html, /\$129\.95|129\.95/);
});

test('an order with no name falls back to its id so the row is never blank', () => {
	const html = ordersView({}, [order({ orderName: undefined })], false, '');
	assert.match(html, /7518851989809/);
});

test('a failed fulfillment attempt is flagged on the row without accusing anyone', () => {
	const html = ordersView({}, [order({ fulfillmentFailedAt: NOW - 20 * HOUR })], false, '');
	assert.match(html, /attempt did not succeed|failed attempt/i);
	assert.doesNotMatch(html, /warehouse|carrier|vendor|3PL/i);
});

test('the orders screen offers lane, age and sort filters reflected in the URL', () => {
	const html = ordersView({ state: 'awaiting', minAgeHours: '24', sort: 'oldest' }, [order()], false, '');
	assert.match(html, /id="f-state"/);
	assert.match(html, /id="f-minAgeHours"/);
	assert.match(html, /id="f-sort"/);
	assert.match(html, /value="awaiting" selected/);
	assert.match(html, /value="24" selected/);
	assert.match(html, /value="oldest" selected/);
});

test('an empty worklist says so rather than rendering an empty table', () => {
	assert.match(ordersView({}, [], false, ''), /No orders match/);
});

test('load more appears only when there is another page', () => {
	assert.match(ordersView({}, [order()], true, ''), /id="loadMore"/);
	assert.doesNotMatch(ordersView({}, [order()], false, ''), /id="loadMore"/);
});

test('a hostile order name cannot inject markup', () => {
	const html = ordersView({}, [order({ orderName: '"><script>alert(1)</script>' })], false, '');
	assert.doesNotMatch(html, /<script>alert/);
});

test('money renders with its currency and omits gracefully when absent', () => {
	assert.match(money(129.95, 'USD'), /129\.95/);
	assert.equal(money(undefined, 'USD'), '—');
	assert.equal(money(129.95, undefined), '129.95');
});

test('the orders screen is Polaris markup like every other screen', () => {
	const html = ordersView({}, [order()], false, '');
	assert.match(html, /<s-page/);
	assert.match(html, /<s-section/);
	assert.match(html, /<s-table/);
});
```

Extend the imports in `view.test.ts` with `money`, `ordersView`, and `type OrderItem`.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd app && node --test test/view.test.ts`
Expected: FAIL — `ordersView` is not exported.

- [ ] **Step 4: Implement the view**

In `app/web/src/view.ts`, add the money helper next to the other primitives:

```typescript
// Money for display. Intl gives the merchant's own currency formatting; an
// unknown/absent currency degrades to the bare amount rather than guessing a
// symbol, and an absent amount is an em dash like every other missing value.
export function money(amount: number | undefined, currency: string | undefined): string {
	if (amount === undefined || amount === null) return '—';
	if (!currency) return amount.toFixed(2);
	try {
		return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
	} catch {
		return `${amount.toFixed(2)} ${currency}`;
	}
}
```

Then add the orders section:

```typescript
// ── orders ───────────────────────────────────────────────────────────────────
// The worklist: every order Sightline is tracking, with its lane, its age since
// payment, and its value. This is what the Overview's counts drill into — before
// it existed, "Awaiting confirmation: 14" was a number with nowhere to go, and
// the only order list was the findings list, which shows only orders that have
// ALREADY blown the deadline.
export const ORDER_STATES = ['', 'awaiting', 'fulfilled', 'cancelled', 'refunded', 'unpaid'];
export const ORDER_SORTS: Array<[string, string]> = [
	['newest', 'Newest first'],
	['oldest', 'Oldest first (most overdue)'],
];
// Sub-deadline aging: the confirmation detector waits 72h, so these let a
// merchant see what is heading that way while it can still be acted on.
export const ORDER_AGES: Array<[string, string]> = [
	['', 'Any age'],
	['12', 'Paid over 12h ago'],
	['24', 'Paid over 24h ago'],
	['48', 'Paid over 48h ago'],
	['72', 'Paid over 72h ago'],
];
export const ORDER_FILTER_KEYS = ['state', 'minAgeHours', 'sort'];

export function orderQuery(params: Record<string, string>): Record<string, string> {
	const q: Record<string, string> = {};
	for (const key of ORDER_FILTER_KEYS) {
		if (params[key]) q[key] = params[key];
	}
	return q;
}

// The order's own label, never a blank cell: Shopify's merchant-facing name when
// we have it, otherwise the raw id (which is at least copy-pasteable).
export function orderLabel(o: { orderName?: string; orderId: string }): string {
	return o.orderName ?? o.orderId;
}

function ageCell(o: OrderItem): string {
	if (o.ageHours === undefined) return '—';
	return o.ageHours < 24 ? `${o.ageHours}h` : `${Math.floor(o.ageHours / 24)}d ${o.ageHours % 24}h`;
}

// A failed attempt is stated as an observation of Shopify's own record. It is
// direct evidence — Shopify recorded the attempt as unsuccessful — so it does not
// hedge like an absence finding, and it still names no downstream party.
function attemptFlag(o: OrderItem): string {
	return o.fulfillmentFailedAt !== undefined ? ` ${badge('attempt did not succeed', 'critical')}` : '';
}

export function ordersView(params: Record<string, string>, items: OrderItem[], hasMore: boolean, strip: string): string {
	const rows = items
		.map(
			(o) => `<s-table-row>
			<s-table-cell><s-link href="#/orders/${encodeURIComponent(o.orderId)}">${esc(orderLabel(o))}</s-link></s-table-cell>
			<s-table-cell>${badge(o.state)}${attemptFlag(o)}</s-table-cell>
			<s-table-cell>${ts(o.paidAt)}</s-table-cell>
			<s-table-cell>${esc(ageCell(o))}</s-table-cell>
			<s-table-cell>${money(o.orderTotal, o.currency)}</s-table-cell>
			<s-table-cell>${o.hasTracking ? esc(o.trackingCompany ?? 'yes') : '—'}</s-table-cell>
		</s-table-row>`,
		)
		.join('');
	const stateOptions = ORDER_STATES.map(
		(v) => `<option value="${esc(v)}"${v === (params.state ?? '') ? ' selected' : ''}>${esc(v || 'Any lane')}</option>`,
	).join('');
	const ageOptions = ORDER_AGES.map(
		([v, label]) => `<option value="${esc(v)}"${v === (params.minAgeHours ?? '') ? ' selected' : ''}>${esc(label)}</option>`,
	).join('');
	const sortOptions = ORDER_SORTS.map(
		([v, label]) => `<option value="${esc(v)}"${v === (params.sort ?? 'newest') ? ' selected' : ''}>${esc(label)}</option>`,
	).join('');

	return page(
		'Orders',
		`${strip}
		<s-section heading="Orders Sightline is tracking">
			<s-paragraph><s-text color="subdued">Every order observed in the last 7 days, with how long it has been waiting since payment. Sightline is read-only — nothing here changes your store.</s-text></s-paragraph>
			<s-stack id="orderFilters" direction="inline" gap="base" alignItems="end">
				<s-select id="f-state" label="Lane">${stateOptions}</s-select>
				<s-select id="f-minAgeHours" label="Age">${ageOptions}</s-select>
				<s-select id="f-sort" label="Sort">${sortOptions}</s-select>
				<s-button variant="primary" data-submit>Filter</s-button>
			</s-stack>
		</s-section>
		<s-section>
			${table(
				[{ label: 'Order' }, { label: 'Lane' }, { label: 'Paid' }, { label: 'Waiting' }, { label: 'Value', numeric: true }, { label: 'Tracking' }],
				rows,
				'No orders match.',
			)}
			${hasMore ? `<s-button id="loadMore">Load more</s-button>` : ''}
		</s-section>`,
	);
}
```

Add `OrderItem` to the type import at the top of `view.ts`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd app && node --test test/view.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire the route and the nav**

In `app/web/src/main.ts`, add the screen function beside the others:

```typescript
let orderItems: OrderItem[] = [];
let orderCursor: string | undefined;
let orderQueryActive: Record<string, string> = {};

async function ordersList(params: Record<string, string>): Promise<void> {
	loading();
	orderItems = [];
	orderCursor = undefined;
	orderQueryActive = orderQuery(params);
	const contextHtml = await strip();
	const first = await apiOrders(orderQueryActive);
	orderItems = first.items;
	orderCursor = first.nextCursor;
	paintOrders(params, contextHtml);
}

function paintOrders(params: Record<string, string>, contextHtml: string): void {
	render(ordersView(params, orderItems, Boolean(orderCursor), contextHtml));
	bindFilters('orderFilters', () => {
		const q = new URLSearchParams();
		for (const key of ORDER_FILTER_KEYS) {
			const v = fieldValue(`f-${key}`);
			if (v) q.set(key, v);
		}
		location.hash = `#/orders${q.toString() ? `?${q}` : ''}`;
	});
	document.getElementById('loadMore')?.addEventListener('click', async () => {
		const next = await apiOrders({ ...orderQueryActive, cursor: orderCursor });
		orderItems.push(...next.items);
		orderCursor = next.nextCursor;
		paintOrders(params, contextHtml);
	});
}
```

In `route()`, add before the `/events` branch:

```typescript
			else if (path === '/orders') await ordersList(params);
```

Extend `main.ts`'s imports: `apiOrders`, `type OrderItem` from `./api.ts`; `ordersView`, `orderQuery`, `ORDER_FILTER_KEYS` from `./view.ts`.

In `app/web/index.html`, add an Orders entry to **both** navs, positioned after Overview (it is the second-most-used screen):

```html
			<s-link href="#/orders">Orders</s-link>
```

```html
			<s-link href="#/orders" data-nav="/orders">Orders</s-link>
```

- [ ] **Step 7: Verify the build and full suite**

Run: `cd app && npm test && npm run typecheck && npm run build && npm run lint:required && npm run format:check`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add app/web/src/api.ts app/web/src/view.ts app/web/src/main.ts app/web/index.html app/test/view.test.ts
git commit -m "feat(ui): orders worklist screen with lane, age and value"
```

---

### Task 4: Order detail — the observed timeline for any order

The finding detail already shows a "What Sightline observed" timeline, but only for orders that produced a finding. This gives every order the same forensics view.

**Files:**
- Modify: `app/web/src/view.ts`, `app/web/src/main.ts`
- Test: `app/test/view.test.ts`

**Interfaces:**
- Consumes: `apiOrder` (Task 3's client addition), `GET /api/v1/orders/:orderId` (Task 2).
- Produces: `orderTimeline(o: OrderDetail): Array<{ at: number; text: string }>`, `orderDetailView(o: OrderDetail, strip: string): string`, the `#/orders/:id` route.

- [ ] **Step 1: Write the failing tests**

Add to `app/test/view.test.ts`:

```typescript
function orderDetail(over: Partial<OrderDetail> = {}): OrderDetail {
	return {
		orderId: '7518851989809',
		orderName: '#1001',
		state: 'awaiting',
		paidAt: NOW - 30 * HOUR,
		ageHours: 30,
		orderTotal: 129.95,
		currency: 'USD',
		requiresFulfillment: true,
		events: [],
		findings: [],
		...over,
	};
}

test('the order timeline is chronological and every entry is an observation', () => {
	const entries = orderTimeline(orderDetail({ paidAt: 300, fulfillmentFailedAt: 500, fulfilledAt: 700 }));
	assert.deepEqual(
		entries.map((e) => e.at),
		[300, 500, 700],
	);
	assert.match(entries[0].text, /paid/i);
	assert.match(entries[1].text, /did not succeed/i);
	assert.match(entries[2].text, /confirmation observed/i);
});

test('order detail renders the timeline, the events, and any findings', () => {
	const html = orderDetailView(
		orderDetail({
			events: [{ eventId: 's1:e1', domain: 'order', topic: 'orders/paid', source: 'webhook', occurredAt: NOW - 30 * HOUR, receivedAt: NOW - 30 * HOUR }],
			findings: [{ id: 'f1', orderId: '7518851989809', status: 'unconfirmed', detectedAt: NOW - 2 * HOUR, description: 'No Shopify fulfillment confirmation was observed for this paid, fulfillment-eligible order by the expected time.' }],
		}),
		'',
	);
	assert.match(html, /#1001/);
	assert.match(html, /What Sightline observed/);
	assert.match(html, /orders\/paid/);
	assert.match(html, /No Shopify fulfillment confirmation/);
});

test('order detail has a breadcrumb back to the worklist', () => {
	assert.match(orderDetailView(orderDetail(), ''), /href="#\/orders"/);
});

test('an order with nothing but a payment still renders, with an empty-state note', () => {
	const html = orderDetailView(orderDetail({ events: [], findings: [] }), '');
	assert.match(html, /No events recorded|No findings/);
});

test('order detail never claims a downstream party failed', () => {
	const html = orderDetailView(orderDetail({ fulfillmentFailedAt: NOW - 5 * HOUR }), '');
	assert.doesNotMatch(html, /warehouse|carrier|vendor|3PL/i);
});
```

Extend the imports with `orderDetailView`, `orderTimeline`, and `type OrderDetail`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && node --test test/view.test.ts`
Expected: FAIL — `orderTimeline` is not exported.

- [ ] **Step 3: Implement the view**

Add to `app/web/src/view.ts`, after `ordersView`:

```typescript
// One order's observed history. Same discipline as the finding timeline: every
// entry is something Sightline OBSERVED in Shopify, with a source timestamp, and
// nothing is inferred about a downstream system.
export function orderTimeline(o: OrderDetail): Array<{ at: number; text: string }> {
	const entries: Array<{ at: number; text: string }> = [];
	if (o.paidAt !== undefined) entries.push({ at: o.paidAt, text: 'Order paid' });
	if (o.fulfillmentFailedAt !== undefined)
		entries.push({ at: o.fulfillmentFailedAt, text: 'Shopify recorded a fulfillment attempt that did not succeed' });
	if (o.fulfilledAt !== undefined) entries.push({ at: o.fulfilledAt, text: 'Fulfillment confirmation observed in Shopify' });
	if (o.cancelledAt !== undefined) entries.push({ at: o.cancelledAt, text: 'Order cancelled — confirmation no longer expected' });
	if (o.fullyRefundedAt !== undefined) entries.push({ at: o.fullyRefundedAt, text: 'Order fully refunded — confirmation no longer expected' });
	return entries.sort((a, b) => a.at - b.at);
}

export function orderDetailView(o: OrderDetail, strip: string): string {
	const timeline = orderTimeline(o)
		.map(
			(entry) => `<s-table-row><s-table-cell>${ts(entry.at, CLOCK_FMT)}</s-table-cell><s-table-cell>${esc(entry.text)}</s-table-cell></s-table-row>`,
		)
		.join('');

	const eventRows = o.events
		.map(
			(e) => `<s-table-row>
			<s-table-cell><s-link href="#/events/${encodeURIComponent(e.eventId)}">${ts(e.occurredAt)}</s-link></s-table-cell>
			<s-table-cell>${esc(e.domain)}</s-table-cell>
			<s-table-cell>${esc(e.topic ?? '')}</s-table-cell>
			<s-table-cell>${e.state ? badge(e.state) : ''}</s-table-cell>
			<s-table-cell>${esc(e.source)}</s-table-cell>
		</s-table-row>`,
		)
		.join('');

	const findingRows = o.findings
		.map(
			(f) => `<s-table-row>
			<s-table-cell><s-link href="#/findings/${encodeURIComponent(f.id)}">${badge(f.status)}</s-link></s-table-cell>
			<s-table-cell>${esc(f.description)}</s-table-cell>
			<s-table-cell>${ts(f.detectedAt)}</s-table-cell>
		</s-table-row>`,
		)
		.join('');

	return page(
		`Order ${orderLabel(o)}`,
		`${strip}
		<s-section>
			<s-stack direction="inline" gap="small-200" alignItems="center">${badge(o.state)}${adminOrderLink(o.orderId)}</s-stack>
			${fields([
				['Order', esc(orderLabel(o))],
				['Value', money(o.orderTotal, o.currency)],
				['Paid', ts(o.paidAt)],
				['Waiting since payment', o.ageHours === undefined ? '—' : esc(`${o.ageHours}h`)],
				['Needs shipping', o.requiresFulfillment ? 'Yes' : 'No'],
				['Fulfillment confirmed', ts(o.fulfilledAt)],
				['Tracking', o.hasTracking ? esc(o.trackingCompany ?? 'present') : 'none observed'],
			])}
		</s-section>
		<s-section heading="What Sightline observed">
			${table([{ label: 'Time' }, { label: 'Observation' }], timeline, 'No observations recorded.')}
		</s-section>
		<s-section heading="Findings">
			${table([{ label: 'Status' }, { label: 'Observation' }, { label: 'Detected' }], findingRows, 'No findings for this order.')}
		</s-section>
		<s-section heading="Events">
			${table([{ label: 'Time' }, { label: 'Domain' }, { label: 'Topic' }, { label: 'State' }, { label: 'Source' }], eventRows, 'No events recorded in the window.')}
		</s-section>`,
		{ href: '#/orders', label: 'Orders' },
	);
}
```

Add `OrderDetail` to the type import. `adminOrderLink` is added in Task 7 — until then, stub it directly above `orderDetailView` so this task is independently testable:

```typescript
// Replaced with a real Admin deep link in the deep-links task.
function adminOrderLink(_orderId: string): string {
	return '';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && node --test test/view.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the route**

In `app/web/src/main.ts`, add:

```typescript
async function orderDetail(orderId: string): Promise<void> {
	loading();
	const contextHtml = await strip();
	render(orderDetailView(await apiOrder(orderId), contextHtml));
}
```

In `route()`, add the pattern match next to the existing ones:

```typescript
		const orderId = path.match(/^\/orders\/(.+)$/);
```

and the branch, **before** the `path === '/orders'` branch:

```typescript
			else if (orderId) await orderDetail(decodeURIComponent(orderId[1]));
```

Extend the imports with `apiOrder` and `orderDetailView`.

- [ ] **Step 6: Verify and commit**

Run: `cd app && npm test && npm run typecheck && npm run build`
Expected: PASS.

```bash
git add app/web/src/view.ts app/web/src/main.ts app/test/view.test.ts
git commit -m "feat(ui): per-order observed timeline and detail screen"
```

---

### Task 5: Aging breakdown and drill-down from every count

Every number on the Overview becomes a link into the worklist, and the awaiting count gains an aging breakdown so a merchant can see what is heading for the deadline before it gets there.

**Files:**
- Modify: `app/src/queries.ts` (`getSummary`), `app/src/apiContract.ts`, `app/web/src/api.ts`, `app/web/src/view.ts`
- Test: `app/test/queries.test.ts`, `app/test/view.test.ts`

**Interfaces:**
- Consumes: `AGE_BUCKETS`, `ageBucketKey`, `isAwaitingConfirmation`, `deriveOrderLane` (Task 1).
- Produces: `getSummary`'s response gains `aging: { buckets: Array<{ key: string; label: string; count: number }> }`; `view.ts` gains `agingView(aging, strip?)` and `statGridLinked(tiles)`; `Summary` type gains `aging`.

- [ ] **Step 1: Write the failing tests**

Add to `app/test/queries.test.ts`:

```typescript
test('the summary reports an aging breakdown of orders awaiting confirmation', async () => {
	const { events, projections, findings, deliveries, shops } = fixtures();
	const summary = await getSummary({ events, projections, findings, deliveries, shops }, 's1', NOW);
	const aging = summary.aging as { buckets: Array<{ key: string; count: number }> };
	const byKey = Object.fromEntries(aging.buckets.map((b) => [b.key, b.count]));
	assert.equal(byKey.under24, 1); // oA, paid 2h ago
	assert.equal(byKey.h24to48, 1); // oB, paid 30h ago
	assert.equal(byKey.over72, 1); // oC, paid 80h ago
	assert.equal(byKey.h48to72, 0);
});

test('aging counts only awaiting orders — a fulfilled order is not aging', async () => {
	const { events, projections, findings, deliveries, shops } = fixtures();
	const summary = await getSummary({ events, projections, findings, deliveries, shops }, 's1', NOW);
	const aging = summary.aging as { buckets: Array<{ count: number }> };
	const total = aging.buckets.reduce((n, b) => n + b.count, 0);
	assert.equal(total, (summary.orders as { awaitingConfirmation: number }).awaitingConfirmation);
});

test('the aging breakdown never counts another tenant orders', async () => {
	const { events, projections, findings, deliveries, shops } = fixtures();
	const summary = await getSummary({ events, projections, findings, deliveries, shops }, 's2', NOW);
	const aging = summary.aging as { buckets: Array<{ count: number }> };
	assert.equal(aging.buckets.reduce((n, b) => n + b.count, 0), 1);
});
```

Add to `app/test/view.test.ts`:

```typescript
test('the aging breakdown links each bucket into the filtered worklist', () => {
	const html = agingView({ buckets: [{ key: 'under24', label: 'Under 24h', count: 3 }, { key: 'over72', label: 'Over 72h', count: 1 }] });
	assert.match(html, /Under 24h/);
	assert.match(html, /href="#\/orders\?state=awaiting&amp;minAgeHours=72"/);
});

test('the overview stat tiles link into the worklist', () => {
	const html = overviewView({ summary: summary(), flows: null, unconfirmed: [], setup: null, now: NOW });
	assert.match(html, /href="#\/orders\?state=awaiting"/);
	assert.match(html, /href="#\/orders\?state=fulfilled"/);
});

test('a zero-count aging bucket still renders, so the breakdown is readable', () => {
	const html = agingView({ buckets: [{ key: 'h48to72', label: '48–72h', count: 0 }] });
	assert.match(html, /48–72h/);
});
```

Extend `view.test.ts`'s imports with `agingView`, and add `aging: { buckets: [] }` to the `summary()` fixture helper's defaults.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && node --test test/queries.test.ts test/view.test.ts`
Expected: FAIL — `summary.aging` is `undefined`; `agingView` is not exported.

- [ ] **Step 3: Compute aging in `getSummary`**

In `app/src/queries.ts`, inside `getSummary`'s projection loop, replace the inline awaiting condition with the shared predicate and accumulate buckets. The loop becomes:

```typescript
	let ordersTracked = 0;
	let paid = 0;
	let fulfilled = 0;
	let awaitingConfirmation = 0;
	// Aging of the awaiting set, so the Overview can show what is heading for the
	// 72-hour deadline while it can still be acted on — not just what already
	// blew it. Zero-filled so every bucket renders.
	const agingCounts: Record<string, number> = Object.fromEntries(AGE_BUCKETS.map((b) => [b.key, 0]));
	for await (const p of tables.projections.search({ conditions: [{ attribute: 'shopId', value: shopId }] })) {
		const proj = p as unknown as OrderProjection;
		ordersTracked++;
		if (proj.paidAt !== undefined) paid++;
		if (proj.fulfilledAt !== undefined) fulfilled++;
		if (isAwaitingConfirmation(proj)) {
			awaitingConfirmation++;
			const key = ageBucketKey(proj.paidAt, now);
			if (key !== undefined) agingCounts[key]++;
		}
	}
```

And add to the returned object:

```typescript
		aging: { buckets: AGE_BUCKETS.map((b) => ({ key: b.key, label: b.label, count: agingCounts[b.key] })) },
```

Add `AGE_BUCKETS, ageBucketKey, isAwaitingConfirmation` to the `./orders.ts` import. In `app/src/apiContract.ts`, add `'aging'` to the `summary` resource's `fields`.

- [ ] **Step 4: Add the aging view and link the tiles**

In `app/web/src/api.ts`, add to `Summary`:

```typescript
	aging: { buckets: Array<{ key: string; label: string; count: number }> };
```

In `app/web/src/view.ts`, add a linked stat grid beside `statGrid`:

```typescript
// Stat tiles that are also links. A count with nowhere to go is a dead end: the
// merchant's next question is always "which ones?", and the worklist answers it.
export function statGridLinked(tiles: Array<[string, number, string]>): string {
	const cells = tiles
		.map(
			([label, value, href]) => `<s-grid-item><s-box padding="base" background="subdued" borderRadius="base">
			<s-link href="${esc(href)}">
				<s-text type="strong" fontVariantNumeric="tabular-nums">${value}</s-text>
				<s-paragraph><s-text color="subdued">${esc(label)}</s-text></s-paragraph>
			</s-link>
		</s-box></s-grid-item>`,
		)
		.join('');
	return `<s-grid gridTemplateColumns="@container (inline-size > 600px) repeat(4, 1fr), repeat(2, 1fr)" gap="base">${cells}</s-grid>`;
}

// How long the awaiting orders have been waiting. Each bucket links into the
// worklist filtered to that threshold, so the breakdown is a set of entry points
// rather than a chart to read and then act on separately.
export function agingView(aging: Summary['aging']): string {
	const rows = aging.buckets
		.map(
			(b) => `<s-table-row>
			<s-table-cell><s-link href="#/orders?state=awaiting&minAgeHours=${encodeURIComponent(String(bucketMinHours(b.key)))}">${esc(b.label)}</s-link></s-table-cell>
			<s-table-cell>${b.count}</s-table-cell>
		</s-table-row>`,
		)
		.join('');
	return `<s-section heading="Waiting for confirmation, by age">
		<s-paragraph><s-text color="subdued">Time since Shopify showed payment. Sightline opens a finding at 72 hours.</s-text></s-paragraph>
		${table([{ label: 'Age since payment' }, { label: 'Orders', numeric: true }], rows, 'Nothing is waiting for confirmation.')}
	</s-section>`;
}

// The API's bucket keys are opaque strings; this is the one place that maps them
// to the worklist's numeric threshold, so a renamed bucket breaks here loudly
// rather than producing a silently wrong link.
function bucketMinHours(key: string): number {
	switch (key) {
		case 'under24':
			return 0;
		case 'h24to48':
			return 24;
		case 'h48to72':
			return 48;
		default:
			return 72;
	}
}
```

In `overviewView`, replace the two `statGrid(...)` calls for orders and findings with linked versions:

```typescript
		<s-section heading="Orders (last ${s.windowDays} days)">
			${statGridLinked([
				['Tracked', s.orders.tracked, '#/orders'],
				['Paid', s.orders.paid, '#/orders?state=awaiting'],
				['Fulfilled', s.orders.fulfilled, '#/orders?state=fulfilled'],
				['Awaiting confirmation', s.orders.awaitingConfirmation, '#/orders?state=awaiting'],
			])}
		</s-section>
		<s-section heading="Findings">
			${statGridLinked([
				['Unconfirmed', s.findings.unconfirmed, '#/findings?status=unconfirmed'],
				['Resolved', s.findings.resolved, '#/findings?status=resolved'],
				['Suppressed', s.findings.suppressed, '#/findings?status=suppressed'],
			])}
		</s-section>`
```

and add `${s.aging ? agingView(s.aging) : ''}` immediately after the `${flows}` interpolation.

Also make the flow lanes clickable — in `overviewView`'s `flows` block, wrap each lane label in a link to its filtered worklist:

```typescript
					(
						[
							['Paid', d.flows.lanes.paid, '#/orders'],
							['Fulfilled', d.flows.lanes.fulfilled, '#/orders?state=fulfilled'],
							['Awaiting confirmation', d.flows.lanes.awaitingConfirmation, '#/orders?state=awaiting'],
							['Cancelled', d.flows.lanes.cancelled, '#/orders?state=cancelled'],
							['Refunded', d.flows.lanes.refunded, '#/orders?state=refunded'],
						] as Array<[string, number, string]>
					)
						.map(
							([label, n, href]) =>
								`<s-table-row><s-table-cell><s-link href="${esc(href)}">${esc(label)}</s-link></s-table-cell><s-table-cell>${n}</s-table-cell></s-table-row>`,
						)
						.join(''),
```

- [ ] **Step 5: Run tests, regenerate the contract**

Run: `cd app && npm run contract:gen && npm test && npm run typecheck && npm run build`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/queries.ts app/src/apiContract.ts app/web/src/api.ts app/web/src/view.ts contracts/sightline-api-v1.json app/test/queries.test.ts app/test/view.test.ts
git commit -m "feat(ui): aging breakdown and drill-down from every overview count"
```

---

### Task 6: Delivery integrity — the signal only Sightline has

`OperationalEvent.source` distinguishes `webhook` from `reconciliation`. An event that exists **only** from reconciliation is one Shopify's webhook never delivered to Sightline — the failure class the product brief calls out as invisible to merchants today. It has been a dropdown value on the Events screen and nothing more.

The copy has to be exact. Reconciliation-discovered does **not** prove Shopify failed to deliver to anyone else: every app's webhook subscription is independent, and Sightline's own downtime is an alternative explanation. What it does honestly say is "this change reached us only by direct check, not as a webhook."

**Files:**
- Modify: `app/src/queries.ts` (`getSummary`), `app/src/apiContract.ts`, `app/web/src/api.ts`, `app/web/src/view.ts`
- Test: `app/test/queries.test.ts`, `app/test/view.test.ts`

**Interfaces:**
- Consumes: `OperationalEvent.source`.
- Produces: `getSummary`'s response gains `integrity: { webhookEvents: number; reconciliationOnlyEvents: number }`; `view.ts` gains `integrityView(integrity)`; `Summary` gains `integrity`.

- [ ] **Step 1: Write the failing tests**

Add to `app/test/queries.test.ts`:

```typescript
test('the summary counts events observed by direct check rather than by webhook', async () => {
	const { events, projections, findings, deliveries, shops } = fixtures();
	await events.put({ eventId: 'recon:s1:o9:paid', shopId: 's1', domain: 'order', topic: 'orders/paid', resourceId: 'o9', source: 'reconciliation', occurredAt: NOW - 2000, receivedAt: NOW - 2000 });
	const summary = await getSummary({ events, projections, findings, deliveries, shops }, 's1', NOW);
	const integrity = summary.integrity as { webhookEvents: number; reconciliationOnlyEvents: number };
	assert.equal(integrity.reconciliationOnlyEvents, 1);
	assert.ok(integrity.webhookEvents >= 1);
});

test('integrity counts are scoped to the shop', async () => {
	const { events, projections, findings, deliveries, shops } = fixtures();
	await events.put({ eventId: 'recon:s2:o9:paid', shopId: 's2', domain: 'order', resourceId: 'o9', source: 'reconciliation', occurredAt: NOW - 2000, receivedAt: NOW - 2000 });
	const summary = await getSummary({ events, projections, findings, deliveries, shops }, 's1', NOW);
	assert.equal((summary.integrity as { reconciliationOnlyEvents: number }).reconciliationOnlyEvents, 0);
});
```

Add to `app/test/view.test.ts`:

```typescript
test('the integrity section states what a direct-check discovery does and does not mean', () => {
	const html = integrityView({ webhookEvents: 40, reconciliationOnlyEvents: 3 });
	assert.match(html, /3/);
	assert.match(html, /direct check/i);
	// It must NOT claim Shopify failed, or that other apps missed anything.
	assert.doesNotMatch(html, /Shopify failed|never delivered to your|your vendors did not/i);
	assert.match(html, /href="#\/events\?source=reconciliation"/);
});

test('zero direct-check discoveries reads as healthy, not as an absence of data', () => {
	assert.match(integrityView({ webhookEvents: 40, reconciliationOnlyEvents: 0 }), /Every change[\s\S]*webhook/i);
});
```

Extend the imports with `integrityView` and add `integrity: { webhookEvents: 0, reconciliationOnlyEvents: 0 }` to the `summary()` fixture defaults.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && node --test test/queries.test.ts test/view.test.ts`
Expected: FAIL — `summary.integrity` is `undefined`; `integrityView` is not exported.

- [ ] **Step 3: Count sources in `getSummary`**

In `app/src/queries.ts`, the event scan already selects `occurredAt` and `domain`; add `source` to the `select` and tally alongside the activity buckets:

```typescript
	let eventsTotal = 0;
	// Capture-integrity tally. An event whose only source is a reconciliation sweep
	// is one that did NOT arrive as a webhook — the failure class merchants cannot
	// otherwise see. It is evidence about OUR capture path, not proof about anyone
	// else's: every app's subscription is independent, and our own downtime is an
	// alternative explanation. The UI copy carries that boundary.
	let webhookEvents = 0;
	let reconciliationOnlyEvents = 0;
	for await (const e of tables.events.search({
		conditions: [
			{ attribute: 'shopId', value: shopId },
			{ attribute: 'occurredAt', value: windowStart, comparator: 'greater_than_equal' },
		],
		operator: 'and',
		select: ['occurredAt', 'domain', 'source'],
	})) {
		eventsTotal++;
		if (String(e.source) === 'reconciliation') reconciliationOnlyEvents++;
		else webhookEvents++;
		const index = Math.min(WINDOW_DAYS - 1, Math.max(0, Math.floor((Number(e.occurredAt) - windowStart) / DAY_MS)));
		const bucket = buckets[index];
		bucket.total++;
		const domain = String(e.domain);
		if (domain in bucket) bucket[domain]++;
	}
```

Add to the returned object:

```typescript
		integrity: { webhookEvents, reconciliationOnlyEvents },
```

In `app/src/apiContract.ts`, add `'integrity'` to the `summary` resource's `fields`.

- [ ] **Step 4: Add the view**

In `app/web/src/api.ts`, add to `Summary`:

```typescript
	integrity: { webhookEvents: number; reconciliationOnlyEvents: number };
```

In `app/web/src/view.ts`, add after `activityView`:

```typescript
// Capture integrity: how much of the window arrived as a webhook versus how much
// Sightline found only by checking Shopify directly.
//
// The wording here is load-bearing. A direct-check discovery means the webhook
// did not reach US — it does NOT prove Shopify failed to deliver, and it says
// nothing about any other app's subscription, which is independent of ours.
// Sightline's own downtime is an equally valid explanation. State the observation
// and let the merchant draw the conclusion.
export function integrityView(integrity: Summary['integrity']): string {
	const clean = integrity.reconciliationOnlyEvents === 0;
	return `<s-section heading="Capture integrity">
		${
			clean
				? `<s-paragraph>Every change Sightline recorded in this window arrived as a webhook. Nothing had to be recovered by a direct check.</s-paragraph>`
				: `<s-banner tone="info" heading="${esc(String(integrity.reconciliationOnlyEvents))} change(s) found by direct check">
						<s-paragraph>Sightline found these by querying Shopify directly rather than receiving a webhook for them. That means the webhook did not reach Sightline — it does not prove Shopify failed to send one, and it says nothing about the webhook subscriptions your other apps have, which are independent of Sightline's.</s-paragraph>
						<s-link href="#/events?source=reconciliation">View these events</s-link>
					</s-banner>`
		}
		${fields([
			['Arrived as a webhook', String(integrity.webhookEvents)],
			['Found by direct check', String(integrity.reconciliationOnlyEvents)],
		])}
	</s-section>`;
}
```

In `overviewView`, add `${s.integrity ? integrityView(s.integrity) : ''}` immediately after the `${s.activity ? activityView(s.activity) : ''}` interpolation.

- [ ] **Step 5: Run tests, regenerate the contract, commit**

Run: `cd app && npm run contract:gen && npm test && npm run typecheck && npm run build`
Expected: all PASS.

```bash
git add app/src/queries.ts app/src/apiContract.ts app/web/src/api.ts app/web/src/view.ts contracts/sightline-api-v1.json app/test/queries.test.ts app/test/view.test.ts
git commit -m "feat(ui): capture-integrity view for webhook-vs-direct-check discovery"
```

---

### Task 7: Order names and Shopify Admin deep links everywhere

An ops user cannot match `7518851989809` to anything. Every place an order appears should show `#1001` and offer a link straight to that order in Shopify Admin — the merchant's actual next action.

**Files:**
- Modify: `app/src/queries.ts` (`listFindings` joins `orderName`), `app/src/apiContract.ts`, `app/web/src/api.ts`, `app/web/src/view.ts`, `app/web/src/main.ts`
- Test: `app/test/queries.test.ts`, `app/test/view.test.ts`

**Interfaces:**
- Consumes: `OrderProjection.orderName` (Plan A); the session's `shop` field.
- Produces:
  - `FINDING_LIST_FIELDS` gains `orderName`
  - `view.ts`: `setShop(shop: string | undefined)`, `storeHandle(): string | undefined`, `adminOrderUrl(orderId: string): string | undefined`, `adminOrderLink(orderId: string): string` (replacing Task 4's stub), `findingLabel(f: { orderName?: string; orderId: string }): string`
  - `main.ts` calls `setShop(session.shop)` during boot

- [ ] **Step 1: Write the failing tests**

Add to `app/test/queries.test.ts`:

```typescript
test('the findings list carries the merchant-facing order name', async () => {
	const { findings, expectations, projections } = fixtures();
	const page = await listFindings(findings, expectations, projections, 's1', {});
	const withName = page.items.find((i) => i.orderName !== undefined);
	assert.ok(withName, 'at least one finding should join an order name');
});

test('the findings join never takes another tenant order name', async () => {
	const { findings, expectations, projections } = fixtures();
	// s2 has an order with the same id and a different name; s1's finding must not
	// inherit it.
	const page = await listFindings(findings, expectations, projections, 's1', {});
	for (const item of page.items) assert.notEqual(item.orderName, '#9999');
});
```

Add to `app/test/view.test.ts`:

```typescript
test('an admin deep link is built from the store handle and opens the top frame', () => {
	setShop('acme-store.myshopify.com');
	assert.equal(storeHandle(), 'acme-store');
	assert.equal(adminOrderUrl('7518851989809'), 'https://admin.shopify.com/store/acme-store/orders/7518851989809');
	const link = adminOrderLink('7518851989809');
	assert.match(link, /target="_top"/);
	assert.match(link, /admin\.shopify\.com\/store\/acme-store\/orders\/7518851989809/);
});

test('with no known shop there is no fabricated admin link', () => {
	setShop(undefined);
	assert.equal(adminOrderUrl('1'), undefined);
	assert.equal(adminOrderLink('1'), '');
});

test('a hostile order id cannot escape the admin link attribute', () => {
	setShop('acme-store.myshopify.com');
	const link = adminOrderLink('1"><script>alert(1)</script>');
	assert.doesNotMatch(link, /<script>alert/);
});

test('findings and needs-attention rows show the order name when known', () => {
	setShop('acme-store.myshopify.com');
	const item: FindingItem = { id: 'f1', orderId: '7518851989809', orderName: '#1001', status: 'unconfirmed', detectedAt: NOW - HOUR, paidAt: NOW - 73 * HOUR, deadline: NOW - HOUR };
	assert.match(findingsListView({}, [item], NOW, ''), /#1001/);
	assert.match(needsAttention([item], NOW), /#1001/);
});

test('findings fall back to the raw order id when no name was captured', () => {
	const item: FindingItem = { id: 'f1', orderId: '7518851989809', status: 'unconfirmed', detectedAt: NOW - HOUR };
	assert.match(findingsListView({}, [item], NOW, ''), /7518851989809/);
});
```

Extend the imports with `adminOrderLink`, `adminOrderUrl`, `findingLabel`, `setShop`, `storeHandle`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && node --test test/queries.test.ts test/view.test.ts`
Expected: FAIL — `setShop` is not exported; `orderName` absent from findings items.

- [ ] **Step 3: Join the order name into the findings list**

In `app/src/apiContract.ts`, change:

```typescript
export const FINDING_LIST_FIELDS = [...FINDING_FIELDS, 'paidAt', 'deadline', 'orderName'] as const;
```

In `app/src/queries.ts`, inside `listFindings`'s per-item join, take the name from the same tenant-checked projection read that already supplies `paidAt`:

```typescript
			const paidAt = projection && projection.shopId === shopId ? (projection as unknown as OrderProjection).paidAt : undefined;
			const orderName = projection && projection.shopId === shopId ? (projection as unknown as OrderProjection).orderName : undefined;
			const deadline = expectation && expectation.shopId === shopId ? (expectation as unknown as Expectation).deadline : undefined;
			return pick({ ...item, paidAt, deadline, orderName }, FINDING_LIST_FIELDS);
```

Do the same in `getFindingDetail` — `PROJECTION_FIELDS` already gained `orderName` in Plan A, so the detail's `projection` object carries it with no further change.

- [ ] **Step 4: Implement the deep links**

In `app/web/src/view.ts`, add beside the support block:

```typescript
// ── Shopify Admin deep links ─────────────────────────────────────────────────
// The merchant's next action after seeing an order here is to open it in Admin.
// The link is built from the session's shop domain: `acme.myshopify.com` →
// `https://admin.shopify.com/store/acme/orders/<id>`, opened with target="_top"
// so it replaces the whole Admin page rather than nesting Admin inside our
// iframe. (App Bridge also understands `shopify://admin/...`, but the explicit
// https form works with or without App Bridge having loaded.)
let shopDomain: string | undefined;
export function setShop(shop: string | undefined): void {
	shopDomain = shop;
}

export function storeHandle(): string | undefined {
	if (!shopDomain) return undefined;
	const handle = shopDomain.replace(/\.myshopify\.com$/, '');
	return handle.length > 0 && handle !== shopDomain ? handle : undefined;
}

export function adminOrderUrl(orderId: string): string | undefined {
	const handle = storeHandle();
	if (!handle) return undefined;
	return `https://admin.shopify.com/store/${encodeURIComponent(handle)}/orders/${encodeURIComponent(orderId)}`;
}

// Nothing at all when the shop is unknown — a broken link is worse than none.
export function adminOrderLink(orderId: string): string {
	const url = adminOrderUrl(orderId);
	return url ? `<s-link href="${esc(url)}" target="_top">Open in Shopify</s-link>` : '';
}
```

Delete the Task 4 stub `adminOrderLink` from above `orderDetailView`.

Add the shared label helper next to `orderLabel`:

```typescript
// Findings identify their order the same way the worklist does.
export function findingLabel(f: { orderName?: string; orderId: string }): string {
	return f.orderName ?? f.orderId;
}
```

Update `needsAttention` so the order cell reads `${esc(findingLabel(x))}` instead of `${esc(x.orderId)}`, and add a trailing cell with the Admin link:

```typescript
	const rows = items
		.slice(0, 5)
		.map(
			(x) => `<s-table-row>
			<s-table-cell><s-link href="#/findings/${encodeURIComponent(x.id)}">${esc(findingLabel(x))}</s-link></s-table-cell>
			<s-table-cell>No Shopify fulfillment confirmation observed</s-table-cell>
			<s-table-cell>${esc(elapsed(x.detectedAt, now))}</s-table-cell>
			<s-table-cell>${adminOrderLink(x.orderId)}</s-table-cell>
		</s-table-row>`,
		)
		.join('');
	return `<s-section heading="Needs attention">
		${table([{ label: 'Order' }, { label: 'Observation' }, { label: 'Open for' }, { label: '' }], rows, 'Nothing is awaiting confirmation.')}
	</s-section>`;
```

Update `findingsListView`'s order cell to `${esc(findingLabel(x))}` and add a trailing `<s-table-cell>${adminOrderLink(x.orderId)}</s-table-cell>` plus a matching `{ label: '' }` header.

Update `findingDetailView`'s page heading and add the link to its first section:

```typescript
	return page(
		`Order ${findingLabel({ orderName: f.projection?.orderName, orderId: f.orderId })}`,
		`${strip}
		<s-section>
			<s-stack direction="inline" gap="small-200" alignItems="center">${badge(f.status)}${adminOrderLink(f.orderId)}</s-stack>
```

In `ordersView`, add a trailing Admin-link cell and header the same way.

In `app/web/src/api.ts`, add `orderName?: string;` to `FindingItem`, and `orderName?: string;` to `FindingDetail`'s `projection` object type.

- [ ] **Step 5: Set the shop at boot**

In `app/web/src/main.ts`'s `boot()`, add immediately after `setSupport(session.support);`:

```typescript
		setShop(session.shop);
```

and extend the `./view.ts` import with `setShop`.

- [ ] **Step 6: Run tests, regenerate the contract, verify**

Run: `cd app && npm run contract:gen && npm test && npm run typecheck && npm run build`
Expected: all PASS. Note that `view.test.ts` shares module state via `setShop`, exactly as it already does with `setSupport` and `useShopTimeZone` — set the shop explicitly in any test that asserts on links, and reset with `setShop(undefined)` where absence is the assertion.

- [ ] **Step 7: Commit**

```bash
git add app/src/queries.ts app/src/apiContract.ts app/web/src/api.ts app/web/src/view.ts app/web/src/main.ts contracts/sightline-api-v1.json app/test/queries.test.ts app/test/view.test.ts
git commit -m "feat(ui): order names and Shopify Admin deep links across every screen"
```

---

### Task 8: CSV export

The stated competitive wedge is that Shopify's activity log is "view-only, not exportable, maximum 250 results". Sightline's lists are equally unexportable today, and the brief's core artifact — *the scoped record list ("these 39 orders, 10:04 to 10:19")* — is precisely a file you can hand to someone.

Export must be authenticated with the same session token as every other call, so it cannot be a plain `<a href>` (a browser navigation cannot carry the `X-Shopify-Session-Token` header). The SPA fetches the CSV and triggers a download from a blob.

**Files:**
- Create: `app/src/csv.ts`, `app/test/csv.test.ts`
- Modify: `app/src/apiContract.ts`, `app/resources.ts`, `app/web/src/api.ts`, `app/web/src/view.ts`, `app/web/src/main.ts`
- Test: `app/test/view.test.ts`, `app/test/crossTenant.test.ts`

**Interfaces:**
- Consumes: `listEvents`, `listFindings`, `listOrders` (existing + Task 2).
- Produces:
  - `csv.ts`: `MAX_EXPORT_ROWS = 5000`, `csvCell(value: unknown): string`, `csvRow(values: unknown[]): string`, `toCsv(headers: string[], rows: unknown[][]): string`, `EXPORT_COLUMNS: Record<'events' | 'findings' | 'orders', Array<{ header: string; field: string }>>`, `exportFilename(kind: string, now: number): string`
  - `GET /api/v1/export/:kind.csv` returning `text/csv` with `content-disposition: attachment` and an `x-sightline-row-count` / `x-sightline-truncated` header pair
  - `view.ts`: `exportButton(kind: string, params: Record<string, string>)`
  - `main.ts`: `downloadExport(kind, params)`

- [ ] **Step 1: Write the failing tests**

Create `app/test/csv.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, csvRow, EXPORT_COLUMNS, exportFilename, MAX_EXPORT_ROWS, toCsv } from '../src/csv.ts';

test('plain values are unquoted', () => {
	assert.equal(csvCell('TSHIRT'), 'TSHIRT');
	assert.equal(csvCell(42), '42');
	assert.equal(csvCell(true), 'true');
});

test('absent values are empty, never the string undefined', () => {
	assert.equal(csvCell(undefined), '');
	assert.equal(csvCell(null), '');
});

test('commas, quotes and newlines are RFC 4180 quoted', () => {
	assert.equal(csvCell('a,b'), '"a,b"');
	assert.equal(csvCell('say "hi"'), '"say ""hi"""');
	assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
});

test('formula-injection payloads are neutralized so a spreadsheet cannot execute them', () => {
	// A cell beginning =, +, -, @, tab or CR is executed as a formula by Excel and
	// Sheets. Prefixing with an apostrophe makes it inert text without losing data.
	assert.equal(csvCell('=1+1'), "'=1+1");
	assert.equal(csvCell('+1'), "'+1");
	assert.equal(csvCell('-1'), "'-1");
	assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
	assert.equal(csvCell('=HYPERLINK("http://evil","x")'), '"\'=HYPERLINK(""http://evil"",""x"")"');
});

test('rows join with commas and the document uses CRLF line endings', () => {
	assert.equal(csvRow(['a', 'b']), 'a,b');
	assert.equal(toCsv(['h1', 'h2'], [['a', 'b']]), 'h1,h2\r\na,b\r\n');
});

test('a header-only document is produced for an empty result set', () => {
	assert.equal(toCsv(['h1'], []), 'h1\r\n');
});

test('every export kind has columns and the row cap is bounded', () => {
	for (const kind of ['events', 'findings', 'orders'] as const) {
		assert.ok(EXPORT_COLUMNS[kind].length > 0);
	}
	assert.equal(MAX_EXPORT_ROWS, 5000);
});

test('filenames are stable, sortable, and safe', () => {
	const name = exportFilename('findings', Date.parse('2026-08-07T12:34:56Z'));
	assert.equal(name, 'sightline-findings-2026-08-07.csv');
	assert.doesNotMatch(exportFilename('../etc/passwd', 0), /\.\.|\//);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && node --test test/csv.test.ts`
Expected: FAIL — cannot find module `../src/csv.ts`.

- [ ] **Step 3: Implement `app/src/csv.ts`**

```typescript
import { EVENT_FIELDS } from './apiContract.ts';

// CSV serialization for the export endpoint.
//
// Two hazards, both handled here so no call site has to remember them:
//
// 1. RFC 4180 quoting — a comma, quote, or newline inside a value must be quoted
//    and internal quotes doubled, or the file silently corrupts on import.
// 2. Formula injection — Excel and Google Sheets EXECUTE a cell that begins with
//    =, +, -, @, tab, or CR. Our data comes from Shopify payloads (order names,
//    SKUs, carriers are all merchant-controlled strings), so an exported file
//    could otherwise carry an executable payload into a finance team's
//    spreadsheet. Prefixing with an apostrophe makes it inert text and loses
//    nothing.

export const MAX_EXPORT_ROWS = 5000;

const NEEDS_QUOTING = /[",\r\n]/;
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
	if (value === undefined || value === null) return '';
	let text = String(value);
	if (FORMULA_START.test(text)) text = `'${text}`;
	if (NEEDS_QUOTING.test(text)) return `"${text.replace(/"/g, '""')}"`;
	return text;
}

export function csvRow(values: unknown[]): string {
	return values.map(csvCell).join(',');
}

// CRLF per RFC 4180 — the form every spreadsheet accepts, including on Windows.
export function toCsv(headers: string[], rows: unknown[][]): string {
	return [csvRow(headers), ...rows.map(csvRow)].join('\r\n') + '\r\n';
}

// Exported columns per list. Deliberately a separate map from the API field
// allowlists: an export is a document a merchant keeps, so its column order and
// headings are a product decision, and widening the API cannot silently widen
// what leaves in a file.
export const EXPORT_COLUMNS: Record<'events' | 'findings' | 'orders', Array<{ header: string; field: string }>> = {
	events: [
		{ header: 'Occurred at', field: 'occurredAt' },
		{ header: 'Received at', field: 'receivedAt' },
		{ header: 'Domain', field: 'domain' },
		{ header: 'Topic', field: 'topic' },
		{ header: 'Resource ID', field: 'resourceId' },
		{ header: 'Order name', field: 'orderName' },
		{ header: 'SKU', field: 'sku' },
		{ header: 'Quantity', field: 'quantity' },
		{ header: 'State', field: 'state' },
		{ header: 'Location ID', field: 'locationId' },
		{ header: 'Source', field: 'source' },
		{ header: 'Event ID', field: 'eventId' },
	],
	findings: [
		{ header: 'Order name', field: 'orderName' },
		{ header: 'Order ID', field: 'orderId' },
		{ header: 'Detector', field: 'detector' },
		{ header: 'Status', field: 'status' },
		{ header: 'Paid at', field: 'paidAt' },
		{ header: 'Confirmation expected by', field: 'deadline' },
		{ header: 'Detected at', field: 'detectedAt' },
		{ header: 'Resolved at', field: 'resolvedAt' },
		{ header: 'Rule version', field: 'ruleVersion' },
		{ header: 'Finding ID', field: 'id' },
	],
	orders: [
		{ header: 'Order name', field: 'orderName' },
		{ header: 'Order ID', field: 'orderId' },
		{ header: 'Lane', field: 'state' },
		{ header: 'Paid at', field: 'paidAt' },
		{ header: 'Hours waiting', field: 'ageHours' },
		{ header: 'Value', field: 'orderTotal' },
		{ header: 'Currency', field: 'currency' },
		{ header: 'Fulfilled at', field: 'fulfilledAt' },
		{ header: 'Fulfillment attempt failed at', field: 'fulfillmentFailedAt' },
		{ header: 'Has tracking', field: 'hasTracking' },
		{ header: 'Carrier', field: 'trackingCompany' },
		{ header: 'Cancelled at', field: 'cancelledAt' },
		{ header: 'Fully refunded at', field: 'fullyRefundedAt' },
	],
};

// Sortable, and stripped of anything that could traverse a path or confuse a
// content-disposition header.
export function exportFilename(kind: string, now: number): string {
	const safeKind = kind.replace(/[^a-z0-9-]/gi, '') || 'export';
	const day = new Date(now).toISOString().slice(0, 10);
	return `sightline-${safeKind}-${day}.csv`;
}

// The events export needs the same field set the API exposes, so a column added
// to EXPORT_COLUMNS.events that the API does not allowlist fails loudly in tests
// rather than exporting an empty column.
export const EXPORTABLE_EVENT_FIELDS: readonly string[] = EVENT_FIELDS;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && node --test test/csv.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Add the export resource**

In `app/src/apiContract.ts`, add to `API_CONTRACT.resources`:

```typescript
			export: {
				path: '/api/v1/export/:kind.csv',
				kinds: ['events', 'findings', 'orders'],
				format: 'text/csv',
				maxRows: 5000,
			},
```

In `app/resources.ts`, add after `OrdersResource`:

```typescript
// CSV export of any filtered list. The one differentiator over Shopify's own
// activity log that a merchant can hold in their hand — the log is view-only,
// non-exportable, and capped at 250 rows.
//
// Authenticated by the same session token as every other read, which is why the
// SPA fetches this and downloads from a blob rather than linking directly: a
// browser navigation cannot carry the X-Shopify-Session-Token header.
//
// Bounded at MAX_EXPORT_ROWS. A truncated export SAYS SO in a response header and
// in the UI — silent truncation would read as "this is everything".
export class ExportResource extends Resource {
	static path = '/api/v1/export';
	allowRead() {
		return true;
	}
	async get() {
		const ctx = this.getContext();
		const shopId = (await identity.authenticate(ctx)).shopId;
		const url = parseUrl(ctx.url);
		const raw = trailingId(url.pathname, '/api/v1/export') ?? '';
		const kind = raw.replace(/\.csv$/, '');
		if (kind !== 'events' && kind !== 'findings' && kind !== 'orders') throw httpError('unknown export kind', 404);

		const now = Date.now();
		const p = url.searchParams;
		const rows: Array<Record<string, unknown>> = [];
		let cursor: string | undefined = p.get('cursor') ?? undefined;
		// Page through the SAME query functions the screens use, so an export can
		// never see a row the UI could not, and tenant scoping is identical.
		do {
			let page: { items: Array<Record<string, unknown>>; nextCursor?: string };
			if (kind === 'events') {
				page = await listEvents(
					EventsQ,
					shopId,
					now,
					{
						domain: p.get('domain') ?? undefined,
						topic: p.get('topic') ?? undefined,
						resourceId: p.get('resourceId') ?? undefined,
						sku: p.get('sku') ?? undefined,
						source: p.get('source') ?? undefined,
						since: numParam(p, 'since'),
						until: numParam(p, 'until'),
						cursor,
						limit: MAX_LIMIT,
					},
					EventSkusQ,
				);
			} else if (kind === 'findings') {
				page = await listFindings(FindingsQ, ExpectationsQ, ProjectionsQ, shopId, {
					status: p.get('status') ?? undefined,
					detector: p.get('detector') ?? undefined,
					cursor,
					limit: MAX_LIMIT,
				});
			} else {
				page = await listOrders(ProjectionsQ, shopId, now, {
					state: p.get('state') ?? undefined,
					minAgeHours: numParam(p, 'minAgeHours'),
					sort: p.get('sort') === 'oldest' ? 'oldest' : 'newest',
					cursor,
					limit: MAX_LIMIT,
				});
			}
			rows.push(...page.items);
			cursor = page.nextCursor;
		} while (cursor && rows.length < MAX_EXPORT_ROWS);

		const truncated = rows.length > MAX_EXPORT_ROWS;
		const bounded = rows.slice(0, MAX_EXPORT_ROWS);
		const columns = EXPORT_COLUMNS[kind];
		const body = toCsv(
			columns.map((c) => c.header),
			bounded.map((row) => columns.map((c) => row[c.field])),
		);
		log('trace', 'export.served', { kind, rows: bounded.length, truncated });
		return new Response(body, {
			status: 200,
			headers: {
				'content-type': 'text/csv; charset=utf-8',
				'content-disposition': `attachment; filename="${exportFilename(kind, now)}"`,
				'x-sightline-row-count': String(bounded.length),
				'x-sightline-truncated': String(truncated),
			},
		});
	}
}
```

Add the imports: `EXPORT_COLUMNS, MAX_EXPORT_ROWS, exportFilename, toCsv` from `./src/csv.ts`, and `MAX_LIMIT` from `./src/apiContract.ts`.

- [ ] **Step 6: Add the download path in the SPA**

In `app/web/src/api.ts`, add below the other calls:

```typescript
// Export is a file, not JSON, so it bypasses get<T>(): the same session-token
// header, but the body is text and the row-count/truncation signals come back as
// response headers.
export async function apiExport(kind: string, params: Record<string, string | undefined>): Promise<{ csv: string; truncated: boolean; rows: number; filename: string }> {
	const token = await shopify.idToken();
	const res = await nativeFetch()(`/api/v1/export/${encodeURIComponent(kind)}.csv${qs(params)}`, {
		headers: { 'X-Shopify-Session-Token': token },
	});
	if (!res.ok) throw new Error(`${res.status}`);
	const disposition = res.headers.get('content-disposition') ?? '';
	const match = disposition.match(/filename="([^"]+)"/);
	return {
		csv: await res.text(),
		truncated: res.headers.get('x-sightline-truncated') === 'true',
		rows: Number(res.headers.get('x-sightline-row-count') ?? 0),
		filename: match ? match[1] : `sightline-${kind}.csv`,
	};
}
```

In `app/web/src/view.ts`, add the button next to the other primitives:

```typescript
// Export the CURRENT filter set, not the whole ledger — the useful artifact is
// the scoped list ("these 39 orders"), which is what an ops team otherwise
// rebuilds by hand.
export function exportButton(kind: string): string {
	return `<s-button data-export="${esc(kind)}">Export CSV</s-button>`;
}
```

Add `${exportButton('events')}` beside the `Search` button in `eventsView`'s filter stack, `${exportButton('findings')}` beside the `Filter` button in `findingsListView`, and `${exportButton('orders')}` beside the `Filter` button in `ordersView`.

In `app/web/src/main.ts`, add the download helper and bind it wherever filters are bound:

```typescript
// Download the export as a blob. A direct link cannot carry the session-token
// header, so the file is fetched and handed to a synthetic anchor.
async function downloadExport(kind: string, params: Record<string, string | undefined>): Promise<void> {
	const result = await apiExport(kind, params);
	const url = URL.createObjectURL(new Blob([result.csv], { type: 'text/csv;charset=utf-8' }));
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = result.filename;
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	URL.revokeObjectURL(url);
	if (result.truncated) {
		// Never let a capped export read as "this is everything".
		window.alert(`Exported the first ${result.rows} rows. Narrow the filters to export the rest.`);
	}
}

function bindExport(params: Record<string, string | undefined>): void {
	for (const button of document.querySelectorAll<HTMLElement>('[data-export]')) {
		button.addEventListener('click', () => {
			void downloadExport(button.getAttribute('data-export') ?? '', params);
		});
	}
}
```

Call `bindExport(eventQueryActive)` at the end of `paintEvents`, `bindExport(orderQueryActive)` at the end of `paintOrders`, and `bindExport(params)` at the end of `findingsList`. Extend the `./api.ts` import with `apiExport`.

- [ ] **Step 7: Test the UI surface and tenant scoping**

Add to `app/test/view.test.ts`:

```typescript
test('every list screen offers a CSV export', () => {
	assert.match(eventsView({}, [], false, ''), /data-export="events"/);
	assert.match(findingsListView({}, [], NOW, ''), /data-export="findings"/);
	assert.match(ordersView({}, [], false, ''), /data-export="orders"/);
});
```

Add to `app/test/crossTenant.test.ts` a case asserting that the export column maps only reference fields present in the corresponding API allowlist, so an export can never emit a field the API does not expose:

```typescript
test('export columns never reference a field outside the API allowlist', () => {
	const allowed: Record<string, readonly string[]> = {
		events: EVENT_FIELDS,
		findings: FINDING_LIST_FIELDS,
		orders: ORDER_LIST_FIELDS,
	};
	for (const kind of ['events', 'findings', 'orders'] as const) {
		for (const column of EXPORT_COLUMNS[kind]) {
			assert.ok(allowed[kind].includes(column.field), `${kind}.${column.field} is not in the API allowlist`);
		}
	}
});
```

Note: this test will fail on `events.orderName` unless Plan A added `orderName` to `EVENT_FIELDS` (it did — Plan A Task 8, Step 10). If it fails, that is the allowlist being out of date, not the test being wrong.

- [ ] **Step 8: Verify everything**

Run: `cd app && npm run contract:gen && npm test && npm run typecheck && npm run build && npm run lint:required && npm run format:check`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add app/src/csv.ts app/src/apiContract.ts app/resources.ts app/web/src/api.ts app/web/src/view.ts app/web/src/main.ts contracts/sightline-api-v1.json app/test/csv.test.ts app/test/view.test.ts app/test/crossTenant.test.ts
git commit -m "feat(export): CSV export of any filtered events/findings/orders list"
```

---

### Task 9: Surface failed fulfillment attempts as a first-class signal

Plan A created the detector; nothing shows it yet. This is the strongest signal in the product — direct evidence, no absence inference, no disclaimer needed — and it must not be visually merged with absence findings.

**Files:**
- Modify: `app/web/src/view.ts`, `app/web/src/main.ts`, `app/src/queries.ts` (`getSummary` finding counts by detector)
- Test: `app/test/queries.test.ts`, `app/test/view.test.ts`

**Interfaces:**
- Consumes: `GapFinding.detector` and the `detector` filter (Plan A); `FindingItem.detector`.
- Produces: `getSummary`'s `findings` object gains `failedAttempts: number`; `view.ts` gains `DETECTOR_LABELS`, `detectorLabel(detector?: string)`, a Type column and detector filter on the findings list, and a failed-attempt tile on the Overview.

- [ ] **Step 1: Write the failing tests**

Add to `app/test/queries.test.ts`:

```typescript
test('the summary counts unconfirmed failed-attempt findings separately from absence findings', async () => {
	const { events, projections, findings, deliveries, shops } = fixtures();
	await findings.put({ id: 'fulfillment_attempt_failed:s1:oB:1', shopId: 's1', orderId: 'oB', detector: 'fulfillment_attempt_failed', status: 'unconfirmed', detectedAt: NOW - 20 * HOUR });
	const summary = await getSummary({ events, projections, findings, deliveries, shops }, 's1', NOW);
	const f = summary.findings as { unconfirmed: number; failedAttempts: number };
	assert.equal(f.failedAttempts, 1);
	// It is still an unconfirmed finding, so the headline count includes it.
	assert.ok(f.unconfirmed >= 1);
});
```

Add to `app/test/view.test.ts`:

```typescript
test('findings show which detector produced them', () => {
	const absence: FindingItem = { id: 'f1', orderId: 'o1', orderName: '#1001', detector: 'fulfillment_confirmation', status: 'unconfirmed', detectedAt: NOW - HOUR };
	const failed: FindingItem = { id: 'f2', orderId: 'o2', orderName: '#1002', detector: 'fulfillment_attempt_failed', status: 'unconfirmed', detectedAt: NOW - HOUR };
	const html = findingsListView({}, [absence, failed], NOW, '');
	assert.match(html, /No confirmation observed/);
	assert.match(html, /Attempt did not succeed/);
});

test('the findings list offers a detector filter', () => {
	const html = findingsListView({ detector: 'fulfillment_attempt_failed' }, [], NOW, '');
	assert.match(html, /id="f-detector"/);
	assert.match(html, /value="fulfillment_attempt_failed" selected/);
});

test('an unlabelled detector degrades to a readable fallback rather than a blank cell', () => {
	assert.equal(detectorLabel(undefined), 'No confirmation observed');
	assert.equal(detectorLabel('something_new'), 'something_new');
});

test('the overview surfaces failed attempts as their own count', () => {
	const s = summary({ findings: { unconfirmed: 3, resolved: 1, suppressed: 0, failedAttempts: 2 } });
	const html = overviewView({ summary: s, flows: null, unconfirmed: [], setup: null, now: NOW });
	assert.match(html, /Failed attempts/);
	assert.match(html, /href="#\/findings\?detector=fulfillment_attempt_failed"/);
});

test('the absence disclaimer never appears on a failed-attempt finding', () => {
	const f: FindingDetail = {
		id: 'f2',
		orderId: 'o2',
		detector: 'fulfillment_attempt_failed',
		status: 'unconfirmed',
		detectedAt: NOW - HOUR,
		description: 'Shopify recorded a fulfillment attempt for this order that did not succeed.',
		expectation: null,
		projection: { orderId: 'o2', paidAt: NOW - 30 * HOUR, requiresFulfillment: true },
	};
	const html = findingDetailView(f, undefined, '');
	assert.doesNotMatch(html, /does not prove that a warehouse or carrier failed/);
	assert.match(html, /did not succeed/);
});

test('the absence disclaimer still appears verbatim on an unconfirmed absence finding', () => {
	const f: FindingDetail = {
		id: 'f1',
		orderId: 'o1',
		detector: 'fulfillment_confirmation',
		status: 'unconfirmed',
		detectedAt: NOW - HOUR,
		description: 'No Shopify fulfillment confirmation was observed for this paid, fulfillment-eligible order by the expected time.',
		expectation: { state: 'expired', deadline: NOW - HOUR },
		projection: { orderId: 'o1', paidAt: NOW - 73 * HOUR, requiresFulfillment: true },
	};
	assert.match(findingDetailView(f, undefined, ''), new RegExp(FINDING_DISCLAIMER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
```

Extend the imports with `detectorLabel`, add `detector?: string;` to `FindingItem` in `api.ts`, and add `failedAttempts: number` to `Summary['findings']`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && node --test test/queries.test.ts test/view.test.ts`
Expected: FAIL — `detectorLabel` is not exported; `findings.failedAttempts` is `undefined`.

- [ ] **Step 3: Count failed attempts in the summary**

In `app/src/queries.ts`, extend the findings tally in `getSummary`:

```typescript
	const findingCounts: Record<string, number> = { unconfirmed: 0, resolved: 0, suppressed: 0 };
	// Failed attempts are counted separately as well as inside `unconfirmed`: they
	// are DIRECT evidence (Shopify recorded an attempt that did not succeed) rather
	// than an inference from absence, so they deserve their own headline — but they
	// are still unconfirmed findings, so removing them from that count would make
	// the two numbers contradict each other.
	let failedAttempts = 0;
	for await (const f of tables.findings.search({ conditions: [{ attribute: 'shopId', value: shopId }] })) {
		const finding = f as unknown as GapFinding;
		if (finding.status in findingCounts) findingCounts[finding.status]++;
		if (finding.detector === DETECTOR_FAILED && finding.status === 'unconfirmed') failedAttempts++;
	}
```

and return `findings: { ...findingCounts, failedAttempts },`. Add `DETECTOR_FAILED` to the `./detector.ts` import.

- [ ] **Step 4: Surface it in the UI**

In `app/web/src/view.ts`, add near the findings constants:

```typescript
// Detector names are internal ids; these are the merchant-facing labels. The
// absence detector's label must never say "failed"; the presence detector's may,
// because Shopify recorded the unsuccessful attempt itself.
export const DETECTOR_LABELS: Record<string, string> = {
	fulfillment_confirmation: 'No confirmation observed',
	fulfillment_attempt_failed: 'Attempt did not succeed',
};
export const DETECTORS = ['', 'fulfillment_confirmation', 'fulfillment_attempt_failed'];

export function detectorLabel(detector: string | undefined): string {
	if (detector === undefined) return DETECTOR_LABELS.fulfillment_confirmation;
	return DETECTOR_LABELS[detector] ?? detector;
}
```

In `findingsListView`, add a Type column (header `{ label: 'Type' }` after `Order`) whose cell is `${esc(detectorLabel(x.detector))}`, and add a detector select to the filter stack:

```typescript
				<s-select id="f-detector" label="Type">${selectOptions(DETECTORS, params.detector ?? '', 'Any type')}</s-select>
```

Change `findingsListView`'s empty message to `'No findings — nothing is missing confirmation and no attempt has failed.'`

In `findingDetailView`, gate the verbatim disclaimer on the detector as well as the status — it is only literally true for the absence detector:

```typescript
	// The verbatim spec §4 disclaimer applies to the ABSENCE detector only: for a
	// failed attempt, "Shopify has not shown the expected confirmation yet" would
	// understate direct evidence that an attempt did not succeed. That finding
	// carries its own accurate description instead.
	const isAbsence = f.detector === undefined || f.detector === 'fulfillment_confirmation';
	const disclaimer =
		f.status === 'unconfirmed' && isAbsence
			? `<s-banner tone="warning" heading="What this finding does and does not mean">
					<s-paragraph>${esc(FINDING_DISCLAIMER)}</s-paragraph>
				</s-banner>`
			: '';
```

Also gate the "Why this qualified" block on `isAbsence` — its bullets describe the absence rule — and add a `['Type', esc(detectorLabel(f.detector))]` row to the Evidence `fields()` list.

In `overviewView`, add the failed-attempt tile to the findings grid:

```typescript
		<s-section heading="Findings">
			${statGridLinked([
				['Unconfirmed', s.findings.unconfirmed, '#/findings?status=unconfirmed'],
				['Failed attempts', s.findings.failedAttempts ?? 0, '#/findings?detector=fulfillment_attempt_failed'],
				['Resolved', s.findings.resolved, '#/findings?status=resolved'],
				['Suppressed', s.findings.suppressed, '#/findings?status=suppressed'],
			])}
		</s-section>
```

In `app/web/src/main.ts`'s `findingsList`, include the detector in the filter submit:

```typescript
	bindFilters('findingFilters', () => {
		const q = new URLSearchParams();
		for (const key of ['status', 'detector']) {
			const v = fieldValue(`f-${key}`);
			if (v) q.set(key, v);
		}
		location.hash = `#/findings${q.toString() ? `?${q}` : ''}`;
	});
```

and pass `detector: params.detector` through to `apiFindings`.

- [ ] **Step 5: Add a `state` filter to the events screen**

Failed fulfillments are also visible as raw events, but `state` was never filterable. In `app/src/apiContract.ts` add `'state'` to the events `filters`; in `app/src/queries.ts` add `state?: string;` to `EventQueryParams` and `['state', params.state],` to the condition loop; in `app/resources.ts` pass `state: p.get('state') ?? undefined,`; in `app/web/src/view.ts` add `'state'` to `EVENT_FILTER_KEYS`, the `eventQuery` key list, and a text field to the filter stack:

```typescript
				<s-text-field id="f-state" label="State" placeholder="error" value="${esc(params.state ?? '')}"></s-text-field>
```

- [ ] **Step 6: Run everything**

Run: `cd app && npm run contract:gen && npm test && npm run typecheck && npm run build && npm run lint:required && npm run format:check`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add app/src/queries.ts app/src/apiContract.ts app/resources.ts app/web/src/api.ts app/web/src/view.ts app/web/src/main.ts contracts/sightline-api-v1.json app/test/queries.test.ts app/test/view.test.ts
git commit -m "feat(ui): surface failed fulfillment attempts as a distinct signal"
```

---

### Task 10: Fix the Overview window inconsistency, then verify the whole plan live

**Defect being fixed:** the Overview heading says "Orders (last 7 days)" but `getSummary`'s order counts scan every projection for the shop with no window bound, while `computeFlows` filters on `lastEventAt >= windowStart`. The retention purge usually keeps them in agreement, so the divergence only shows up between purge runs, or when a run hits `MAX_DELETES_PER_RUN` — and then two panels on the same screen disagree about the same orders.

**Files:**
- Modify: `app/src/queries.ts` (`getSummary`, `computeFlows`)
- Test: `app/test/queries.test.ts`

**Interfaces:**
- Consumes: `isAwaitingConfirmation`, `deriveOrderLane` (Task 1).
- Produces: `getSummary` and `computeFlows` share one window predicate and one lane definition; `computeFlows` counts lanes via `deriveOrderLane`.

- [ ] **Step 1: Write the failing test**

Add to `app/test/queries.test.ts`:

```typescript
test('the summary order counts and the flow lanes describe the same window', async () => {
	const { events, projections, findings, deliveries, shops } = fixtures();
	// An order whose last activity is older than the window — present because the
	// purge has not run yet. Neither panel may count it.
	await projections.put({ id: 's1:oStale', shopId: 's1', orderId: 'oStale', paidAt: NOW - 20 * DAY, requiresFulfillment: true, state: 'awaiting', lastEventAt: NOW - 20 * DAY });
	const summary = await getSummary({ events, projections, findings, deliveries, shops }, 's1', NOW);
	const flows = await computeFlows(projections, 's1', NOW);
	const orders = summary.orders as { tracked: number; awaitingConfirmation: number };
	const lanes = (flows.lanes as Record<string, number>);
	assert.equal(orders.awaitingConfirmation, lanes.awaitingConfirmation);
	assert.equal(orders.tracked, 4, 'the out-of-window order must not be counted');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && node --test test/queries.test.ts`
Expected: FAIL — `tracked` is 5 and the awaiting counts differ by one.

- [ ] **Step 3: Share one window predicate and one lane definition**

In `app/src/queries.ts`, add above `getSummary`:

```typescript
// One definition of "in the read window" for every order-derived count, so the
// Overview's tiles, the flow lanes, and the worklist can never describe different
// sets of orders. Retention usually keeps expired projections out of the table
// anyway, but "usually" is not a guarantee: a purge run capped at
// MAX_DELETES_PER_RUN leaves residue behind, and that residue must not surface in
// one panel and not another.
function inWindow(p: OrderProjection, windowStart: number): boolean {
	return (p.lastEventAt ?? 0) >= windowStart;
}
```

In `getSummary`'s projection loop, skip out-of-window rows:

```typescript
	for await (const p of tables.projections.search({ conditions: [{ attribute: 'shopId', value: shopId }] })) {
		const proj = p as unknown as OrderProjection;
		if (!inWindow(proj, windowStart)) continue;
		ordersTracked++;
```

Rewrite `computeFlows` to use the shared predicate and lane function:

```typescript
// GET /flows — bounded lane counts derived from order projections in the window.
// A pure function of the projections, so it reconciles to fixtures and rebuilds.
// Lanes come from deriveOrderLane, the same definition the worklist and the
// summary use, so the three views cannot disagree.
export async function computeFlows(projections: QueryTable, shopId: string, now: number): Promise<Record<string, unknown>> {
	const windowStart = now - WINDOW_MS;
	const lanes = { paid: 0, fulfilled: 0, awaitingConfirmation: 0, cancelled: 0, refunded: 0 };
	for await (const p of projections.search({ conditions: [{ attribute: 'shopId', value: shopId }] })) {
		const proj = p as unknown as OrderProjection;
		if (!inWindow(proj, windowStart)) continue;
		if (proj.paidAt !== undefined) lanes.paid++;
		switch (deriveOrderLane(proj)) {
			case 'fulfilled':
				lanes.fulfilled++;
				break;
			case 'cancelled':
				lanes.cancelled++;
				break;
			case 'refunded':
				lanes.refunded++;
				break;
			case 'awaiting':
				lanes.awaitingConfirmation++;
				break;
			default:
				break;
		}
	}
	return { shop: shopId, windowDays: WINDOW_DAYS, lanes };
}
```

Note: this changes `fulfilled` from "has a fulfilledAt" to "is in the fulfilled lane", so a cancelled-after-fulfilment order now counts once, in `cancelled`. That is the point — the lanes now partition the orders instead of overlapping. Update any existing test that asserted the overlapping behavior, and check that `windowDays` is `WINDOW_DAYS` (the old code recomputed `WINDOW_MS / 86_400_000`).

- [ ] **Step 4: Run everything**

Run: `cd app && npm test && npm run typecheck && npm run build && npm run lint:required && npm run format:check`
Expected: all PASS.

- [ ] **Step 5: Update the screen spec and UX review**

In `docs/free_mvp_screen_spec.md`, add sections for the two new screens, in the file's existing style:
- **Orders (worklist):** purpose, columns (order, lane, paid, waiting, value, tracking, Admin link), filters (lane, age, sort), states (loading/empty/error/auth-expired/stale), and the rule that the lane definition comes from `src/orders.ts` and nowhere else.
- **Order detail:** the observed timeline, findings for the order, events for the order, the Admin deep link, and the rule that every timeline entry is an observation with a source timestamp.

Also record: the aging breakdown on the Overview, the capture-integrity section and its exact claim boundary, CSV export on every list with truncation disclosure, and the failed-attempt signal being visually distinct from absence findings with no absence disclaimer.

In `docs/ux-review.md` §1, add rows for **Orders** and **Order detail** to the screen/state coverage table, and note in §3 that the failed-attempt copy was reviewed separately from the absence copy — it may state that an attempt did not succeed because Shopify recorded that, and it still names no downstream party.

- [ ] **Step 6: Commit**

```bash
git add app/src/queries.ts app/test/queries.test.ts docs/free_mvp_screen_spec.md docs/ux-review.md
git commit -m "fix(overview): order counts and flow lanes now share one window and one lane definition"
```

- [ ] **Step 7: Deploy and verify live in the embed**

Run: `cd app && npm run deploy && npm run smoke`
Expected: smoke passes.

Then open the app inside Shopify Admin on the dev store and confirm, because none of this is provable from unit tests:
1. **Orders** appears in the nav and lists real orders with `#1001`-style names, lanes, ages, and values.
2. Clicking an Overview tile lands on the worklist **filtered** to that lane; clicking an aging bucket lands filtered to that threshold.
3. An order row opens a detail screen with a chronological observed timeline, its events, and its findings.
4. **Open in Shopify** navigates the top-level Admin to that order (not a nested iframe).
5. **Export CSV** downloads a file whose contents match the on-screen filter, and opening it in a spreadsheet shows no executed formula for an order name beginning with `=`.
6. A finding from each detector renders with the correct label, and the absence disclaimer appears on the absence finding only.
7. The capture-integrity section reports honestly (it will usually say everything arrived by webhook).
8. Every screen still handles an expired session — leave the tab idle, then click a filter, and confirm the auth-expired state rather than a raw error.

- [ ] **Step 8: Open the PR**

```bash
gh pr create --title "feat: orders worklist, integrity views, export and deep links" --body "$(cat <<'EOF'
Implements Plan B (docs/superpowers/plans/2026-08-07-plan-b-orders-worklist-and-views.md).

- Orders worklist + order detail: aggregates now drill into an actionable list
- One derived order lane (src/orders.ts), written to the previously-dead indexed state column
- Aging breakdown (sub-deadline visibility) with drill-down from every count
- Capture-integrity view: events found by direct check rather than webhook, with an exact claim boundary
- Order names + Shopify Admin deep links everywhere an order appears
- CSV export of any filtered list, with formula-injection neutralization and truncation disclosure
- Failed fulfillment attempts surfaced as a distinct signal (no absence disclaimer, which would be false)
- Fixes the Overview "last 7 days" vs unfiltered order-count divergence

No writes to Shopify, no new scopes, capabilities unchanged (record only).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Squash-merge with no reviewers.

---

## Deferred from this plan

- **Notification of any kind.** A merchant still has to open the app to learn anything. Plan C adds the digest.
- **Multi-store / agency views.** Requires identity work well beyond the MVP.
- **A Sankey or alluvial flow map.** The lane table is honest, accessible, and now clickable; a flow diagram over five lanes would be decoration.
- **Per-SKU and per-location aggregate screens.** The data now supports them (Plan A's `EventSku`, `locationId`, `ShopLocation`), but no view is planned until Gate 2 shows merchants asking for them.
</content>
