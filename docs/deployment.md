# Sightline — Deployment & CI/CD (issue #25)

How Sightline is built, gated, and shipped to Harper Fabric. Read with the
[deployment-rollback runbook](./runbooks/deployment-rollback.md) and the
[reliability report](./reliability-report.md) (load + backup/restore drills).

## Pipeline overview

- **CI** (`.github/workflows/ci.yml`, on every PR + push to main): `app` job runs
  format → lint → typecheck → test (unit + integration + **contract**) → coverage
  → build; `security` job runs `npm audit` + a **secret scan**. All must pass to merge.
- **CD** (`.github/workflows/deploy.yml`): **manual dispatch or published release**
  — deliberately *not* auto-on-merge, because the target hosts a live store. Builds
  the SPA, runs `deploy.mjs` (component deploy → restart → health-poll → heal the
  sealed-column flake), then `smoke.mjs`. Secrets + host come from the selected
  GitHub **Environment**.

## Environments & configuration split

Three logical environments; each is a GitHub **Environment** with its own secrets
(and, for production, required reviewers / protection rules).

| | development | staging | production |
|---|---|---|---|
| Purpose | local + the shared dev Fabric instance | pre-prod verification | live App Store install |
| Config source | `.env` / local env | GitHub Environment `staging` | GitHub Environment `production` |
| `SIGHTLINE_REQUIRE_SECRETS` | unset (dev fallbacks allowed) | **`1`** | **`1`** |
| Secrets | dev fallbacks (custody-degraded) | real, rotated | real, rotated |

> The existing deployed instance is the current target — point the environment's
> `HARPER_OPS_URL` / `SIGHTLINE_BASE` at it. Add a separate production instance
> later by creating a second Environment with its own host + secrets; no workflow
> change needed.

### Required secrets (per Environment)

| Secret | Used by | Notes |
|---|---|---|
| `HARPER_OPS_URL` | `deploy.mjs` | Harper operations API, e.g. `https://<host>:9925/` |
| `HARPER_USER` / `HARPER_PASS` | `deploy.mjs` | least-privilege deploy user (not a merchant/admin cred) |
| `SIGHTLINE_BASE` | `deploy.mjs`, `smoke.mjs` | public app base URL for health/smoke |
| `SHOPIFY_API_SECRET` | app runtime + `smoke.mjs` | **rotated** app secret (see below); enables authenticated smoke |
| `SHOPIFY_API_KEY` | `smoke.mjs` | public client id (not secret) |
| `SIGHTLINE_TOKEN_KEY` | app runtime | 32-byte hex token-encryption key (set on the Fabric instance) |

Runtime secrets the *component* reads (`SHOPIFY_API_SECRET`, `SIGHTLINE_TOKEN_KEY`,
`SIGHTLINE_REQUIRE_SECRETS`) live on the **Fabric instance** (Harper native secrets /
instance env), not in the deploy payload — `deploy.mjs` ships code only. The
workflow secrets above are for the deploy + smoke steps.

## Deploying

- **Release (recommended, versioned):** publish a GitHub Release → deploys to
  `production`. The tag is the audit record; roll back by deploying an earlier tag.
- **Manual:** Actions → Deploy → Run workflow → pick `environment` and optionally a
  `ref` (tag/sha/branch).

## Rollback (tested path)

`deploy.mjs` ships whatever tree is checked out, so **rollback = deploy an earlier
ref**:

1. Actions → Deploy → Run workflow → set `ref` to the last-good tag/sha, `environment` = the affected env.
2. The run rebuilds that ref, redeploys, and smokes it. Because all processing is
   idempotent and durable (accepted deliveries persist, the reconcile cursor
   resumes, purge is idempotent), a redeploy/rollback loses no data.
3. If a schema-changing deploy left a table degraded, `deploy.mjs` re-heals the
   sealed-column flake and verifies with `describe_table` — confirm before declaring recovery.

Full incident detail: [deployment-rollback runbook](./runbooks/deployment-rollback.md).

## Staging smoke coverage (`npm run smoke`)

Exercises, against the deployed host: health route, unauthenticated 401, webhook
**bad-HMAC → 401 (no mutation)**, and — when `SHOPIFY_API_SECRET`/`KEY` are set —
authenticated `session`/`summary`/`privacy`/`findings` reads. `SMOKE_WEBHOOK=1`
adds a signed webhook round-trip (writes a synthetic delivery — staging only).
Install/uninstall are exercised via the Shopify CLI managed-install flow on the
dev store (not scriptable here); the deploy is confirmed live by the health/auth smoke.

## Before first production deploy — required owner actions (F1/F2)

From the [security review](./security-review.md): the dev fallbacks must not reach
production.

1. Restore Harper native secrets custody on the instance (see `readSecret.ts` note).
2. **Rotate** the Shopify app secret in the Partner dashboard (the committed dev value is burned).
3. Provision `SHOPIFY_API_SECRET` + a 32-byte-hex `SIGHTLINE_TOKEN_KEY` on the instance and in the Environment secrets.
4. Set **`SIGHTLINE_REQUIRE_SECRETS=1`** on the instance so it fails closed rather than using a dev fallback.
5. Delete `DEV_FALLBACK_SECRET` + the deterministic key fallback once custody is proven.
