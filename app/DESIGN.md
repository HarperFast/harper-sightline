# Sightline — Application DESIGN

Harper v5 native, embedded Shopify Admin app. Read-only "Record" MVP. This file
is the fast-start map for anyone (human or agent) working in `app/`.

## Runtime shape (from Phase 0 spikes — see /docs/adr)

- Deployed to Harper Fabric as component **`sightline`** via `scripts/deploy.mjs`
  (ops-API `deploy_component` + `restart`), URL fronted on 443. No local Harper
  (blocked in our sandbox); the Fabric instance is the runtime.
- **Resources** live one-per-file in `src/resources/`, extend `Resource` from
  `'harper'`, are deny-by-default (`allowRead()` to open a GET), and route at their
  `static path` (e.g. `/api/v1/health`). `resources.ts` (the `jsResource` entry
  point) is an **export layer only** — no logic — and Harper registers whatever
  `Resource` subclass it exports. A bad top-level import silently 404s _all_ routes
  while the component still reports "healthy" → `scripts/smoke.mjs` runs after every
  deploy as a guard (ADR-001).
- **Auth:** the Shopify session token rides in `X-Shopify-Session-Token`, NOT
  `Authorization` (Harper's HTTP layer intercepts Authorization). `Session`
  verifies it (HS256, ADR-001) and returns the tenant identity.
- **Secrets:** the app secret is read from Harper native secrets via a lazy
  `import('harper').secrets` (encrypted, never logged). Grant matching is keyed on
  package.json `name` — the component must be named `sightline`.

## Layout

- `config.yaml` — component config (rest, graphqlSchema, jsResource). No static plugin: the
  SPA is served by the `AppHome` resource so the HTML can carry a `frame-ancestors` CSP.
- `resources.ts` — export layer for `src/resources/*`; nothing else belongs here.
- `src/resources/` — one file per resource class, named after the class it exports
  (`health.ts` → `Health`, `eventsResource.ts` → `EventsResource`, …), plus six
  shared modules: `boot.ts` (log sink + raw-JSON content type + job loop; imported
  FIRST by `resources.ts`), `auth.ts` (the shared identity adapter, `API_KEY`,
  `sessionPayload`), `tables.ts` (the read-only `QueryTable` casts), `http.ts`
  (`parseUrl`/`trailingId`/`numParam`/`httpError` — no `harper` import, so unit-testable),
  `assetPath.ts` (`resolveAssetUrl`, the containment boundary for the
  unauthenticated static-asset read in `appHome.ts` — same no-`harper` rule, and it
  is security-load-bearing, so it stays directly testable), and `frameAncestors.ts`
  (who may iframe the app — same rule, same reason).
- `src/*/` — the rest of the app, grouped by concern. A module's directory tells you
  what it is for; nothing else about the code changed when they were grouped.
  - `auth/` — who the caller is, and how much they may ask for: `verifySessionToken.ts`,
    `identity.ts`, `principal.ts`, `AuthError.ts`, `tenant.ts` (the shopId scoping
    control), `capabilities.ts`, `opsAuth.ts` (the `SIGHTLINE_OPS_TOKEN` gate — an
    operator, not a merchant), `shopDomain.ts` (what a shop domain may look like before
    it reaches a response header), `rateLimit.ts` (the per-shop request/export limits,
    enforced inside `identity.authenticate()` so no resource can forget them).
  - `secrets/` — secret material: `crypto.ts` (token envelope encryption),
    `readSecret.ts`, `secretsPolicy.ts` (required secrets fail closed; there is no flag and no fallback).
  - `shopify/` — everything that talks to Shopify or holds a Shopify credential:
    `adminApi.ts`, `exchangeToken.ts`, `accessToken.ts`, `tokenDeps.ts`,
    `credentialStore.ts`, `rotateCredential.ts`, `lifecycle.ts` (install/uninstall),
    `webhookHmac.ts`, `reconcile.ts`, `reconcileSweep.ts` (the deps-injected order paging).
  - `ingest/` — the write path from a delivery to stored state: `webhookIngress.ts`,
    `webhookShop.ts` (binds the header shop to the signed body or a known shop), `processor.ts`, `normalize.ts`,
    `eventSkus.ts`, `projection.ts`, `orderRefresh.ts` (the guarded projection write, shared by ingest and
    reconcile), `inventoryEnrich.ts`.
  - `domain/` — the shared vocabulary the rest reads: `model.ts` (the schema.graphql
    mirror), `orders.ts` (the single lane/age definition), `eventKind.ts`, `detector.ts`.
  - `api/` — the read side: `apiContract.ts` (response allowlists), `queries.ts`, `csv.ts`.
  - `digest/` — `digest.ts` (pure domain), `digestData.ts`, `digestBuild.ts`
    (deps-injected orchestration), `digestSubscription.ts`.
  - `privacy/` — `compliance.ts` (mandatory-webhook dispatcher), `redaction.ts`,
    `pii.ts`, `privacyPolicy.ts`, `support.ts`.
  - `retention/` — `retention.ts`, `ledgerTargets.ts`, `purgeCycle.ts`.
  - `observability/` — `observe.ts`, `harperLogSink.ts`, `opsHealth.ts`.
  - `jobs/` — what `jobs.ts` runs on: `tick.ts` (the non-wedging loop guard),
    `stateBackfill.ts`, `detectorSweep.ts` (deadline-indexed expectation sweep).
- `src/*.ts` — only the base layer everything sits on: `db.ts` (the table handles),
  `audit.ts` (a thin writer over them), and `harperRuntime.ts`. **`harperRuntime.ts`
  must stay at `src/` root** — it is the `default` target of the `#harper` subpath
  import in package.json, and that resolution is load-bearing (see its header).
- `web/` — the Vite/App Bridge/Polaris SPA. `web/src/view.ts` holds every screen as a
  PURE function from data to markup and `web/src/main.ts` only fetches, writes
  innerHTML, binds listeners, and routes — which is what makes the UI testable in
  plain node with no browser or DOM shim (`test/view.test.ts`). Keep that split: markup
  decisions that migrate into `main.ts` become untestable.
- `scripts/` — `deploy.mjs` (build → package → deploy → restart EVERY node → verify the
  served bundle), `smoke.mjs` (post-deploy route/auth checks), `loadtest.mjs`,
  `seed-dev-data.mjs`, `gen-contract.mjs`.
- `schema.graphql` — the sealed tables, split across two databases: `sightline_core`
  (shop, credential, audit, digest subscription/outbox) and `sightline_ledger`
  (deliveries, events, projections, expectations, findings, aggregates, checkpoints,
  and the SKU/inventory/location indexes). `src/domain/model.ts` mirrors it in
  TypeScript; the two must move together.

## Standards

`jobs.ts` and `resources.ts` import the Harper runtime, so nothing in them is
unit-testable. Every background sweep therefore keeps its logic in a
deps-injected `src/` module — `processor.ts`, `inventoryEnrich.ts`,
`stateBackfill.ts`, `purgeCycle.ts`, `shopify/reconcileSweep.ts` — and `jobs.ts` wires
the real tables, Admin API calls, and tickers. When a sweep needs a behavior
guarantee tested (retry, convergence, idempotency), move the loop into `src/`
rather than testing around it.

TypeStrip TS (`.ts` imports, named exports, tabs, semicolons, `node:` prefix).
`format:write` (prettier), `lint:required` (oxlint), `typecheck` (tsc), `test`
(node --test). See /docs and the ADRs for the decisions this app must honor.

## Background jobs, projection and ingress (details of what the code does)

- **Scheduling.** All eight sweeps are Harper scheduler jobs (`config.yaml`
  `scheduler:`, `*Job` exports in `jobs.ts`); each occurrence runs on the elected
  leader, once. Delivery processing is `sightline-process`, every 10s: `drainAccepted`
  reads 50 `accepted` rows per batch until the backlog is empty, 8s
  (`PROCESS_BUDGET_MS`) are spent, or a batch's worth of rows has failed, so an
  outage cannot burn `MAX_ATTEMPTS` on the whole backlog in one occurrence.
  Partitioning (`partitionOf`, the `partition` option) is **not wired** and stays at
  one slot: the scheduler gives one executor per occurrence, and two leaders in a
  partition have no way to learn distinct slots, so idempotency covers that window.
  More slots would also amplify reads, not scale: the filter runs in the application
  and each batch re-reads every foreign-slot row (simulated, not measured live:
  about 397 rows read per row processed at 2 slots and 1,197 at 4, with a 40,000-row
  backlog).
- **Failover tradeoff.** The scheduler lease has no compare-and-set. A leader loss
  pauses every job for roughly 5-6.5 minutes per Harper v5.3.3 source (lease stale after 5 min, follower
  checks every 75s, further nodes in line wait 150s more). Ingest still acks and
  stores durably; the backlog drains on the new leader. That gap exceeds
  `BACKLOG_STALE_MS` (5 min), so `ops.snapshot` reports a stale backlog until it
  drains. That is deliberate, not a bug: the oldest delivery really is that old.
- **Projection guard.** A rebuild re-derives an order's projection from all of its
  events, so two concurrent rebuilds can write an older view over a newer one.
  `OrderProjection.eventCount` (order-linked events folded) lets
  `updateOrderProjection` skip the write when the stored count exceeds the rebuilt
  count (`projection.stale_skipped`). Limits, stated plainly: it narrows the race
  but is not atomic (read-then-put, no compare-and-set); it assumes a read sees all
  prior writes; and it applies only while the stored row's `firstEventAt` (earliest
  event `receivedAt`) is within 6 days of now, because the 7-day purge can legitimately
  shrink a rebuild's event count, and reconcile stamps `receivedAt = occurredAt`, so a
  late fulfilment of an old order keeps last-writer-wins. `firstEventAt` and
  `eventCount` are two new `@sealed` columns: after deploying, confirm both with
  `describe_table` on `sightline_ledger.OrderProjection`.
