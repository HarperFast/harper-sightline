# Sightline — Security & Tenant-Isolation Review (issue #23)

- Date: 2026-08-05 · follow-up pass 2026-08-11 (F5–F7, added after the SPA-serving code landed) · F6/F7 closed 2026-08-26 (raised again by an outside review)
- Scope: the free-MVP recorder (Harper v5 native app + embedded SPA). Read-only, off the synchronous merchant path.
- Companion: [threat model](./threat-model.md) (surface analysis + §8 verification), [data inventory](./data-inventory.md).
- Method: static review of the shipped code against the threat model, an automated cross-tenant attack suite, dependency audit + secret scan, and an independent cross-model review pass. Findings and their disposition are below; per the acceptance criterion each is **fixed** or **explicitly accepted by an owner**.

## 1. Findings

| # | Severity | Finding | Disposition |
|---|---|---|---|
| F1 | **P0** | Committed dev Shopify app secret (`shpss_…`) in `src/readSecret.ts` — present in git history. | **Closed in code** (fallback deleted; reads Harper scoped secrets, fails closed) + **owner action** (rotate the burned value). See §1.1. |
| F2 | **P0** | Token "encryption at rest" falls back to a deterministic, publicly-derivable key (`sha256('sightline-dev-token-key')`) when `SIGHTLINE_TOKEN_KEY` is unset. | **Closed in code** (fallback deleted; reads Harper scoped secrets, fails closed) + **owner action** (provision the key). See §1.1. |
| F3 | **P1** | `detectorKey` was not shop-namespaced → two tenants sharing an order id collide on one finding/expectation row. | **Fixed** — key is now `${detector}:${shopId}:${orderId}:${ruleVersion}`; regression test in `crossTenant.test.ts`. |
| F4 | Info | Cross-tenant read isolation depends entirely on `shopId` coming from the verified principal on every endpoint. | **Verified** — automated suite attacks every endpoint (§2). No leak. |
| F5 | **P0** | Percent-encoded path traversal in `AppHome`'s static-asset branch → **unauthenticated arbitrary file read**, including `src/readSecret.ts` and therefore the app secret (F1). | **Fixed** — containment moved into `src/assetPath.ts`; regression tests in `test/assetPath.test.ts`. See §1.2. |
| F6 | P2 | `?shop=` flows unvalidated into the `frame-ancestors` CSP, and takes precedence over the verified principal's shop. | **Fixed** — the CSP is built from the verified principal; `?shop=` is a pattern-checked fallback. `src/resources/frameAncestors.ts`, regression tests in `test/frameAncestors.test.ts`. See §1.3. |
| F7 | P3 | No rate limiting on session-token verification or on `/api/v1/export`. | **Fixed** — per-shop request and export limits at the shared auth point, plus a size cap on the token itself. `src/auth/rateLimit.ts`, tests in `test/rateLimit.test.ts`. See §1.3. |

### 1.1 The two secret findings (F1, F2)

**Both dev fallbacks are now deleted.** `src/secrets/secretsPolicy.ts` is the single read path for every piece of secret material, and it has no fallback tier: a missing secret throws `MissingSecretError`.

**Why the earlier mitigation was not enough.** The first pass added `SIGHTLINE_REQUIRE_SECRETS`, an opt-in strict mode that refused the fallbacks when set to `1`. It defaulted **off** "so nothing currently working breaks" — which means the exact failure it existed to prevent, a production deploy silently running on a publicly derivable key, was the configuration you got by doing nothing. Fail-closed behind an opt-in flag is fail-open. The flag is gone.

**What the reads look like now.** Harper's scoped secrets accessor first, `process.env` second:

- `secrets.X` is the **scoped tier** — provisioned with `set_secret` + `grants: ['sightline']` (`app/scripts/set-secrets.mjs`), stored encrypted in `system.hdb_secret`, replicated, and reachable only through this component's own accessor. Scoped values never enter `process.env`, so they are absent from environment dumps, `/proc/<pid>/environ`, and inherited child processes. The accessor is live, so a rotation applies on the next read with no redeploy.
- `process.env.X` remains the fallback for local dev, `node --test`, and CI, where no instance holds custody — and as the deliberate escape hatch if the store is unreachable during an incident.

