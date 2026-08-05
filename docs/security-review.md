# Sightline — Security & Tenant-Isolation Review (issue #23)

- Date: 2026-08-05
- Scope: the free-MVP recorder (Harper v5 native app + embedded SPA). Read-only, off the synchronous merchant path.
- Companion: [threat model](./threat-model.md) (surface analysis + §8 verification), [data inventory](./data-inventory.md).
- Method: static review of the shipped code against the threat model, an automated cross-tenant attack suite, dependency audit + secret scan, and an independent cross-model review pass. Findings and their disposition are below; per the acceptance criterion each is **fixed** or **explicitly accepted by an owner**.

## 1. Findings

| # | Severity | Finding | Disposition |
|---|---|---|---|
| F1 | **P0** | Committed dev Shopify app secret (`shpss_…`) in `src/readSecret.ts` — present in git history. | **Owner action** (rotate) + **mitigated in code** (fail-closed guard). See §1.1. |
| F2 | **P0** | Token "encryption at rest" falls back to a deterministic, publicly-derivable key (`sha256('sightline-dev-token-key')`) when `SIGHTLINE_TOKEN_KEY` is unset. | **Owner action** (set key) + **mitigated in code** (fail-closed guard). See §1.1. |
| F3 | **P1** | `detectorKey` was not shop-namespaced → two tenants sharing an order id collide on one finding/expectation row. | **Fixed** — key is now `${detector}:${shopId}:${orderId}:${ruleVersion}`; regression test in `crossTenant.test.ts`. |
| F4 | Info | Cross-tenant read isolation depends entirely on `shopId` coming from the verified principal on every endpoint. | **Verified** — automated suite attacks every endpoint (§2). No leak. |

### 1.1 The two secret findings (F1, F2)

Both are **dev unblocks** that must not survive to production. They exist because the Fabric instance's native secrets custody is degraded cluster-wide (`custody_fingerprint` null), so the app currently *relies* on these fallbacks to function — changing their values now would break the live dev-store embed (webhook HMAC would fail). Therefore:

- **Code mitigation (done):** `src/secretsPolicy.ts` adds `SIGHTLINE_REQUIRE_SECRETS`. When set to `1`, `readShopifySecret()` and the token-encryption key both **throw `InsecureSecretError` instead of using the dev fallback** — the app fails closed rather than silently running on known-weak material. Off by default so nothing currently working breaks.
- **Owner action (required before launch), tracked here as explicitly accepted until done:**
  1. Restore Harper native secrets custody (Fabric-side) — see the secrets-custody note in `readSecret.ts`.
  2. **Rotate** the Shopify app secret in the Partner dashboard (the committed value is burned).
  3. Provision `SHOPIFY_API_SECRET` and a 32-byte-hex `SIGHTLINE_TOKEN_KEY` via deployment secret management.
  4. Set `SIGHTLINE_REQUIRE_SECRETS=1` on staging + production so the guard is armed.
  5. Delete `DEV_FALLBACK_SECRET` and the deterministic key fallback once custody is proven (they become dead code).

Staged deployment/CI (#25) is where steps 1–4 land; this review is the gating record.

## 2. Tenant isolation (the load-bearing control)

Sightline is one shared multi-tenant deployment; every privacy/correctness guarantee rests on `shopId` being derived from the verified principal and applied to every read. Verified:

- **Source of `shopId`:** every merchant-data resource in `resources.ts` reads `shopId` from `identity.authenticate(ctx).shopId` (the verified Shopify session JWT), never from a query param, path segment, or body. The only header-sourced shop domain is on the two HMAC-authenticated webhook endpoints, which are not tenant reads.
- **Query scope:** every function in `queries.ts` constrains its search by `shopId`; detail endpoints (`getEventDetail`, `getFindingDetail`) return `null` when `row.shopId !== shopId`, regardless of the id supplied.
- **No `@export` tables**; responses are field-allowlisted (`apiContract.ts`), so raw rows / PII cannot leak even if a stray field is present.
- **Automated attack suite — `app/test/crossTenant.test.ts`:** a `victim`/`attacker` world where the attacker reuses the victim's order ids + SKU and holds more rows. Every endpoint (`summary`, `events`, `events/:id`, `flows`, `findings`, `findings/:id`, `privacy`) is attacked with the attacker's ids, filters matching only the attacker, and a cursor crafted from the attacker's boundary. **All 9 cases confirm no row leaks and no aggregate over-counts.** F3 (key collision) was found and fixed while building this suite.

## 3. Dependency audit & secret scan

- **Runtime dependencies: none.** `package.json` has an empty `dependencies` block; dev-only tooling is `@types/node`, `oxlint`, `prettier`, `typescript`, `vite`. This is the strongest possible supply-chain posture for the MVP — no third-party code executes in the request/worker path.
- **`npm audit`: 0 vulnerabilities** (2026-08-05).
- **Secret scan:** the two dev fallbacks (F1, F2) are the only embedded secrets and are addressed above. No tokens, keys, `.env`, or built artifacts are committed (`.gitignore` verified). Logs cannot leak secrets/PII: `observe.ts` `redactFields` masks token/HMAC/secret/payload/customer-PII keys (word-tokenized) and caps string length — unit-tested (#22).
- **Justification policy:** any future dependency must be justified in `dependencies.md` (engineering guideline); none to justify today.

## 4. Encryption evidence

- **At rest — tokens:** Shopify offline/refresh tokens are stored only as AES-256-GCM envelopes (`crypto.ts`, versioned key, per-record IV, GCM auth tag). Plaintext tokens are never persisted, logged, or returned. Key source is deployment secret management (`SIGHTLINE_TOKEN_KEY`); the dev fallback is F2, now fail-closed-guarded.
- **At rest — ledger:** operational data is Level-1 PCD only (ids, statuses, timestamps, SKU/qty, tracking presence) — **no customer name/email/phone/address** (`pii.ts` strips at ingress; `data-inventory.md`). Physical deletion at 7 days via `DELETE`-by-age (ADR-003), not TTL.
- **In transit:** Shopify → ingress and Harper → Shopify Admin API are HTTPS; the embedded app is served over HTTPS inside Shopify Admin. HMAC over the raw body authenticates every webhook.
- **Backups:** encrypted backup + tested restore is a Fabric-deployment concern owned by **#24** (reliability/backup/restore) and **#25** (staged deploy); this review records the requirement and the at-rest guarantees the backups inherit.

## 5. Residual risks (accepted / monitored)

- **F1/F2 until owner action complete** — mitigated by the fail-closed guard; must be closed at launch (#25).
- **Shared-cluster blast radius** — a tenant-isolation regression would expose all shops; mitigated by the automated suite (§2), which must run in CI (#25). Scale-tier dedicated clusters are a future option.
- **On-disk index residue** could not be directly inspected via the ops API; we rely on `DELETE` (removes index entries) + verify-by-re-query (ADR-003).
- **Quarterly Shopify API-version bump** — stale `api_version` can silently change payloads; recurring operational task (threat model §5).

## 6. Sign-off

Security, product-truth, and tenant-isolation controls are verified for the free MVP **subject to the F1/F2 owner actions being completed at staged deployment (#25).** No unmitigated P0/P1 remains in code. Release owner signs the final go/no-go at #26 (App Store readiness).