- **Credential rotation and reconcile.** Reconcile isolates failures per shop: one
  shop's throw is logged (`reconcile.shop.error`) and counted, and the sweep goes on.
  `rotateCredential` is single-flight per shop within a worker; across threads and
  nodes a concurrent loser holds a spent refresh token, so on failure it re-reads the
  credential version and treats a higher one as success. Only a 400 or 401 from Shopify (a
  rejected refresh grant) parks the shop (`reauthorization_required`), and only after a 1s settle delay and a final
  version re-read; timeouts, network errors and 5xx rethrow and never park.
- **Inventory enrichment frontier.** The per-shop `enrich:<shopId>` cursor is
  capped at the `receivedAt` of the shop's oldest delivery still `accepted`, so
  events not yet written cannot be skipped. Two residual gaps are accepted: an event
  that becomes visible on the leader late by replication, for an item never seen
  before, is not indexed until its item is cached (an item already cached is indexed
  at write time); and a milliseconds-wide window between stamping `receivedAt` at
  ingress and the delivery committing. The recommended follow-up is an indexed
  processing-time column to key the frontier on instead of `receivedAt`.
- **Webhook shop binding.** The HMAC covers only the body, so `checkWebhookShop`
  runs after it and before storage: the header must be a well-formed
  `*.myshopify.com`, any `myshopify_domain`/`shop_domain` in the body must equal it,
  `app/uninstalled`, `shop/redact`, `customers/redact` and `customers/data_request`
  must carry their own topic's shape, and the event endpoint requires a known `Shop` row
  (404 otherwise, so Shopify retries). Not closed: replay of the same topic under a
  fresh webhook id, and `orders/*` or `inventory/*` bodies replayed under another known
  shop's header (those bodies carry no shop identity). Recommended follow-up: a global
  `sha256(rawBody)` dedupe in a new table.