All three required secrets are declared `required: true` in `app/config.yaml`'s `env:` block, so an unmet requirement fails at **component load** with a named reason — `missing`, `ungranted`, or `custody-unavailable` — instead of surfacing as a request-time 500.

**Owner action still required (now a prerequisite for the app serving at all, not hardening on top):**
  1. **Restore Harper secrets custody (Fabric-side).** Still outstanding: `custody_fingerprint` is null cluster-wide, and a node without custody can replicate an encrypted envelope but not decrypt it. `set-secrets.mjs` gates on `get_secrets_public_key` and refuses to write until custody exists, because a secret written without it is unopenable. Until this lands, supply the three values as instance env vars.
  2. **Rotate** the Shopify app secret in the Partner dashboard. Deleting the constant does not un-publish it — it is permanently in git history.
  3. Provision the three scoped secrets with `set-secrets.mjs`, then verify with `--check`.
  4. Redeploy so the `env:` block is re-evaluated.

**Residual risk, stated plainly:** `SIGHTLINE_TOKEN_KEY` cannot be rotated once tokens exist. Envelopes carry `v: 1` for exactly that purpose, but there is no dual-key decrypt path and no re-encrypt sweep, so changing the key invalidates every stored token and forces a reauthorization for every shop. Provisioning the *first* real key has the same effect on anything encrypted under the old dev key — which is the intended outcome, since that ciphertext was never meaningfully protected.

