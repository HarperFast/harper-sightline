# Sightline — Recover Tier Design (post-MVP phase 1)

- Status: **design only — not committed, not funded.** No implementation follows from this document.
- Date: 2026-08-11
- Scope: the paid **Recover** tier as described in the [product brief](./sightline_product_brief_v3.md) §Tiers — 90-day retention, View & replay, recovery artifacts, catalog connectors, correlation, billing.
- Prerequisites, both unresolved: **Gate 1** (re-announcement mechanism validation) and **Gate 2** (incident-volume pilot, designed in [gate2-pilot-design.md](./gate2-pilot-design.md), thresholds in its §7).
- Successor phase: [Cluster tier design](./cluster-tier-design.md).

## 0. Read this first: the gate governs the shape of the tier

Recover's headline mechanism — pulse a carrier field so Shopify re-emits events through every existing vendor subscription — **has never been tested**. The brief calls Gate 1 "one afternoon, dev store," and the development plan records it as "the higher-priority prerequisite for the paid tier … cheaper, more decisive, and currently untracked" ([free_mvp_development_plan.md](./free_mvp_development_plan.md) §Gate 2 note). Nothing in this repo tracks it today.

That is not a footnote, because the answer changes what the tier *is*:

| Gate 1 outcome | What Recover becomes |
|---|---|
| **Tag pulse re-triggers most sync apps** | The brief's tier. Re-announcement is the headline, "one button, View & replay" is honest, and the vendor shortlist is product IP. |
| **Tag pulse re-triggers few or none** | Recover collapses to **feeds + artifacts + longer retention + correlation**. Still a sellable tier, but "one button" becomes "here is the exact file to give your vendor," and the pricing story weakens. |
| **Mixed (likely)** | Re-announcement ships as a per-vendor capability limited to the validated shortlist, with an explicit exclusion list. The planner must then be honest per lane rather than promising a single button. |

§6 designs both branches. §7 names which work is safe to start before the gate resolves — most of it, as it turns out, which is why this document is worth having now.

**Gate 1 needs an owner and an artifact.** It is not designed here (it is an afternoon of manual dev-store work, not an architecture), but its output must be committed as a file — a table of the top ~20 sync-type apps by install density, the pulse applied, whether the app re-evaluated, and how that was observed. Without that file, no re-announcement code should be written, and §7's Branch A work stays blocked.

## 1. What ships (assuming both gates pass)

Per the brief's tier table, at ~$49/mo:

| Capability | `capabilities.ts` seam | Status in MVP |
|---|---|---|
| 90-day retention | `long_retention` (partially — see §3) | `RETENTION_DAYS = 7`, hard |
| Scoped re-announcement | `reannounce` | `false`; no write scopes exist |
| Feed access + replay sessions | `replay` | `false`; no feed surface |
| Recovery artifact generation | `replay` | CSV export exists, is not an artifact generator |
| Catalog connectors | `connectors` | `false`; none exist |
| Correlation | (implied by `connectors`) | none |
| Alerts / anomaly detection | — | digest email exists (`digestBuild.ts`) |

The entitlement plumbing is already in place and needs no call-site churn: `capabilitiesFor(shopId)` returns a fixed `RECORD_ONLY` profile today, and its comment already anticipates reading `Shop.capabilityProfile` with an unchanged signature. Resources call `requireCapability`, not plan-name strings. That was a good MVP decision and it holds.

## 2. Subsystems

Seven, in rough dependency order. Only the first two are unavoidable for any version of the tier.

1. **Entitlement + billing** (§2.1)
2. **Per-shop retention** (§2.2) — the highest-risk non-obvious piece
3. **Replay planner + audit** (§2.3)
4. **Re-announcement executor** (§2.4) — Gate 1 dependent
5. **Feed + replay sessions (re-serve)** (§2.5)
6. **Recovery artifacts** (§2.6)
7. **Connectors + correlation** (§2.7)

### 2.1 Entitlement + billing

Shopify's Billing API (app subscriptions) plus the `app_subscriptions/update` webhook. `Shop` gains a capability profile and subscription state; `capabilitiesFor` reads it.

The design question that matters is not the happy path, it is **downgrade**. A shop that paid for 90-day retention and stops paying is holding 83 days of merchant data it is no longer entitled to keep, and the privacy policy will have told the merchant a retention figure. Downgrade must therefore *shorten* retention, which means deleting data the merchant may still be looking at.

