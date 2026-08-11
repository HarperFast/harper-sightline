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

- `config.yaml` — component config (rest, graphqlSchema, jsResource; static web/dist later).
- `resources.ts` — export layer for `src/resources/*`; nothing else belongs here.
- `src/resources/` — one file per resource class, named after the class it exports
  (`health.ts` → `Health`, `eventsResource.ts` → `EventsResource`, …), plus four
  shared modules: `boot.ts` (log sink + raw-JSON content type + job loop; imported
  FIRST by `resources.ts`), `auth.ts` (the shared identity adapter, `API_KEY`,
  `sessionPayload`), `tables.ts` (the read-only `QueryTable` casts), and `http.ts`
  (`parseUrl`/`trailingId`/`numParam`/`httpError` — no `harper` import, so unit-testable).
- `src/` — `verifySessionToken.ts` (+ tests), `AuthError.ts`, `readSecret.ts`, `principal.ts`.
- `web/` — Vite/App Bridge/Polaris SPA (slice 2).
- `scripts/` — `deploy.mjs`, `smoke.mjs`.
- `schema.graphql` — placeholder; real sealed tables in issue #6.

## Standards

TypeStrip TS (`.ts` imports, named exports, tabs, semicolons, `node:` prefix).
`format:write` (prettier), `lint:required` (oxlint), `typecheck` (tsc), `test`
(node --test). See /docs and the ADRs for the decisions this app must honor.

## Observability (#22)

`src/observe.ts` is the single observability primitive: a PII-safe structured
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
- **Ops health**: `src/opsHealth.ts` `computeOpsHealth` derives an aggregate,
  merchant-label-free health view from tables (backlog age/count, dead letters,
  reconciliation staleness, reauth). `jobs.ts` runs it once a minute as the
  `ops.snapshot` heartbeat (emitted at `warn` when unhealthy so alerts can key
  off it). This is distinct from the per-shop merchant-facing `getSummary`.
- **Runbooks**: `/docs/runbooks/` — one per alert condition, with an
  alert→runbook→owner map in its README. Alert conditions name the exact
  metric/`ops.snapshot` field to watch.

## Known environment note

Harper native secrets custody can desync on the Fabric instance ("custody not
initialized on this node"), which blocks the live valid-token path (500). Fix is
Fabric-side (re-init custody + re-`set_secret`); code and unit tests are
unaffected.
