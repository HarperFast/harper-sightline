# Sightline app

The Harper v5 component behind Sightline's embedded Shopify app (the read-only "Record" MVP).

- [`../README.md`](../README.md): product, architecture, API, jobs, configuration, running locally, deploying
- [`DESIGN.md`](./DESIGN.md): the module map and the measured costs behind the limits
- [`../docs`](../docs): ADRs, Shopify contract, security and privacy records, runbooks

## Setup

Node 24 (`nvm use 24`), then:

```bash
npm ci
cp .env.example .env   # HARPER_OPS_URL / HARPER_USER / HARPER_PASS / SIGHTLINE_BASE / SHOPIFY_API_KEY / SIGHTLINE_OPS_TOKEN
```

To run the component on your machine, use Harper 5.3.3 ([root README, Running locally](../README.md#running-locally)).

## Scripts

| Script                                  | What                                                                                                                                                                                                       |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                              | unit, integration, contract and UI tests (`node --test --conditions=test`, no browser)                                                                                                                     |
| `npm run coverage`                      | the same run with coverage                                                                                                                                                                                 |
| `npm run typecheck`                     | `tsc --noEmit`                                                                                                                                                                                             |
| `npm run lint:required`                 | oxlint                                                                                                                                                                                                     |
| `npm run format:write` / `format:check` | prettier                                                                                                                                                                                                   |
| `npm run build`                         | builds the SPA (`web/` to `web/dist/`)                                                                                                                                                                     |
| `npm run dev`                           | Vite dev server for the SPA alone; nothing answers its API calls                                                                                                                                           |
| `npm run deploy`                        | build, package, `deploy_component`, restart every node, verify bundles, columns and indexes ([root README](../README.md#deploying))                                                                        |
| `npm run smoke`                         | checks routes and the auth boundary of a running host (`SIGHTLINE_BASE`, `SHOPIFY_API_SECRET`, `SHOPIFY_API_KEY`); `SMOKE_WEBHOOK=1`, `SMOKE_RATE_LIMIT=1`, `SMOKE_UNINSTALL=1` add checks that write data |
| `npm run loadtest`                      | a signed webhook burst that also checks the backlog drains (`SIGHTLINE_OPS_TOKEN`; `LOAD_SHOP` must be an installed shop)                                                                                  |
| `npm run contract:gen`                  | regenerates `contracts/sightline-api-v1.json` after an API change                                                                                                                                          |

`node scripts/seed-dev-data.mjs --dry-run --shop=<store>.myshopify.com` validates a seed offline; without `--dry-run` it writes accepted deliveries and lets the pipeline derive everything else. `node scripts/set-secrets.mjs --check` reports what the instance's secrets store holds.

## Dev loop

1. Make the change, with tests; run `npm test`, `npm run typecheck`, `npm run lint:required`, `npm run format:check`.
2. If the API's response shape changed, run `npm run contract:gen` and commit the artifact.
3. Run it locally on Harper 5.3.3 and `npm run smoke` against it, or `npm run deploy` to the dev instance and smoke that. Smoke guards the failure where a bad top-level import 404s every route while the component reports healthy (ADR-001).
4. Open the app in the dev store's Admin to exercise the embedded experience.

## Layout

| Path             | What                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| `config.yaml`    | Component config: `rest`, `graphqlSchema`, `jsResource`, the required secrets (`env:`), and the scheduler jobs |
| `schema.graphql` | The sealed tables in `sightline_core` and `sightline_ledger`                                                   |
| `resources.ts`   | Export layer only: one resource class per file under `src/resources/`                                          |
| `jobs.ts`        | Scheduler job handlers; wiring only, the logic lives in deps-injected `src/` modules                           |
| `src/`           | Backend by concern ([`DESIGN.md`](./DESIGN.md))                                                                |
| `web/`           | The embedded SPA (Vite, App Bridge, Polaris)                                                                   |
| `test/`          | `*.test.ts`; `fakeTable.ts` is the in-memory table, `harperStub.ts` the runtime stub                           |
| `scripts/`       | `deploy`, `smoke`, `loadtest`, `seed-dev-data`, `set-secrets`, `gen-contract`                                  |