Proposed rule, to be confirmed with whoever owns the policy language: on downgrade the shop's rows are re-stamped to the free window and the next purge removes the excess, with the merchant warned before the subscription lapses and once after. This is a deletion the merchant did not explicitly request, so it must be disclosed in the policy *before* the tier ships, not at the moment it first happens.

Grace behavior, trial handling, and what a failed payment does to an in-flight replay are open.

### 2.2 Per-shop retention (7 → 90 days)

This looks like changing a constant and is not.

**What already generalizes.** `cutoffMs(nowMs, retentionDays = RETENTION_DAYS)` and `purgeExpired(targets, nowMs, retentionDays)` in `src/retention/retention.ts` already take retention as a parameter, and ADR-003's mechanism (real `DELETE` + re-query verification) is retention-length agnostic. The digest outbox already proves a second, longer window can coexist (`OUTBOX_RETENTION_DAYS = 30`).

**What does not.** The purge sweeps *by timestamp across a whole table*, for every shop at once. With mixed tiers in one table there is no single cutoff, and per-shop purge passes would multiply the sweep by the shop count.

**Proposed model: stamp expiry on write.** Each ledger row carries an `expiresAt` set from the shop's entitlement when the row is written. Purge becomes a single sweep on `expiresAt < now` — same mechanism, same verification, no per-shop iteration, and mixed tiers cost nothing. On a tier change, a backfill sweep re-stamps the shop's existing rows; `src/jobs/stateBackfill.ts` is the working precedent for exactly that shape of one-off convergent sweep (checkpointed, idempotent, with a metric that must fall to zero).

**Consequences that reach outside the retention code:**

- `WINDOW_DAYS = 7` in `src/api/apiContract.ts` is both the retention window *and* the bounded read window, and it is baked into `contracts/sightline-api-v1.json`, which `contract.test.ts` gates against drift. A per-tier window makes `windowDays` a per-shop value in the contract — a real contract change, not a constant edit.
- `src/privacy/privacyPolicy.ts` interpolates `WINDOW_DAYS` into the public policy, and those claims are deliberately pinned by tests to the code's own constants. Per-tier retention means the policy must state both figures and which applies, and the policy is served publicly and versioned with the app.
- [data-inventory.md](./data-inventory.md) maps table/field → retention behavior and is test-backed. It needs the per-tier column.
- **Storage is ~13× at 90 days.** The reliability report §5 already flags `inventory_levels/update` as the voluminous topic and names "an ingest filter or shorter inventory retention" as the lever. At 90 days that stops being a footnote — inventory may need a shorter window than orders even inside Recover. Cost modelling is an open item.
- **Compliance surface grows.** `shop/redact` / `customers/redact` / uninstall must still delete everything, and there is now 13× more of it. `MAX_DELETES_PER_RUN = 10_000` means redaction of a large 90-day shop spans multiple runs; the compliance path must be verified to converge, not just to start.
- **PCD posture.** Protected customer data held 13× longer is a data-minimisation question Shopify may want re-justified. Level 1 was granted 2026-08-04 on a 7-day story.

### 2.3 Replay planner + audit

The planner turns a finding's scoped record list — which the MVP detector already produces, and which the brief correctly identifies as the artifact ops teams build by hand — into a proposed plan with one line per lane and a mechanism per line.

Non-negotiables, inherited from the brief and from the MVP's product-truth discipline:

- **Propose → approve → execute**, never implicit. The proposal is durable and auditable.
- **Dry run** shows exactly which records and which mechanism before anything happens.
- **Idempotency keys** per operation, so a retry or a double-click cannot double-pulse.
- **Full audit in the ledger.** `src/audit.ts` already appends caller-keyed, PII-free audit rows and is the right primitive.
- **Cannot fabricate.** No mechanism may invent an outcome that did not occur.

New tables: `ReplayPlan` (proposal, scope, status), `ReplayLine` (lane, mechanism, record set), `ReplayExecution` (attempts, results, idempotency key).

### 2.4 Re-announcement executor — Gate 1 dependent

Mechanism: write a safe carrier field (tag or metafield) on each affected record so Shopify emits a fresh `orders/updated`, which every existing vendor subscription processes through its own normal, correctly signed delivery.

**Scope change.** Requires a write scope — per the brief, "the one exception to read-only below Scale," requested at upgrade. Today `shopify.app.toml` declares five read scopes and `optional_scopes = [ ]`, and every write capability in `capabilities.ts` is hard-`false`. Adding a write scope forces merchant re-authorization and moves the app into a different App Store review posture. Prefer the narrowest scope that permits a tag or metafield write, and keep it in `optional_scopes` so free-tier installs remain read-only.

