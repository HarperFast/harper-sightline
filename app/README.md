# Sightline app

Harper v5 native, embedded Shopify Admin application (the "Record" MVP).

See [`DESIGN.md`](./DESIGN.md) for the runtime shape and [`/docs`](../docs) for the
ADRs, Shopify contract, and threat model that constrain this code.

## Prerequisites

- Node 24 (`nvm use 24`)
- Access to a Harper v5.2.0 instance (Fabric); the Shopify app secret stored in
  Harper native secrets (`set_secret SHOPIFY_API_SECRET`, granted to `sightline`).

## Setup

```bash
cp .env.example .env   # fill in HARPER_OPS_URL / USER / PASS, SIGHTLINE_BASE
npm ci
```

## Scripts

| Script                                  | What                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------- |
| `npm test`                              | unit tests (`node --test`)                                                 |
| `npm run typecheck`                     | `tsc --noEmit`                                                             |
| `npm run lint:required`                 | oxlint                                                                     |
| `npm run format:write` / `format:check` | prettier                                                                   |
| `npm run deploy`                        | package + `deploy_component` + restart + wait-for-health (env creds)       |
| `npm run smoke`                         | post-deploy route smoke test (`/api/v1/health` 200, `/api/v1/session` 401) |

## Dev loop (Fabric-hosted)

1. `npm run deploy` — deploys `app/` to the Fabric instance as component `sightline`.
2. `npm run smoke` — confirms routes are live (guards the "healthy but no routes" trap).
3. The Shopify **App URL** points at the Fabric HTTPS endpoint; install on a dev
   store to open the embedded app in Admin. No local tunnel.

## Endpoints (slice 1)

- `GET /api/v1/health` → `{ ok, service, version }` (public)
- `GET /api/v1/session` → verifies `X-Shopify-Session-Token`, returns `{ shop, user }`; 401 without a valid token
