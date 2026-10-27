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
| Secret source | `process.env` (no custody on the dev instance) | scoped Harper secrets | scoped Harper secrets |
| Secrets | real, unrotated dev values | real, rotated | real, rotated |

There is no longer a strict-mode flag. The app fails closed in **every**
environment: a missing secret throws, with no fallback tier. `SIGHTLINE_REQUIRE_SECRETS`
has been removed — it defaulted off, so the misconfiguration it guarded against was
the default state. A missing or undecryptable secret stops the component loading.

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
| `SIGHTLINE_TOKEN_KEY` | app runtime | 32-byte hex token-encryption key (`openssl rand -hex 32`), provisioned as a scoped secret on the Fabric instance. **Not rotatable once tokens exist** — envelopes are versioned (`v: 1`) but there is no dual-key decrypt path or re-encrypt sweep yet, so changing it forces a reauthorization for every shop |
| `SIGHTLINE_SUPPORT_EMAIL` | app runtime | **Optional override.** Defaults in code to `support@harperdb.io` — the contact is product metadata, identical in every environment, so it ships committed and a deploy cannot forget it and leave merchants with no recourse. Override only for a staging or white-label deployment. |
| `SIGHTLINE_SUPPORT_URL` | app runtime | Optional help-centre URL, shown alongside the email |
| `SIGHTLINE_POLICY_UPDATED` | app runtime | Effective date shown on `/privacy-policy`. Set once the policy passes legal review; until then the page reads "Not yet published" |
| `SIGHTLINE_OPS_TOKEN` | app runtime + `loadtest.mjs` | **Optional.** Shared secret for the operator-only `/api/v1/ops` health endpoint, which is how `loadtest.mjs` proves a burst actually drained. Must be ≥ 32 chars (`openssl rand -hex 16`); anything shorter is treated as unset. While unset the route 404s, so an environment that never opts in does not expose it |

### How the component reads its secrets

The three secrets the *component* itself needs — `SHOPIFY_API_SECRET`,
`SIGHTLINE_TOKEN_KEY`, `SIGHTLINE_OPS_TOKEN` — live on the **Fabric instance**, not
in the deploy payload. `deploy.mjs` ships code only; the workflow secrets above are
for the deploy + smoke steps.

They are provisioned as **scoped** Harper secrets:

```
HARPER_OPS_URL=… HARPER_USER=… HARPER_PASS=… \
SHOPIFY_API_SECRET=shpss_… \
SIGHTLINE_TOKEN_KEY=$(openssl rand -hex 32) \
SIGHTLINE_OPS_TOKEN=$(openssl rand -hex 16) \
  node app/scripts/set-secrets.mjs

node app/scripts/set-secrets.mjs --check   # audit names + grants, sends no values
```

That issues `set_secret` with `grants: ['sightline']` for each. Scoped secrets are
encrypted into `system.hdb_secret`, replicated like any system table, and readable
**only** through the component's own `secrets` accessor — they never materialise
into `process.env`, which keeps them out of environment dumps and inherited child
processes, and the accessor is live so a rotation applies on the next read.

`app/config.yaml` declares all three under `env:` with `required: true`, so an
unmet requirement fails at **component load** with a named reason:

| Reason | Meaning | Fix |
|---|---|---|
| `missing` | no row in the store and no env var | provision it |
| `ungranted` | the row exists but `sightline` is not in its `grants` | `grant_secret` |
| `custody-unavailable` | the row exists but this node holds no custody key to decrypt it | re-initialise custody Fabric-side |

**Custody is the prerequisite.** Scoped secrets are encrypted on ingest with the
cluster's custody keypair; a node without it can store and replicate an envelope but
never open one. Verify with the `get_secrets_public_key` operation before
provisioning — `set-secrets.mjs` refuses to write while it returns no key, since a
secret written then is unreadable by every node including the one that wrote it.
The dev instance is currently in that state (`custody_fingerprint` null
cluster-wide), so on it the three values must come from instance env vars until
custody is re-initialised.

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

From the [security review](./security-review.md). The dev fallbacks are **deleted**,
so these are no longer hardening steps layered on a working app — they are what
makes the app serve at all.

1. **Restore Harper secrets custody on the instance.** Verify with
   `get_secrets_public_key`; `set-secrets.mjs` refuses to write until it returns a
   key. Until then, supply the three secrets as instance env vars.
2. **Rotate** the Shopify app secret in the Partner dashboard — the committed dev
   value is burned and stays in git history.
3. Provision the three scoped secrets with `set-secrets.mjs` (see *How the component
   reads its secrets* above), then confirm with `--check`.
4. Redeploy so `config.yaml`'s `env:` block is re-evaluated, and confirm the
   component loads rather than reporting an unmet requirement.