**Three risks the brief does not dwell on, in descending order of seriousness:**

1. **Blast radius.** A pulse re-emits to *every* subscriber on that topic, not to the one that missed the event. Re-announcing 742 orders sends 742 events to every app subscribed to `orders/updated` — including apps that processed them correctly the first time. For idempotent consumers that is wasted work; for non-idempotent ones it risks duplicate side effects (a second pick ticket, a second notification email). This is inherent to the mechanism, not an implementation detail, and it means the honest UI cannot say "re-deliver to ShipHero" — it must say "make Shopify re-emit these records to all subscribers." Gate 1 should record, per app, not only "does it re-evaluate" but "does it re-evaluate *safely* when it did not need to."
2. **Merchant automations.** Shopify Flow and merchant-authored logic frequently key on tags. A pulse can trigger customer-visible automations. Mitigations: prefer a metafield over a tag where vendors honour it; use a reserved namespaced key; disclose plainly; and let the merchant preview the exact field change before approving.
3. **Throttling.** Bulk re-announcement is a bulk Admin API *write* path, so it will hit Shopify's rate limits — the same surface where `ThrottledAdminApiError` and the `reconcile.throttled` metric were just added for reads (PR #80). The executor must consume that classification properly: pace itself, resume from a durable cursor, and never lose a record because the quota ran out mid-plan. The reconcile sweep's partial-progress contract in `src/shopify/reconcileSweep.ts` is the pattern to copy.

**Reversibility.** If the carrier is a tag, the pulse should remove it again, and the whole operation must be recorded well enough that a merchant asking "what did you change on my orders?" gets an exact answer.

### 2.5 Feed + replay sessions (re-serve)

The lane the brief likes most, because it is the data-gravity path onto Harper and the most recoverable.

The MVP already has most of the primitives: an append-only event ledger with **deterministic event ids** (so consumers can dedupe), opaque keyset cursors (`encodeCursor`/`decodeCursor` in `src/api/apiContract.ts`), and bounded pagination. A replay-safe feed is a modest extension rather than a new subsystem: a durable per-consumer cursor, at-least-once delivery, and a replay session that re-serves a bounded scoped range without disturbing the live cursor.

**The genuinely new piece is authentication.** A feed consumer is a machine, not a merchant in an embedded admin, so the Shopify session-token path in `src/auth/identity.ts` does not apply. Recover needs a second, small identity plane: per-shop API credentials, minted from inside the embedded app (which proves the merchant authorized them), revocable, and never granting cross-shop access. This is a smaller instance of the problem the Cluster tier faces at full scale — see [cluster-tier-design.md](./cluster-tier-design.md) §2.1 — and the two should share one design rather than growing two auth planes.

### 2.6 Recovery artifacts

Where a vendor has a bulk import or manual resync surface, generate the exact validated input file from ledger data.

`src/api/csv.ts` (`collectExportRows`, `toCsv`, `MAX_EXPORT_ROWS = 5000`) is the foundation, but an artifact is not an export: it is a *vendor-specific schema* with vendor-specific validation, and it must be right or the merchant's import fails. Design as a small generator registry — vendor key → column mapping + validators + a fixture-backed test per vendor — reusing the existing bounded row collection. Add one generator per funded vendor; do not build a speculative catalog.

Note the row cap interacts with real incident sizes: the brief's own example is 742 orders, comfortably inside 5000, but an inventory-driven incident could exceed it. Artifacts need an explicit, visible truncation contract like the export already has, or a higher cap justified against memory.

### 2.7 Connectors + correlation

Read-only pull connectors ingest foreign ledgers (3PL, ERP, marketplace) so an *inferred* gap becomes a *confirmed* one. Selection is governed by the brief's echo-back test: systems that already write their outcomes back into Shopify add little and are declined honestly.

Correlation has a consequence the MVP's discipline makes visible. The [screen spec](./free_mvp_screen_spec.md) §4 disclaimer must render verbatim on unconfirmed findings, and `test/view.test.ts` pins it as "the product-truth guardrail for the whole app."

Helpfully, the guardrail is already state-dependent rather than universal: the same test file asserts that resolved and suppressed findings **omit** the disclaimer "whose wording would be false," and that a failed-attempt finding never carries it because absence is not what is being reported. So a connector-confirmed finding is a new case in an existing pattern, not a violation of it — the work is to author the confirmed wording and pin it the same way.

