# Plan D: Follow-up corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the seven actionable follow-ups recorded during Plan C's review, and shrink the digest outbox to counts plus a subject line.

**Architecture:** Three groups. (1) Make `src/db.ts` loadable under `node --test`, then convert the three guards that read source text into real imports. (2) Shrink `DigestOutbox` to counts and a subject, removing the last retention of order names beyond the ledger's seven days. (3) Close four specific test-integrity and correctness gaps, one of which needs a DOM harness.

**Tech Stack:** Harper v5 native application, TypeScript via TypeStrip, `node --test`, Vite for the SPA, oxlint, Prettier.

## Global Constraints

- **Zero RUNTIME dependencies.** `dependencies` in `package.json` must stay empty. This plan adds exactly one **devDependency** (a DOM harness, Task 8) and nothing else.
- **No sender.** Nothing in this plan sends mail. `digestText` and `digestHtml` become uncalled by design and must be marked as awaiting a sender, not deleted.
- Tabs, not spaces. `.ts` extensions on import paths. Never `console.*` — log via `log()` from `src/observe.ts`.
- **Never log or audit the notification email address.** It is the only merchant-identifying string the app stores.
- **Product-truth copy discipline.** An absence must be hedged and never stated as a failure; a presence must not carry an absence hedge; neither may name a warehouse, carrier, vendor or 3PL. A digest carries no customer data.
- **A test must be able to fail.** For every test added or changed, name the single edit to the source that breaks it, make that edit, confirm the failure, revert.
- **Name every pre-existing assertion whose expected value changes, with the reason the new value is right.** Never move an expectation to make something pass.
- Every live step — `npm run deploy`, `npm run smoke`, `describe_table`, dev-store checks, `gh` — is deferred to the human and collected into `docs/plan-d-release-steps.md`.

---

### Task 1: Make `src/db.ts` loadable under `node --test`

`src/db.ts` does `import { databases } from 'harper'`. That module exists only inside the deployed Harper runtime and has no file on disk, so **anything importing `db.ts` dies with `ERR_MODULE_NOT_FOUND`** — which is why `resources.ts` and `jobs.ts` have no tests, and why three guards read source text instead of importing.

**Files:**
- Modify: `app/src/db.ts`, `app/package.json`
- Create: `app/test/harperStub.ts`, `app/test/db.test.ts`

**Interfaces:**
- Produces: `src/db.ts` becomes importable under `node --test` with no change to its exports. Production resolution of `harper` is unchanged.

- [ ] **Step 1: Write the failing test**

