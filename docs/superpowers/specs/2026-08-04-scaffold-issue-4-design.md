# Scaffold — Harper v5 Native Shopify App (Issue #4) — Design Spec

- Status: draft, awaiting review
- Date: 2026-08-04
- GitHub issue: #4 (M1 Foundation) — depends on Phase 0 (complete)
- Inputs: [dev plan §6/§7/§14](../../free_mvp_development_plan.md), [ADR-001](../../adr/ADR-001-authentication.md), [Shopify contract](../../shopify-contract.md), Harper engineering guidelines

## 1. Goal & scope

Deliver the thinnest **deployable, authenticated shell**: a Harper v5 TypeScript application that a merchant installs from a dev store, opens inside Shopify Admin, and sees an authenticated Polaris/App Bridge shell — with CI and docs. Nothing more.

**In scope (issue #4):** Harper component skeleton; a `Health` resource and a real `/api/v1/session` (verifies the Shopify session token, returns `{shop, user}`); Vite + App Bridge + Polaris embedded frontend served by Harper's static plugin; `shopify.app.toml`; CI (format/lint/typecheck/test/build); `dependencies.md`, `DESIGN.md`, `.env.example`, setup docs; a Fabric deploy script with a post-deploy route smoke test.

**Explicitly deferred (separate issues):** sealed private schemas + generated types (#6); principal/capability service + cross-tenant guard suite (#5); webhook ingress (#7); install/credential/reauth lifecycle (#6/#7); any real ledger data or detector.

## 2. Decisions (from brainstorming)

1. **Dedicated app dir:** the real Harper component lives in `app/`; `docs/` and `spikes/` stay siblings. Fabric deploys `app/` as component **`sightline`**.
2. **Fabric-hosted dev loop:** deploy `app/` to the Fabric instance; the Shopify **App URL points at the Fabric HTTPS endpoint**; install on the dev store. No local tunnel (local Harper was blocked in Phase 0; Fabric is the proven runtime).
3. **Auth in #4:** promote the proven Spike A session-token verifier into real `app/src` and expose `/api/v1/session`. The full principal/capability boundary + cross-tenant guards remain in #5.
4. **Two review slices (two PRs):** (1) backend skeleton + session + CI + docs + deploy; (2) embedded Polaris/App Bridge shell.

## 3. File structure

```
app/
  config.yaml                 # rest: true; graphqlSchema; jsResource: resources.ts; static: web/dist at root
  schema.graphql              # minimal placeholder (real sealed tables in #6)
  resources.ts                # Health + Session resources (named exports)
  src/
    verifySessionToken.ts     # promoted from Spike A (real code now)
    AuthError.ts
    readSecret.ts             # Harper native secrets, lazy import, env fallback
    principal.ts              # thin { shopId, userId, roles, source } type (full service in #5)
  web/                        # Vite SPA
    index.html
    src/main.ts               # App Bridge init, getSessionToken, call /api/v1/session, render shell
    src/api.ts                # fetch helper: sets X-Shopify-Session-Token
    (Polaris web components via CDN-free bundled dep)
  package.json                # scripts: dev, build, test, typecheck, lint:required, format:write, deploy, smoke
  tsconfig.json               # TypeStrip-compatible (erasableSyntaxOnly, allowImportingTsExtensions)
  .prettierrc + oxlint config # format + lint tooling
  dependencies.md
  DESIGN.md
  .env.example                # HARPER_OPS_URL, SHOPIFY_API_KEY (client_id), etc. (no secrets)
shopify.app.toml              # api_version 2026-07, scopes, App URL, privacy_compliance URLs
.github/workflows/ci.yml
scripts/deploy.mjs            # ops-API deploy_component + restart + wait-healthy
scripts/smoke.mjs             # post-deploy: assert /api/v1/health and /api/v1/session (401 no-token) respond
```

## 4. Slice 1 — backend skeleton

**Resources** (`app/resources.ts`, mirroring the proven Spike A pattern — deny-by-default, `allowRead`, header via `this.getContext()`):
- `Health` → `GET /api/v1/health` → `{ ok: true, service: 'sightline', version }`. Public.
- `Session` → `GET /api/v1/session` → reads `X-Shopify-Session-Token`, verifies via `verifySessionToken` (secret from Harper native secrets), returns `{ shop: principal.shopId, user: principal.userId }`; 401 on missing/invalid. Public route, self-verifying (Harper intercepts `Authorization`, so custom header — ADR-001).

**Routing note (ADR-001 lesson):** direct `import { Resource } from 'harper'`; lazy secrets; classes route at `/<ExactClassName>` — so to serve `/api/v1/session` we either name classes with a base path (`static path`) or mount under an `api/v1` prefix. Confirm the exact path mechanism at implementation (Spike A used root class names); the smoke test guards against the silent-404 failure mode.

**Config** (`app/config.yaml`): `rest: true`, `jsResource: files: './resources.ts'`, `graphqlSchema: files: './schema.graphql'`, and static serving of `web/dist` at the root path (Harper static plugin — exact key confirmed at implementation).

**Deploy + smoke** (`scripts/deploy.mjs`, `scripts/smoke.mjs`): tar `app/`, `deploy_component` project `sightline` via ops API, `restart`, poll `get_components` until healthy; then smoke: `GET /api/v1/health` → 200, `GET /api/v1/session` (no token) → 401. Creds from env. Fail the script (non-zero) on any miss — this is the standing guard against the "healthy but no routes" trap.

**CI** (`.github/workflows/ci.yml`): Node 24; `npm ci`; `format:write --check`, `lint:required` (oxlint), `typecheck` (`tsc --noEmit`), `test` (`node --test`), `build` (`vite build`). No deploy in CI for #4 (deploy is manual/scripted).

**Docs:** `dependencies.md` (justify every dep), `DESIGN.md` (architecture + the Phase 0 findings that constrain the app), `.env.example`, README setup section.

**Exit (Slice 1):** component deploys to Fabric; `smoke.mjs` passes live; CI green; no secret/.env/build artifact committed.

## 5. Slice 2 — embedded Polaris/App Bridge shell

**Frontend** (`app/web/`): a Vite TypeScript SPA.
- App Bridge initialized with the app's client id (`SHOPIFY_API_KEY`, public) + host param.
- On load: `getSessionToken()` → `GET /api/v1/session` with `X-Shopify-Session-Token` → render.
- **Authenticated shell:** Polaris web components render an app frame with nav (Overview / Events / Findings / Privacy) as **empty stubs**, showing the resolved `shop` and a "Recording" placeholder. No data yet.
- States: loading, error, and reauthorization (401 → App Bridge redirect/permission prompt) handled minimally.
- Served by Harper static from `web/dist`.

**Exit (Slice 2):** `shopify app` config installs on the dev store; the app opens inside Admin; the shell authenticates a real App Bridge token end-to-end and renders the Polaris frame; accessibility/keyboard basics pass.

## 6. Engineering standards (Harper guidelines)

- TypeStrip TS: erasable syntax only, `.ts` import extensions, no enums/param properties, named exports, tabs, semicolons, `node:` prefix.
- Tooling: **prettier** (`format:write`), **oxlint** (`lint:required`), **`tsc --noEmit`** (`typecheck`), **`node --test`** (`test`), **vite** (`build`) — matching Harper's oxlint/tsc convention and script names.
- Tests required for new modules/changed functions; the promoted verifier keeps its Spike A tests.
- Minimal dependencies, each justified in `dependencies.md`. Frontend deps (Vite, App Bridge, Polaris) are necessary and justified; backend stays zero-runtime-dependency.
- No secrets/tokens/PII in logs; descriptive errors with `.statusCode`.
- Maintain `DESIGN.md`.

## 7. Dependencies (anticipated, to justify)

- Runtime backend: none (uses `harper`, `node:` builtins).
- Frontend: `vite` (build), `@shopify/app-bridge` (session token + embedded), Polaris web components package. Confirm exact package names/versions at implementation.
- Dev: `prettier`, `oxlint`, `typescript`.

## 8. Risks / open items

- **Static + resource routing coexistence:** confirm Harper's config keys for serving `web/dist` at `/` while resources answer under `/api/v1/*` (and the exact path mechanism for nested resource paths). The smoke test + a small live check de-risk this early in Slice 1.
- **App Bridge version/API:** confirm the current App Bridge script/package and `host` handling for embedded apps at implementation.
- **Polaris web components vs React:** the plan specifies Polaris **web components** (not React) — confirm the current distribution and that it works without a framework.
- **Session path**: `/api/v1/session` naming vs Harper's class-name routing — resolve in Slice 1 (may require `static path` on the resource).

## 9. Not doing (guard against scope creep)

No sealed schemas, no capability service, no cross-tenant guard suite, no webhooks, no reconciliation, no detector, no billing, no real data. Those are #5/#6/#7+.
