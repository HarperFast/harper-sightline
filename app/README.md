# Sightline app

Harper v5 native, embedded Shopify Admin application (the read-only "Record" MVP).

- [`DESIGN.md`](./DESIGN.md) — the module-by-module map of this directory
- [`../README.md`](../README.md) — product overview, architecture, Shopify integration, deployment
- [`/docs`](../docs) — ADRs, Shopify contract, threat model, and the reviews that constrain this code

## Prerequisites

- Node 24 (`nvm use 24`)
- Access to a Harper v5.2.0 Fabric instance. There is **no local Harper and no tunnel** — the
  instance is the runtime, and the Shopify App URL points straight at it.
- The Shopify app secret in Harper native secrets on that instance
  (`set_secret SHOPIFY_API_SECRET`, granted to the component named `sightline` — grant matching is
  keyed on the `name` in `package.json`).

## Setup

```bash
cp .env.example .env   # HARPER_OPS_URL / HARPER_USER / HARPER_PASS / SIGHTLINE_BASE
npm ci
```

## Scripts

| Script                                  | What                                                                                                                                                        |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                              | unit, integration, contract, and UI tests (`node --test`, no browser)                                                                                       |
| `npm run coverage`                      | the same run with coverage                                                                                                                                  |
| `npm run typecheck`                     | `tsc --noEmit`                                                                                                                                              |
| `npm run lint:required`                 | oxlint                                                                                                                                                      |
| `npm run format:write` / `format:check` | prettier                                                                                                                                                    |
| `npm run build`                         | builds the SPA (`web/` → `web/dist/`)                                                                                                                       |
| `npm run dev`                           | Vite dev server for the SPA. There is no proxy and no local backend, so its API calls have nothing to answer them — the real loop is deploy + open in Admin |
| `npm run deploy`                        | build + package + `deploy_component` + per-node restart + verify (see the root README)                                                                      |
| `npm run smoke`                         | post-deploy checks against the deployed host                                                                                                                |
| `npm run loadtest`                      | webhook burst, proving the backlog actually drains (needs `SIGHTLINE_OPS_TOKEN`)                                                                            |
| `npm run contract:gen`                  | regenerates `contracts/sightline-api-v1.json` after an API change                                                                                           |

`node scripts/seed-dev-data.mjs --dry-run --shop=<store>.myshopify.com` validates a seed offline;
without `--dry-run` it writes accepted deliveries to a dev store and lets the real pipeline derive
every projection and finding from them.

## Dev loop

1. Make the change; `npm test` (and `npm run typecheck`, `npm run lint:required`, `npm run format:check`).
2. `npm run deploy` — deploys `app/` to the Fabric instance as component `sightline`.
3. `npm run smoke` — confirms the routes are live and the auth boundary holds. This guards the
   failure mode that a bad top-level import silently 404s **every** route while the component still
   reports "healthy" (ADR-001).
4. Open the app in the dev store's Admin to exercise the embedded experience.

If a contract-shaped change is involved, run `npm run contract:gen` and commit the artifact — a CI
test fails when the checked-in contract drifts from `src/api/apiContract.ts`.

## Layout

| Path             | What                                                                               |
| ---------------- | ---------------------------------------------------------------------------------- |
| `config.yaml`    | Harper component config: `rest`, `graphqlSchema`, `jsResource`                     |
| `schema.graphql` | The sealed tables, in two databases (`sightline_core`, `sightline_ledger`)         |
| `resources.ts`   | Export layer only — one resource class per file under `src/resources/`             |
| `jobs.ts`        | Background loop wiring; all testable logic lives in deps-injected `src/` modules   |
| `src/`           | Backend, grouped by concern — see [`DESIGN.md`](./DESIGN.md)                       |
| `web/`           | The embedded SPA (Vite, App Bridge, Polaris)                                       |
| `test/`          | `*.test.ts`, run by `node --test --conditions=test`                                |
| `scripts/`       | `deploy.mjs`, `smoke.mjs`, `loadtest.mjs`, `seed-dev-data.mjs`, `gen-contract.mjs` |

## HTTP surface

Public: `GET /` (the SPA and its assets), `GET /privacy-policy`, `GET /api/v1/health`.

Session-token authenticated (`X-Shopify-Session-Token`), all tenant-scoped from the verified
principal: `session`, `setup`, `summary`, `events`, `events/:id`, `flows`, `orders`,
`orders/:orderId`, `findings`, `findings/:id`, `privacy`, `export/:kind.csv`, and `digest`
(`GET`/`PUT` — the only write, and it writes Sightline's own settings, never Shopify data).

HMAC-authenticated: `POST /webhooks/shopify/events` and `POST /webhooks/shopify/compliance/*`.

Operator-only: `GET /api/v1/ops`, gated on `SIGHTLINE_OPS_TOKEN` and 404 while it is unset.

The response fields of every read are allowlisted in `src/api/apiContract.ts` and pinned in
[`contracts/sightline-api-v1.json`](../contracts/sightline-api-v1.json).
