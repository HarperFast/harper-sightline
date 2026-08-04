# Phase 0 — Risk Retirement (Design / Execution Spec)

Date: 2026-08-04
Status: draft, awaiting review
Owner: Josh (implementer: Claude, review at checkpoints)
GitHub issues: [#2](https://github.com/HarperFast/harper-sightline/issues/2) (auth + worker + retention), [#3](https://github.com/HarperFast/harper-sightline/issues/3) (pin Shopify contract)
Source of truth: [Development plan §15 Phase 0](../../free_mvp_development_plan.md), [Issue backlog M0](../../free_mvp_issue_backlog.md)

## 1. Why this phase exists

Phase 0 retires the four assumptions that, if false, invalidate the Sightline architecture **before** any feature code (the scaffold, issue #4) depends on them. Its output is **runnable spikes + decision records**, not product code. Per the plan and README, the scaffold does not start until this phase's exit criteria are met.

The spikes are **throwaway learning artifacts**. They live under `spikes/` — committed to the repo as evidence but excluded from the eventual app's build/deploy — and are *not* carried into the production scaffold verbatim. What carries forward is the ADRs and the pinned contract.

## 2. Confirmed environment (verified 2026-08-04)

| Fact | Value |
|---|---|
| Harper instance | `ayoo.josh-test.harperfabric.com:9925` (Fabric-hosted container), operations API reachable with basic auth |
| Harper version | **5.2.0** (Harper v5 — assumption holds; upgraded from 5.1.19 on 2026-08-04) |
| Harper runtime Node | **24.18.0** server-side (the app runs on Harper's bundled Node, not local Node) |
| Instance state | Empty — `describe_all` → `{}` |
| Local tooling | Shopify CLI 4.6.0, Harper CLI present, local Node **24.18.0** (aligned to server via nvm), npm 10.9.2 |
| Shopify app | client_id `e446bda5edb3ee3bae6e0ba280ef8b12` (embedded app, dev store available) |
| Secrets handling | Shopify app secret stored in **Harper native secrets** (`set_secret`, scoped grant to `sightline`/`sightline-spike-auth`); Harper connection creds in gitignored local config; rotate before any non-dev use |

Resolved 2026-08-04: local Node aligned to **24.18.0** via nvm, matching the Harper 5.2.0 server-side runtime. No outstanding version-alignment risk.

## 3. The four spikes

Each spike states its **risk** (what we fear), **build** (throwaway artifact), **proof** (how we know), and **output** (decision record). Spikes A–C are issue #2; Spike D is issue #3.

### Spike A — Shopify embedded auth on Harper (highest risk)
- **Risk:** Shopify's embedded session-token + token-exchange flow does not map cleanly onto Harper v5 custom resources, breaking the entire auth model.
- **Build:** a minimal Harper custom resource that (1) verifies a real App Bridge session JWT and (2) exchanges it via Shopify token exchange for an expiring **offline** access token, plus a refresh path.
- **Proof:**
  - Positive: a live session JWT from the dev store verifies (secret read from Harper native secrets, not a literal) and yields a principal `{ shopId, userId, roles, source }`.
  - Negative tests reject: bad signature, wrong `alg`, wrong `aud`, wrong destination/shop, wrong `iss`, `nbf` in future, expired.
  - Token exchange returns an offline token; **refresh rotation is atomic** under concurrent refresh (no torn/duplicated credential; loser observes the winner's new token).
  - Decide whether `@harperfast/oauth` has a supported Shopify embedded provider; document why it is / isn't on the request path.
- **Output:** `docs/adr/ADR-001-authentication.md`.

### Spike B — Durable worker recovery & single-active ownership
- **Risk:** Harper background processing loses accepted-but-unprocessed work on restart, or double-processes under multiple/clustered workers.
- **Build:** a throwaway durable-table + subscription pipeline with a lease/checkpoint record; a producer that writes N items, a worker that processes them, and a kill/restart harness.
- **Proof:**
  - After killing the worker mid-run and restarting, all accepted-but-unprocessed items are eventually processed exactly once (idempotent, deterministic IDs).
  - Two workers running concurrently do not both process the same item (lease enforces single-active ownership).
  - Confirm the current Harper v5.2.0 recommended scheduling/leader pattern (bounded platform check — no external queue).
- **Output:** `docs/adr/ADR-002-worker-lease-scheduling.md`.

### Spike C — Retention: physical deletion of indexed + protected data
- **Risk:** Harper TTL/eviction reports records as expired but does not *physically* delete indexed rows / protected fields, failing the 7-day compliance promise.
- **Build:** a throwaway table with a short TTL, indexed fields, and a "protected-like" field; a time-controlled test that writes, expires, and then probes storage/index for residue.
- **Proof:**
  - After expiry, records are unavailable via query **and** removed from indexes and physical storage — or, if not, we document that an **explicit purge job** is required and prototype it.
  - Decide: TTL-only vs. TTL + explicit observable purge.
- **Output:** `docs/adr/ADR-003-retention-deletion.md`.

### Spike D — Pin the Shopify API contract (research, no Harper dependency)
- **Risk:** Building normalization/scopes against an unpinned or wrong API version forces rework and risks App Store review (protected data).
- **Build:** a contract document, not code. Validated against the dev store where cheap.
- **Proof / deliverables:**
  - Select and record the stable GraphQL Admin API version.
  - Exact app-specific webhook topics, `include_fields`, and minimum **read** scopes for orders, fulfillments, inventory, refunds, uninstall, and compliance.
  - Demonstrate no Level 2 customer-identifying fields are required; document Level 1 protected-data review inputs and per-field justification.
  - Confirm default order-access window is sufficient; do **not** request `read_all_orders`.
- **Output:** `docs/shopify-contract.md`.

## 4. Sequencing

```
A (auth)  ─┐
           ├─▶ B (worker) ─▶ C (retention) ─▶ Threat model draft ─▶ Phase 0 exit
D (contract)┘   (parallelizable research runs alongside A)
```

- **A + D first:** A is the single highest architecture-invalidating risk and is Shopify-specific; D is non-code research with no Harper dependency, so it runs alongside A at no critical-path cost.
- **Then B, then C:** both are Harper-platform spikes independent of Shopify; sequenced to keep review checkpoints clean.
- **Threat model** drafted last, once auth/worker/retention shapes are known (feeds the eventual security review, issue #23).

Rejected alternative: strict plan order A→B→C→D. Cleaner narrative but delays retiring the top risk and wastes D's free parallelism.

## 5. Review checkpoints (matches "review at checkpoints")

One PR / checkpoint per output:
1. ADR-001 authentication (+ Spike A code)
2. `docs/shopify-contract.md` (Spike D)
3. ADR-002 worker/lease (+ Spike B code)
4. ADR-003 retention (+ Spike C code)
5. Threat model draft + Phase 0 exit summary

## 6. Phase 0 definition of done (exit criteria)

From plan §15: *"runnable spikes prove the auth, durable acceptance, worker recovery, and purge assumptions."*

- [ ] Spike A proves session-JWT verification (with negative cases) and atomic offline-token rotation on Harper v5.2.0.
- [ ] `@harperfast/oauth` Shopify-provider question answered and recorded.
- [ ] Spike B proves restart recovery and single-active ownership under multiple workers.
- [ ] Spike C proves physical deletion, or specifies the explicit purge job required.
- [ ] Spike D pins API version, topics, fields, scopes, and protected-data request.
- [ ] ADR-001, ADR-002, ADR-003 written; `docs/shopify-contract.md` written; threat model drafted.
- [x] Local dev Node/Harper version alignment resolved (Node 24.18.0, Harper 5.2.0).

Only then does issue #4 (scaffold) begin.

## 7. Explicitly NOT in Phase 0

- No production scaffold, real sealed schemas, or app tables (that's issue #4+).
- No feature code (ingress, normalization, detector, UI).
- No billing, recovery, connectors, or any write scope.
- Spike code is throwaway evidence, not the app.
