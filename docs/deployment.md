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
| `SIGHTLINE_SUPPORT_EMAIL` | app runtime | **Optional override.** Defaults in code to `support@harperdb.io` — the contact is product metadata, identical in every environment, so it ships committed and a deploy cannot forget it and leave merchants with no recourse. Override only for a staging or white-label deployment. |
| `SIGHTLINE_SUPPORT_URL` | app runtime | Optional help-centre URL, shown alongside the email |
| `SIGHTLINE_POLICY_UPDATED` | app runtime | Effective date shown on `/privacy-policy`. Set once the policy passes legal review; until then the page reads "Not yet published" |

Runtime secrets the *component* reads (`SHOPIFY_API_SECRET`, `SIGHTLINE_TOKEN_KEY`,
`SIGHTLINE_REQUIRE_SECRETS`) live on the **Fabric instance** (Harper native secrets /
instance env), not in the deploy payload — `deploy.mjs` ships code only. The
workflow secrets above are for the deploy + smoke steps.

## Deploying

- **Release (recommended, versioned):** publish a GitHub Release → deploys to
  `production`. The tag is the audit record; roll back by deploying an earlier tag.
- **Manual:** Actions → Deploy → Run workflow → pick `environment` and optionally a
  `ref` (tag/sha/branch).

## Multi-node clusters: component code does NOT replicate

A Fabric instance can be a **multi-node cluster behind one hostname** — `ayoo.josh-test` is two
nodes (`4yq-us-west4-a-1`, `ls3-us-east5-a-1`). Databases replicate between them. **Component code
does not.** Both consequences bit us on 2026-08-06:

1. `restart` sent to the load-balanced ops endpoint (`https://<cluster>:9925/`) reaches **exactly one
   node**. The others keep the previously-loaded component in memory, so the app **flip-flops between
   versions** depending on which node serves the request — `/api/v1/setup` alternated 401 (new) and
   200-HTML (old, falling through to the SPA catch-all), and the SPA alternated bundle hashes.
2. Polling `/api/v1/health` proves nothing: the **old** component answers it 200 just as happily, so a
   deploy that shipped nothing reported success.

`deploy.mjs` now handles both:

- **Discovers every node** — starting from whichever node the LB hands it, reading that node's own
  identity from `get_configuration.replication.hostname` and its peers from
  `cluster_status.connections[].name`, then walking each peer the same way. Do **not** identify the
  local node from the CA subject: the CA is cluster-wide and always names the issuing node, so on any
  other node it reports the wrong name and that node is silently skipped.
- **Restarts each node by its own hostname** (`https://<node>:9925/`) and waits for it individually.
- **Verifies the hashed SPA bundle** the build just produced is what each node actually serves, then
  probes the load-balanced hostname 8× to catch a mixed cluster.
- **Exits non-zero** and names the offending nodes if any of that fails. A half-deployed cluster is
  worse than a failed deploy, so this fails loudly rather than reporting success.

If a deploy ever does report `DEPLOY NOT VERIFIED`, re-run it, or restart the named node(s) directly
at `https://<node>:9925/` with `{"operation":"restart"}`.

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
