# Sightline — Application DESIGN

Harper v5 native, embedded Shopify Admin app. Read-only "Record" MVP. This file
is the fast-start map for anyone (human or agent) working in `app/`.

## Runtime shape (from Phase 0 spikes — see /docs/adr)

- Deployed to Harper Fabric as component **`sightline`** via `scripts/deploy.mjs`
  (ops-API `deploy_component` + `restart`), URL fronted on 443. No local Harper
  (blocked in our sandbox); the Fabric instance is the runtime.
- **Resources** (`resources.ts`) extend `Resource` from `'harper'`, are
  deny-by-default (`allowRead()` to open a GET), and route at their `static path`
  (e.g. `/api/v1/health`). A bad top-level import silently 404s *all* routes while
  the component still reports "healthy" → `scripts/smoke.mjs` runs after every
  deploy as a guard (ADR-001).
- **Auth:** the Shopify session token rides in `X-Shopify-Session-Token`, NOT
  `Authorization` (Harper's HTTP layer intercepts Authorization). `Session`
  verifies it (HS256, ADR-001) and returns the tenant identity.
- **Secrets:** the app secret is read from Harper native secrets via a lazy
  `import('harper').secrets` (encrypted, never logged). Grant matching is keyed on
  package.json `name` — the component must be named `sightline`.

## Layout

- `config.yaml` — component config (rest, graphqlSchema, jsResource; static web/dist later).
- `resources.ts` — `Health` (`/api/v1/health`) and `Session` (`/api/v1/session`).
- `src/` — `verifySessionToken.ts` (+ tests), `AuthError.ts`, `readSecret.ts`, `principal.ts`.
- `web/` — Vite/App Bridge/Polaris SPA (slice 2).
- `scripts/` — `deploy.mjs`, `smoke.mjs`.
- `schema.graphql` — placeholder; real sealed tables in issue #6.

## Standards

TypeStrip TS (`.ts` imports, named exports, tabs, semicolons, `node:` prefix).
`format:write` (prettier), `lint:required` (oxlint), `typecheck` (tsc), `test`
(node --test). See /docs and the ADRs for the decisions this app must honor.

## Known environment note

Harper native secrets custody can desync on the Fabric instance ("custody not
initialized on this node"), which blocks the live valid-token path (500). Fix is
Fabric-side (re-init custody + re-`set_secret`); code and unit tests are
unaffected.
