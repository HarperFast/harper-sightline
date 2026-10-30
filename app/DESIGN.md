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
    `webhookShop.ts` (binds the header shop to the signed body or a known shop), `processor.ts`,
    `deliveryHandler.ts` (the drain's unit of work: one delivery to its event, SKU rows and projection),
    `normalize.ts`, `eventSkus.ts`, `projection.ts`, `orderRefresh.ts` (the guarded projection write, shared
    by ingest and reconcile), `inventoryEnrich.ts`.
  - `domain/` — the shared vocabulary the rest reads: `model.ts` (the schema.graphql
    mirror), `orders.ts` (the single lane/age definition), `eventKind.ts`, `detector.ts`.
  - `api/` — the read side: `apiContract.ts` (response allowlists), `queries.ts`, `csv.ts`,
    `readCache.ts` (the per-shop single-flight cache for the summary, flows and privacy scans),
    `exportGate.ts` (one CSV export in flight per node, via a lease shared across threads).
  - `digest/` — `digest.ts` (pure domain), `digestData.ts`, `digestBuild.ts`
    (deps-injected orchestration), `digestSubscription.ts`.
  - `privacy/` — `compliance.ts` (mandatory-webhook dispatcher), `redaction.ts`,
    `tombstone.ts` (redaction tombstones, so a delivery still queued cannot write a redacted
    order or shop back), `pii.ts`, `privacyPolicy.ts`, `support.ts`.
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
  works until the backlog is empty, 8s (`PROCESS_BUDGET_MS`) are spent, or 50 rows
  have failed, so an outage cannot burn `MAX_ATTEMPTS` on the whole backlog in one
  occurrence.
- **Drain order.** Round-robin across shops, oldest first within a shop; there is no
  global FIFO, and none is needed (ADR-002: processing is order-independent). The
  drain reads the computed `WebhookDelivery.pendingKey` index (shop, receivedAt, id),
  which holds only `accepted` rows. A lap walks it once: each shop starts at most
  `SHOP_SLICE` (250) of its oldest rows, then the cursor seeks past that shop, so a
  big shop's backlog cannot hold back a small one. The cursor, with what is left of
  the current shop's turn, carries across occurrences on the leader, so a lap longer
  than one budget resumes at the next shop. A read never asks for more than the current shop's remaining turn. A read
  from the start of a lap still steps over the deleted index entries of rows
  processed since the last compaction (1.7 ms at 30,000, live), which is why a turn
  is 250 rows: at 25 a lone big shop lost about 25% of its drain rate.
- **Partitioning** (`partitionOf`, the `partition` option) is by shop and **not
  wired**: it stays at one slot. The scheduler gives one executor per occurrence,
  and two leaders in a partition have no way to learn distinct slots, so idempotency
  covers that window. A foreign-slot shop costs one seek per lap, not a re-read, but
  nothing assigns slots yet.
- **Failover tradeoff.** The scheduler lease has no compare-and-set. A leader loss
  pauses every job for roughly 4-6.25 minutes per Harper v5.3.3 source (heartbeat
  every 60s, lease stale after 5 min, follower checks every 75s, further nodes in
  line wait 150s more). Ingest still acks and
  stores durably; the backlog drains on the new leader. That gap can exceed
  `BACKLOG_STALE_MS` (5 min), so `ops.snapshot` then reports a stale backlog until it
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

## Measured costs (local Harper 5.3.3, laptop)

The figures behind several limits in the code, which point here rather than carry
them. A big shop is 160k events (and as many deliveries) in the window.

- **CSV export** (`csv.ts`, `exportGate.ts`): about 50 pages of 100 rows, 7-13 s of
  CPU on a big shop. Without a yield between pages that was one turn of the event
  loop, so every webhook ack on the thread waited past Shopify's 5 s; two exports at
  once doubled that wait. `EXPORT_LEASE_MS` (120 s) is about ten times the slowest.
- **Per-shop scans** (`readCache.ts`): a summary took 1.3 s at 163k events and
  saturated near 2 req/s. The privacy screen's delivery pass is about 1.0 s at 160k
  deliveries; its exact count alone costs the same (2.6 s by an id-prefix range), and
  splitting it into indexed counts plus a newest-first read was about 1.1 s.
- **Lookups by resourceId** (`queries.ts`, `orderRefresh.ts`): with `shopId` in the
  `and`, 12-14 ms at 160k events, against 0.4 ms on resourceId alone.
- **EventSku writes** (`eventSkus.ts`): a 100-SKU order drained at 159-170/s with its
  index rows written one after another, 221-238/s concurrently.
- **Redaction checks in the drain** (`deliveryHandler.ts`): the tombstone reads cost
  about 1 µs per key read (2-2.75 µs for an order's two), against about 350 µs to
  drain a 1-SKU delivery. A 60k 1-SKU backlog drained at 2,756-2,846/s with the checks
  and the patches that carry `id`/`shopId`/`receivedAt`, against 2,687-2,857/s before
  either (98970ef), three runs each. Clearing the body when a delivery is marked
  processed did not move it either: 2,706-2,848/s against 2,604-2,819/s, two runs each.
- **Ops health** (`opsHealth.ts`): reading every row of a 57k backlog cost about
  0.5 s per call. The capped stale-row query returns in 5 ms at a 60k stale backlog
  and takes about 1 s when none of 60k is stale.

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
  reconciliation staleness, reauth, and rows left past their retention window by more
  than `RETENTION_OVERDUE_MS`). Dead letters, a stale backlog or reconcile, and overdue
  rows turn `healthy` false; reauth does not. `jobs.ts` runs it once a minute as the
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