Create `app/test/db.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DigestSubscriptions, DigestOutboxes, Shops } from '../src/db.ts';

// The point of this test is that it can be written at all. Before the `#harper`
// mapping, importing src/db.ts threw ERR_MODULE_NOT_FOUND and every module
// reaching it — resources.ts, jobs.ts, ledgerTargets.ts — was untestable.
test('the table handles load under node --test', () => {
	for (const handle of [DigestSubscriptions, DigestOutboxes, Shops]) {
		assert.ok(handle, 'a table handle must resolve');
	}
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd app && node --test test/db.test.ts`
Expected: FAIL — `Cannot find package 'harper'`.

- [ ] **Step 3: Add the stub**

Create `app/test/harperStub.ts`. It stands in for the runtime module and must expose only what `db.ts` reads. Read `src/db.ts` first and match the shape it destructures; do not guess. A `databases` proxy returning inert table objects is enough — no behavior is under test here, only resolvability.

Give the file a comment saying it exists solely so `db.ts` can be imported, that it is **never** loaded in production, and that a test needing real table behavior should use `test/fakeTable.ts` instead.

- [ ] **Step 4: Map the specifier**

In `app/src/db.ts`, change the import to `'#harper'`. In `app/package.json`, add:

```json
	"imports": {
		"#harper": {
			"test": "./test/harperStub.ts",
			"default": "harper"
		}
	}
```

Then add `--conditions=test` to the `test` script so the `test` condition only ever resolves under the test runner. Production has no such flag, so it takes `default` and resolves the real `harper` exactly as before.

- [ ] **Step 5: Run the test and the full suite**

Run: `cd app && npm test`
Expected: PASS, including the new test.

**Verify production resolution did not change**: confirm nothing outside `package.json`'s `imports` block references `harperStub`, and that a plain `node --input-type=module -e "import('./src/db.ts')"` **without** `--conditions=test` still fails to resolve `harper` — that failure is the proof the stub is not reachable in a production-shaped resolution.

- [ ] **Step 6: Commit**

```bash
git add app/src/db.ts app/package.json app/test/harperStub.ts app/test/db.test.ts
git commit -m "test: make the table handles loadable under node --test"
```

**Deferred to the human:** whether Harper's component loader honors `package.json` `imports` at deploy time. If it does not, `db.ts` fails to resolve `#harper` in production — a loud failure, not a silent one, but it must be verified on the dev store before this is trusted. Record it for `docs/plan-d-release-steps.md`.

---

### Task 2: Convert the three source-text guards into real imports

Three tests read source files as text because they could not import them. All three check **values**, which are introspectable at runtime once `db.ts` loads.

**Files:**
- Modify: `app/test/ledgerTargets.test.ts`, `app/test/queries.test.ts`, `app/test/privacyPolicy.test.ts`

**Interfaces:**
- Consumes: Task 1's `#harper` mapping.

- [ ] **Step 1: Convert `test/ledgerTargets.test.ts`**

It currently regex-extracts array entries from `src/ledgerTargets.ts`. Import `REDACT_TARGETS`, `RETENTION_TARGETS`, `OUTBOX_RETENTION_TARGETS` and `OUTBOX_RETENTION_DAYS` directly and assert on the real objects: both digest tables present in `REDACT_TARGETS` with **no** `orderField`, absent from `RETENTION_TARGETS`, `DigestOutbox` present in `OUTBOX_RETENTION_TARGETS` with `tsField: 'createdAt'`, and `OUTBOX_RETENTION_DAYS === 30`.

Keep asserting on named entries rather than deep-equalling whole arrays — a whole-array assertion breaks on every unrelated table and trains people to update it without reading it.

This also retires the known fragility that reflowing an entry across lines trips the regex.

- [ ] **Step 2: Convert the two retention cross-checks**

`test/queries.test.ts` and `test/privacyPolicy.test.ts` each read `src/ledgerTargets.ts` as text to confirm their local `DIGEST_OUTBOX_RETENTION_DAYS = 30` literal matches the real constant. Import `OUTBOX_RETENTION_DAYS` and compare directly.

**Keep both guards.** They exist because the constant is duplicated in two files that cannot import it — verify whether that is still true now that `db.ts` loads. If `queries.ts` and `privacyPolicy.ts` can now import `OUTBOX_RETENTION_DAYS` themselves, **delete the duplicated literals** and say so in your report; the guard then becomes unnecessary and should go with them. If they still cannot, keep the literals and the guards, now import-based.

- [ ] **Step 3: Prove each converted guard still catches its defect**

For each, reproduce the mutation the text version caught: add an `orderField` to the real `DigestSubscription` entry; move `DigestOutbox` into `RETENTION_TARGETS`; change `OUTBOX_RETENTION_DAYS` to 45. Confirm each reddens, then revert. A guard that stops catching its defect after conversion is a regression, not a cleanup.

- [ ] **Step 4: Run the suite and commit**

```bash
git add app/test/ledgerTargets.test.ts app/test/queries.test.ts app/test/privacyPolicy.test.ts
git commit -m "test: assert on the real target arrays instead of their source text"
```

---

### Task 3: Shrink `DigestOutbox` to counts and a subject

A stored digest keeps a record of what a period looked like, which is worth having after the seven-day ledger has purged the events it describes. It does **not** need to keep the message: the bodies name the five longest-waiting orders, which is the last retention of merchant data beyond seven days and the reason the outbox needed its own disclosure.

The **subject** is derived from the period, the counts and recorder health only — it names no orders — so it stays.

**Files:**
- Modify: `app/schema.graphql`, `app/src/model.ts`, `app/src/digest.ts`, `app/test/digest.test.ts`, `app/src/privacyPolicy.ts`, `app/src/queries.ts`, `app/web/src/view.ts`, `docs/data-inventory.md`
- Test: `app/test/privacyPolicy.test.ts`, `app/test/queries.test.ts`, `app/test/view.test.ts`

- [ ] **Step 1: Drop the two body columns**

Remove `bodyText` and `bodyHtml` from `DigestOutbox` in `schema.graphql` and from the interface in `src/model.ts`. Keep `subject`.

Extend the schema comment to say what the row is and is not: a durable record of what a period looked like, kept because the ledger purges at seven days — counts and a subject line, never the message body, so it holds no order names and no customer data.

- [ ] **Step 2: Stop rendering bodies into the row**

In `outboxRow` (`src/digest.ts`), stop setting `bodyText` and `bodyHtml`. Keep `subject: digestSubject(input)`.

- [ ] **Step 3: Mark the body renderers as awaiting a sender**

`digestText` and `digestHtml` now have no caller. **Do not delete them.** They encode the product-truth copy discipline — the boundary paragraph that travels with the message, the presence/absence split, HTML escaping — which took three review rounds and two false-promise corrections to settle.

Add a comment above each saying it is intentionally uncalled, that a sender is the caller it is waiting for, and that its tests are what keep the copy from rotting. Someone will otherwise read them as dead code and delete them.

- [ ] **Step 4: Update the outbox row test**

`test/digest.test.ts` asserts `bodyText` and `bodyHtml` are non-empty. Replace with assertions that the row carries a non-empty `subject`, and that it has **no** body fields:

```typescript
	assert.equal(Object.hasOwn(row, 'bodyText'), false);
	assert.equal(Object.hasOwn(row, 'bodyHtml'), false);
```

Also assert the row as serialized contains no order name from the input — the same shape of guard used for the removed `email` field, which catches a body sneaking back in by any route.

The tests for `digestText` and `digestHtml` themselves **stay unchanged**. They are now the only thing holding that copy in place.

- [ ] **Step 5: Simplify the disclosure on all four surfaces**

The outbox no longer holds order names, so every surface that discloses its retention can say something simpler and stronger. Update, keeping each consistent with the others:

- `src/privacyPolicy.ts` — the notification-email paragraph's sentence about digests being kept 30 days
- `src/queries.ts` — `getPrivacy`'s `deletion` block and the `dataCategories` entry
- `docs/data-inventory.md` — the `DigestOutbox` row's fields and purpose
- `app/web/src/view.ts` — the Notifications banner's "stores it for 30 days, then removes it"

The accurate claim is now: a record of each digest — its counts and its subject line — is kept for 30 days; it contains no order names and no customer data.

**The four must agree.** A reviewer will read them side by side. Extend the existing pinned banner test to assert the new claim, and check whether the retention cross-check guards from Task 2 still describe reality.

- [ ] **Step 6: Run everything and commit**

Run: `cd app && npm run contract:gen && npm test && npm run typecheck && npm run lint:required && npm run format:check && npm run build`

```bash
git add app/schema.graphql app/src/model.ts app/src/digest.ts app/src/privacyPolicy.ts app/src/queries.ts app/web/src/view.ts app/test docs/data-inventory.md contracts/sightline-api-v1.json
git commit -m "feat(digest): keep a record of each digest, not the message"
```

**Deferred to the human:** `describe_table` must confirm `DigestOutbox` has **no** `bodyText` and **no** `bodyHtml`. The table has never been deployed, so this is a fresh create with no migration.

---

### Task 4: Give `getSummary`'s reconciliation match the same margin as the digest

`gatherDigestInput` matches a reconciliation event against its webhook twin within a margin on both edges, because the two paths timestamp the same real change differently — the webhook from the payload's `updated_at`/`processed_at`, reconciliation from `createdAt`/`cancelledAt`/`fulfilledAt`/`updatedAt`. `getSummary`'s `reconciliationOnlyEvents` has no margin, so a pair split across the window's edge still reports a phantom capture gap on the Overview.

It was left out of Plan C deliberately: the same query also produces `eventsTotal`, the activity buckets and `webhookEvents`, so widening it means those three must be gated in code to stay in-window. **Three already-shipped numbers move to fix a fourth — that is the risk in this task, and every one of them needs a pin.**

**Files:**
- Modify: `app/src/queries.ts`
- Test: `app/test/queries.test.ts`

- [ ] **Step 1: Pin the three tallies before touching the query**

Before changing anything, add or confirm assertions that `eventsTotal`, `webhookEvents` and the activity buckets each equal a specific value for a fixture with events **inside** the window and events **just outside** it. These are the regression net for the change. Run them and confirm they pass first.

- [ ] **Step 2: Widen the query, gate the tallies**

Widen the event query's lower bound by the same margin `digestData.ts` uses (import it rather than redeclaring the number). Then, inside the loop, skip out-of-window rows for `eventsTotal`, `webhookEvents` and the buckets, while letting the widened rows populate the webhook key set.

Say in a comment why the two populations differ: the wider set exists only to recognise a twin, and must never be counted.

- [ ] **Step 3: Prove the phantom gap is gone and the tallies did not move**

Add a test with the concrete failing case: a webhook event timestamped just before `windowStart` and its reconciliation twin just inside. `reconciliationOnlyEvents` must be **0**. Then a reconciliation event with no twin anywhere must still be **1** — without that second assertion, a change that zeroes the number passes.

Confirm the Step 1 pins still pass unchanged. If any moved, stop: that is the regression this task exists to avoid, and it needs reporting rather than an updated expectation.

- [ ] **Step 4: Commit**

```bash
git add app/src/queries.ts app/test/queries.test.ts
git commit -m "fix(integrity): match a reconciliation event to a twin just outside the window"
```

---

### Task 5: Extract `runPurgeCycle` so purge independence is tested

The ledger purge and the outbox purge now run in separate try/catch blocks so a ledger failure cannot stop the outbox sweep — and nothing tests that, because `jobs.ts` cannot be imported. The failure it prevents is a persistent ledger error silently disabling a publicly disclosed 30-day retention.

**Files:**
- Create: `app/src/purgeCycle.ts`, `app/test/purgeCycle.test.ts`
- Modify: `app/jobs.ts`

**Interfaces:**
- Produces: `runPurgeCycle(deps: { purge, outboxPurge, log, metrics }, now: number): Promise<{ ledger: PurgeResult | undefined; outbox: PurgeResult | undefined }>`

- [ ] **Step 1: Write the failing tests**

Cover, at minimum:
- the outbox sweep runs **even when the ledger purge throws**, and the thrown error is logged rather than propagated
- the ledger sweep's result is unaffected when the **outbox** purge throws
- both results feed `metrics.inc` for deleted counts and for failures
- residue is logged for both

Inject `log` and `metrics` as test doubles and assert on what they received — the point is the wiring, so a test that only checks return values proves nothing.

- [ ] **Step 2: Extract the body**

Move the two try/catch blocks out of `purgeTick` into `src/purgeCycle.ts` as a deps-injected function, following `src/inventoryEnrich.ts` and `src/stateBackfill.ts`. `jobs.ts` keeps the ticker and passes the real `runPurge`, `runOutboxPurge`, `log` and `metrics`.

Behavior must not change. This is a refactor whose only purpose is testability.

- [ ] **Step 3: Verify and commit**

```bash
git add app/src/purgeCycle.ts app/test/purgeCycle.test.ts app/jobs.ts
git commit -m "refactor(purge): make the two sweeps' independence testable"
```

---

### Task 6: Make the awaiting guard stand alone

The test asserting the digest's `ordersAwaiting` equals `getSummary`'s `orders.awaitingConfirmation` catches all digest-side drift, but **not** an Overview-side predicate change that preserves the count on that fixture — because no fixture row exercises `requiresFulfillment: false`, `cancelledAt`, or `fullyRefundedAt`. Six other tests cover those today, so nothing ships silently; the guard is simply weaker than it appears.

**Files:**
- Modify: `app/test/digestData.test.ts`

- [ ] **Step 1: Add the two missing row shapes**

Add to the shared `tables()` projections fixture: a **cancelled** paid order, and a paid order with `requiresFulfillment: false` (a digital order — the `no_fulfillment_expected` lane). Both are awaiting-negative, so **no existing expected count changes**. Confirm that: if any does, recompute rather than adjust.

- [ ] **Step 2: Prove the guard now stands alone**

Apply the count-preserving mutation that previously slipped through — replace `isAwaitingConfirmation(proj)` in `getSummary` with `proj.paidAt !== undefined && proj.fulfilledAt === undefined` — and confirm the guard test **now** fails. Revert.

Then confirm the digest-side mutation still fails it. Both directions, or the guard is only half-anchored.

- [ ] **Step 3: Commit**

```bash
git add app/test/digestData.test.ts
git commit -m "test(digest): exercise every clause of the awaiting predicate in the guard"
```

---

### Task 7: Add a DOM harness and test `main.ts`'s handlers

There are **no DOM tests anywhere in this repo** — no harness, and nothing imports `main.ts`. That is why a 401 on save rendered a bare "401" instead of the reauthorization view: the decision was testable once extracted, but whether the handler rendered the right view was verified only by reading. Every click handler in that file has the same gap.

**Files:**
- Modify: `app/package.json`
- Create: `app/test/main.test.ts`

- [ ] **Step 1: Add the harness as a devDependency**

Add `happy-dom` (or `jsdom`) to **`devDependencies`**. `dependencies` must stay empty — confirm with `git diff` that only the dev block changed, and that `npm run build` output is unaffected.

- [ ] **Step 2: Write tests for the wiring, not the logic**

`main.ts` imports `./api.ts`, which calls `shopify.idToken()` and `fetch`. Set up a document, stub the App Bridge global and `fetch`, then drive the real handlers.

Cover the case that motivated this task: **a save that 401s renders the reauthorization view**, not a banner containing "401". Assert on what is in the document afterwards. Then cover a 400 rendering its validation reason, and a successful save re-rendering with the confirmation.

Keep these tests about wiring — which function ran, what got rendered. The decisions themselves are already covered by `saveErrorAction`'s unit tests, and duplicating that logic here would create two places to update.

- [ ] **Step 3: Prove each test can fail**

For the 401 test, change the handler to render the banner instead of `authExpiredView()` and confirm it fails. That mutation is precisely the shipped bug this harness exists to have caught.

- [ ] **Step 4: Verify and commit**

Confirm `npm test` picks the new file up and that runtime dependencies are still zero.

```bash
git add app/package.json app/package-lock.json app/test/main.test.ts
git commit -m "test(ui): drive the save handler through a real document"
```

---

### Task 8: Guard the `schema.graphql` ↔ `src/model.ts` mirror

`src/model.ts` is a hand-maintained mirror of `schema.graphql`. Nothing enforces it. Plan C's two renames were safe only because both sides moved in one commit; a one-sided rename produces a **runtime-only** failure — a write naming a column the `@sealed` table lacks — invisible to a suite that uses `FakeTable` throughout, with `describe_table` the only thing that would catch it.

**TypeScript interfaces are erased at runtime**, so this cannot be done by importing `model.ts`. Use the TypeScript compiler API (`typescript` is already a devDependency) to read the interface declarations, and parse the SDL.

**Files:**
- Create: `app/test/schemaMirror.test.ts`

- [ ] **Step 1: Decide the comparison and write it down first**

Before coding, write a comment at the top of the test stating exactly what is compared and what is deliberately not. A guard whose scope is unclear gets weakened by the next person who trips it.

At minimum, per `@table` type in the schema: the set of field names matches the interface's, and every schema field marked `!` is non-optional in TypeScript while every nullable one is optional. Type-level equivalence (`Float` ↔ `number`) is worth checking if it stays simple — the `Int`-versus-`Float` distinction matters here, because an epoch-ms column typed `Int` truncates.

- [ ] **Step 2: Make it fail before it passes**

Write the test, then **verify it catches each drift class** by making the change and reverting: rename a field on one side only; make a required field optional in TypeScript; add a field to the schema and not the model; change a `Float` to `Int`.

If any of those passes, the guard does not do its job. Report which, rather than narrowing the claim to match what you implemented.

- [ ] **Step 3: Fail loudly on a parse it does not understand**

If the SDL or a declaration cannot be parsed, the test must **fail with a clear message**, never silently pass. This is the failure mode that has bitten this repo before — a guard that stops matching after a cosmetic edit and goes quiet. Add a test proving an unparseable input fails.

- [ ] **Step 4: Commit**

```bash
git add app/test/schemaMirror.test.ts
git commit -m "test: enforce the schema and model mirror"
```

---

## Not in this plan

- **The in-app outbox view.** The compelling version was a preview of the rendered message; with bodies gone there is little to show. Revisit if a sender ships.
- **A sender.** Still out of scope: it needs a mail provider, unsubscribe handling, bounce handling, and a decision about sending from a Harper component versus a separate worker.
- **Product-update contact.** The subscription's consent covers the digest only. Using the address to contact a merchant about the paid version requires a fresh, explicit opt-in — a new field, its own control, and its own disclosure.
- **`purgeTicker`'s stall budget** is half its interval, the same shape corrected for the digest ticker. Pre-existing and untouched.