That wording needs agreeing before the first connector ships, because a confirmed claim about a named third party ("order paid 10:04, never arrived in ShipHero") is a far stronger assertion than anything the free tier makes, and the vendor may disagree with it.

New table: `ForeignEvent` (connector-ingested, shop-scoped, retention-bound like the rest).

## 3. Data model additions

| Table / field | Purpose |
|---|---|
| `Shop.capabilityProfile`, subscription fields | entitlement, read by `capabilitiesFor` |
| `expiresAt` on ledger rows | per-shop retention with a single purge sweep (§2.2) |
| `ReplayPlan` / `ReplayLine` / `ReplayExecution` | propose → approve → execute, with idempotency keys |
| `FeedConsumer` / `FeedCursor` | durable re-serve cursors |
| `ApiCredential` | machine auth for the feed (§2.5) |
| `ForeignEvent` | connector-ingested foreign ledger rows |

`AuditEvents` already exists and needs no change.

Every new table is shop-scoped and must join the retention, redaction, and data-inventory maps at creation, not afterwards — `src/retention/ledgerTargets.ts` holds `RETENTION_TARGETS` and `REDACT_TARGETS`, and a table absent from them is a compliance hole.

## 4. What must not regress

- **Never inline.** Re-announcement is an Admin write initiated by an operator, not a step in anyone's delivery path. If Sightline disappears, the store still notices nothing.
- **Cannot fabricate.** No fulfillment for a shipment that never happened.
- **Tenant isolation.** Every query keeps deriving `shopId` from the verified principal. `crossTenant.test.ts` must gain cases for every new surface, especially the feed (a machine credential is a new way to get the tenant wrong).
- **Deletion still real.** ADR-003's DELETE-and-verify holds at 90 days, and redaction must be shown to converge over a much larger row count.
- **Product truth.** No confirmed-failure claim without correlation evidence.

## 5. Open questions

1. Gate 1 outcome, and whether "re-evaluates safely" is added to its criteria (§2.4).
2. Per-topic retention inside Recover — does inventory get 90 days, or less? (§2.2)
3. Downgrade deletion: policy language and merchant warning, agreed before ship (§2.1).
4. Carrier field: tag vs metafield, per vendor, and the reserved namespace (§2.4).
5. Storage and cost model at 90 days, against Gate 2's observed event volumes.
6. Whether longer retention plus a write scope triggers PCD re-review.
7. Confirmed-finding wording, before the first connector (§2.7).
8. One auth plane shared with Cluster, or two (§2.5).

## 6. Branch B: what Recover is if Gate 1 fails

If the pulse does not re-trigger vendors broadly, delete §2.4 and the tier still stands on:

- 90-day retention (§2.2) — the single most mechanical, most certain piece of value
- feed + replay sessions (§2.5) — full recovery for anything built on Sightline
- recovery artifacts (§2.6) — the drag-and-drop path for everything else
- connectors + correlation (§2.7) — inferred gaps become confirmed ones

What is lost is the *one-button bulk fix for vendor lanes*, which is the strongest line in the pitch. The tier becomes "we remember longer, we can prove what broke, and we hand you exactly the file or feed you need" — defensible, and a materially weaker upgrade prompt. Pricing should be revisited in that world rather than assumed.

The planner (§2.3) survives in both branches; it simply has fewer mechanisms to choose between.

## 7. Sequencing, and what is safe to build before the gates

**Blocked on Gate 1:** the re-announcement executor (§2.4) and the write-scope request. Nothing else.

**Blocked on Gate 2 / funding:** the decision to build the tier at all. Gate 2's thresholds are pre-registered in [gate2-pilot-design.md](./gate2-pilot-design.md) §7 and explicitly not renegotiable after seeing data; an ambiguous result must be reported as underpowered rather than forced.

**Gate-independent, and needed in both branches:**

| Work | Why it is safe now |
|---|---|
| Per-shop retention model (§2.2) | Identical in both branches; the riskiest piece; touches contract, policy, and data-inventory, so the long lead time is real |
| Entitlement + billing (§2.1) | Needed to sell anything; the `capabilities.ts` seam already exists |
| Feed + auth plane (§2.5) | Branch B's core, Branch A's best lane, and shared with Cluster |
| Artifact generators (§2.6) | Branch B's core; incremental per funded vendor |

The honest recommendation: **Gate 1 first, because it is an afternoon and it decides the tier's shape.** It is currently untracked, which makes it the cheapest available reduction in uncertainty about a whole phase of work. Nothing in §2 should start before it has an owner and a date.