Staged deployment/CI (#25) is where the owner steps land; this review is the gating record.

### 1.2 Asset-handler path traversal (F5)

`AppHome` serves the built SPA's assets off disk, guarded by
`pathname.startsWith('/assets/') && !pathname.includes('..')`. A percent-encoded
traversal walked through it: `URL` leaves `%2e%2e` encoded in `pathname`, so the
textual `..` check never saw it, while URL *resolution* normalizes the same escape
into a real `..` segment and `readFileSync(url)` decodes to a filesystem path.
Confirmed against the deployed layout — `GET
/assets/%2e%2e/%2e%2e/%2e%2e/src/readSecret.ts` returned the module source, and
`..` could leave the component directory entirely. No authentication is involved on
this route.

This **chains with F1**: that file holds the dev app secret, which signs the
session tokens, so the read defeats the tenant isolation of §2 rather than merely
leaking source. It is the reason F1's "already in git history, owner will rotate"
disposition was not the whole story.

Fixed by `src/assetPath.ts` `resolveAssetUrl`, which refuses the traversal
primitives in any encoding (checked before and after one decode round, so
`%252e%252e` is caught) **and** requires the resolved URL to sit under
`web/dist/assets/` — the second check being the one that cannot be fooled by an
encoding the first did not anticipate. Six regression tests cover the confirmed
exploit strings, literal `../`, double encoding, encoded separators, and escapes
that stay inside `web/dist` but leave `assets/`.

### 1.3 F6 and F7 — closed 2026-08-26

Both were recorded here as open by the follow-up pass, and both were independently
raised again by an outside review. Both are now fixed; what each said, and what
shipped:

- **F6 — `?shop=` in the CSP.** `AppHome` emitted `frame-ancestors https://${shop}`
  from the query string and fell back to `principal.shopId` only when the param was
  absent, so a crafted URL decided who may frame the app — and, because the value was
  interpolated uninspected, a value carrying CSP syntax could append directives of its
  own. Exploitability was limited (the session is injected only for a valid `id_token`,
  and there are no cookies to steal), but [threat model](./threat-model.md) §8's iframe
  row claimed `frame-ancestors` is "limited to the shop + Shopify Admin", which was
  stronger than the code.

  **Fixed** in `src/resources/frameAncestors.ts` — pure and separately testable for the
  same reason `assetPath.ts` is (a `Resource` class cannot be imported under
  `node --test`). The verified principal's shop wins; `?shop=` is used only if it
  matches `^[a-z0-9][a-z0-9-]*\.myshopify\.com$` (`src/auth/shopDomain.ts`), which
  admits no space, semicolon or quote and so removes the injection primitives; anything
  unrecognized falls back to `https://*.myshopify.com https://admin.shopify.com`.
  `test/frameAncestors.test.ts` pins the precedence and the hostile inputs;
  `test/shopDomain.test.ts` pins the pattern.

  The wildcard fallback is **kept, and the threat model now says so**: an
  unauthenticated load has not yet been told which store it is, Shopify sends such
  loads, and a narrower policy would un-embed the app. It still excludes every
  non-Shopify origin.
- **F7 — no rate limiting.** Nothing throttled session-token verification or
  `/api/v1/export`, which walks up to `MAX_EXPORT_ROWS` (5000 rows / 50 pages) per
  request on one session token. §3.3's DoS analysis covered webhook burst only, not
  authenticated read abuse.

  **Fixed** in `src/auth/rateLimit.ts` — a fixed-window counter (two numbers per key,
  so the limiter cannot itself become a memory-exhaustion bug; the key map is bounded
  and excess keys collapse into a shared bucket that throttles sooner, never later).
  Wired in two places:

  - **Per shop, every authenticated read:** 600/min, enforced inside
    `identity.authenticate()` — the one line every resource already shares, so a new
    resource cannot forget it. Counted AFTER verification and keyed by the **verified**
    shop: a key taken from unverified input would let a caller both choose their own
    bucket and mint unlimited new ones.
  - **Per shop, `/api/v1/export`:** 10/min, on top of the above.

  Counters live in each worker thread's module memory, so the effective bound is the
  stated limit × worker threads × nodes. They are soft abuse dampers, not quotas, and
  nothing here is a security boundary.

  Session-token verification itself is bounded differently, and deliberately: an
  invalid token has no verified shop to key on, so `verifySessionToken` instead refuses
  a token over `MAX_TOKEN_CHARS` (4096) **before** splitting, base64-decoding or
  JSON-parsing any of it — the work an unauthenticated caller can ask for. Brute-forcing
  the HS256 signature is not reachable at any rate, so a failure counter would buy
  nothing here and could be turned into a way to deny legitimate callers.

  Refusals are HTTP **429** (never 401 — the SPA renders a 401 as "session expired,
  reauthorize", which would send a throttled merchant into a loop that cannot help)
  carrying the seconds to wait, which the export UI now states verbatim. Both counters
  (`rate_limit.requests`, `rate_limit.exports`) appear in `ops.snapshot`; either being
  non-zero in normal operation means the limit is wrong for real use, not that a
  merchant should stay throttled.

  **Scope, stated so this is not read as more than it is:** the counters are per worker
  process, so a cluster of N nodes admits up to N times these limits. This bounds what
  one authenticated shop can ask of the app; volumetric DoS protection remains an
  edge/L7 concern. The limits are also documented in the API contract artifact
  (`contracts/sightline-api-v1.json`, `rateLimits`).

Two structural notes from the same pass, neither a finding:

- **No defense in depth at Harper's layer.** All 15 resources declare `allowRead()
  { return true }`; the `identity.authenticate()` call at the top of each handler is
  the only gate. A new resource that omits that line is world-readable and nothing in
  Harper would stop it. Containment is real (no `@export` on any table, so the two
  databases have no REST/GraphQL surface at all) but authorization is entirely
  in-app.
- **Roles and capabilities are not enforcement points yet.** `Principal.roles` is
  `[]` and is never read anywhere; `requireCapability()` has no call site outside its
  own test. Capabilities are computed and shipped to the SPA. Harmless while `record`
  is granted to every shop and the only write is the digest subscription, but the
  server-side enforcement point does not exist.

## 2. Tenant isolation (the load-bearing control)

Sightline is one shared multi-tenant deployment; every privacy/correctness guarantee rests on `shopId` being derived from the verified principal and applied to every read. Verified:

- **Source of `shopId`:** every merchant-data resource in `resources.ts` reads `shopId` from `identity.authenticate(ctx).shopId` (the verified Shopify session JWT), never from a query param, path segment, or body. The only header-sourced shop domain is on the two HMAC-authenticated webhook endpoints, which are not tenant reads.
- **Query scope:** every function in `queries.ts` constrains its search by `shopId`; detail endpoints (`getEventDetail`, `getFindingDetail`) return `null` when `row.shopId !== shopId`, regardless of the id supplied.
- **No `@export` tables**; responses are field-allowlisted (`apiContract.ts`), so raw rows / PII cannot leak even if a stray field is present.
- **Automated attack suite — `app/test/crossTenant.test.ts`:** a `victim`/`attacker` world where the attacker reuses the victim's order ids + SKU and holds more rows. Every endpoint (`summary`, `events`, `events/:id`, `flows`, `findings`, `findings/:id`, `privacy`) is attacked with the attacker's ids, filters matching only the attacker, and a cursor crafted from the attacker's boundary. **All 9 cases confirm no row leaks and no aggregate over-counts.** F3 (key collision) was found and fixed while building this suite.

## 3. Dependency audit & secret scan

- **Runtime dependencies: none.** `package.json` has an empty `dependencies` block; dev-only tooling is `@types/node`, `oxlint`, `prettier`, `typescript`, `vite`. This is the strongest possible supply-chain posture for the MVP — no third-party code executes in the request/worker path.
- **`npm audit`: 0 vulnerabilities** (2026-08-05).
- **Secret scan:** no embedded secrets remain — the two dev fallbacks (F1, F2) that were the only ones have been deleted (§1.1). The burned `shpss_…` value still lives in git history and must be rotated. No tokens, keys, `.env`, or built artifacts are committed (`.gitignore` verified). Logs cannot leak secrets/PII: `observe.ts` `redactFields` masks token/HMAC/secret/payload/customer-PII keys (word-tokenized) and caps string length — unit-tested (#22).
- **Justification policy:** any future dependency must be justified in `dependencies.md` (engineering guideline); none to justify today.

## 4. Encryption evidence

- **At rest — tokens:** Shopify offline/refresh tokens are stored only as AES-256-GCM envelopes (`crypto.ts`, versioned key, per-record IV, GCM auth tag). Plaintext tokens are never persisted, logged, or returned. The key comes from `SIGHTLINE_TOKEN_KEY`, read as a scoped Harper secret with `process.env` as the dev/CI fallback; there is no weak default — an absent or wrong-shaped key throws (F2, closed). Rotation is not yet supported: the envelope's `v` field exists for it, but with no dual-key decrypt path a key change invalidates every stored token.
- **At rest — ledger:** operational data is Level-1 PCD only (ids, statuses, timestamps, SKU/qty, tracking presence) — **no customer name/email/phone/address** (`privacy/pii.ts` stores only an allowlist of fields at ingress; `data-inventory.md`). Physical deletion at 7 days via `DELETE`-by-age (ADR-003), not TTL.
- **In transit:** Shopify → ingress and Harper → Shopify Admin API are HTTPS; the embedded app is served over HTTPS inside Shopify Admin. HMAC over the raw body authenticates every webhook.
- **Backups:** encrypted backup + tested restore is a Fabric-deployment concern owned by **#24** (reliability/backup/restore) and **#25** (staged deploy); this review records the requirement and the at-rest guarantees the backups inherit.

## 5. Residual risks (accepted / monitored)

- **F1/F2 until owner action complete** — mitigated by the fail-closed guard; must be closed at launch (#25). F5 showed the rotation is not optional: a file read was enough to reach the committed secret.
- **F6/F7 closed** (2026-08-26) — see §1.3. The residual, accepted, is that rate limits are counted per worker thread rather than cluster-wide (effective bound: limit × threads × nodes; soft dampers, not quotas), and that an unauthenticated app load is framed under `https://*.myshopify.com` rather than a single origin.
- **Shared-cluster blast radius** — a tenant-isolation regression would expose all shops; mitigated by the automated suite (§2), which must run in CI (#25). Scale-tier dedicated clusters are a future option.
- **On-disk index residue** could not be directly inspected via the ops API; we rely on `DELETE` (removes index entries) + verify-by-re-query (ADR-003).
- **Quarterly Shopify API-version bump** — stale `api_version` can silently change payloads; recurring operational task (threat model §5).

## 6. Sign-off

Security, product-truth, and tenant-isolation controls are verified for the free MVP **subject to the F1/F2 owner actions being completed at staged deployment (#25).** No unmitigated P0/P1 remains in code. Release owner signs the final go/no-go at #26 (App Store readiness).