- **Deploy heal.** `scripts/deploy.mjs` derives its expected-column list from
  `schema.graphql` (`scripts/schemaColumns.mjs`), so a new column is healed without a
  second list to keep in sync.

## Observability (#22)

`src/observability/observe.ts` is the single observability primitive: a PII-safe structured
logger and an in-process metrics registry. There is **no external metrics
backend** in the MVP — metrics are a cumulative in-process tally emitted as
`ops.snapshot` log lines (see below); the staging log pipeline turns them into
dashboards/alerts under #25.

- **Logging**: `log(level, event, fields)` writes one line
  `[sightline] {"level","event",...}`. Every field passes through
  `redactFields`, which masks sensitive keys (token/HMAC/secret/payload/PII) and
  caps long strings, so a careless caller cannot leak a token or raw payload.
  `trace` is the default level; top-level handlers log an error once.
  The sink is swappable (`setLogSink`) for tests / a Harper-logger adapter.
- **Metrics**: the `metrics` registry (`inc`, `observeMs`, `snapshot`) keyed by
  the `M` name constants. **No merchant-identifying labels** — a metric is a bare
  name, never keyed by shop (plan §13).
- **Ops health**: `src/observability/opsHealth.ts` `computeOpsHealth` derives an aggregate,
  merchant-label-free health view from tables (backlog age/count, dead letters,
  reconciliation staleness, reauth). `jobs.ts` runs it once a minute as the
  `ops.snapshot` heartbeat (emitted at `warn` when unhealthy so alerts can key
  off it). This is distinct from the per-shop merchant-facing `getSummary`.
  The same object is served over HTTP at `/api/v1/ops`, gated by
  `src/auth/opsAuth.ts` on the `SIGHTLINE_OPS_TOKEN` shared secret and 404-ing when
  unset. Prefer it over log scraping for anything programmatic: it reads
  replicated tables, so any node answers for the whole cluster, whereas
  `read_log` only ever sees the node that happened to serve the request.
  `scripts/loadtest.mjs` uses it to prove a burst drained.
- **Runbooks**: `/docs/runbooks/` — one per alert condition, with an
  alert→runbook→owner map in its README. Alert conditions name the exact
  metric/`ops.snapshot` field to watch.

## Known environment note

Harper native secrets custody can desync on the Fabric instance ("custody not
initialized on this node"). Required secrets fail closed: there is no flag and no
fallback, and a missing or undecryptable secret stops the component loading. With
custody uninitialised the instance cannot serve until Fabric re-inits custody (and
`set_secret` is re-run) or the values are provided as environment variables. Code
and unit tests are unaffected.
