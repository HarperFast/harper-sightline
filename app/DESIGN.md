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
    `readSecret.ts`, `secretsPolicy.ts` (the fail-closed `SIGHTLINE_REQUIRE_SECRETS` gate).
  - `shopify/` — everything that talks to Shopify or holds a Shopify credential:
    `adminApi.ts`, `exchangeToken.ts`, `accessToken.ts`, `tokenDeps.ts`,
    `credentialStore.ts`, `rotateCredential.ts`, `lifecycle.ts` (install/uninstall),
    `webhookHmac.ts`, `reconcile.ts`, `reconcileSweep.ts` (the deps-injected order paging).
  - `ingest/` — the write path from a delivery to stored state: `webhookIngress.ts`,
    `processor.ts`, `normalize.ts`, `eventSkus.ts`, `projection.ts`, `inventoryEnrich.ts`.
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
    `stateBackfill.ts`.
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
initialized on this node"), which blocks the live valid-token path (500). Fix is
Fabric-side (re-init custody + re-`set_secret`); code and unit tests are
unaffected.
