# Sightline — Threat Model

- Status: **Reviewed for launch** (issue #23 security & tenant-isolation review). Began as the Phase 0 exit draft; §8 below records the verification of every surface against the now-built code.
- Date: 2026-08-04 (draft) · 2026-08-05 (review, issue #23)
- Companion: [security review report](./security-review.md) — findings, dependency audit, secret scan, and encryption evidence.
- Note on numbering: this document originally referenced *backlog-item* numbers; GitHub issue numbers differ (security review = **#23**, observability = **#22**, query API/isolation = **#15**).
- Inputs: [ADR-001 auth](./adr/ADR-001-authentication.md), [ADR-002 worker/lease](./adr/ADR-002-worker-lease-scheduling.md), [ADR-003 retention/deletion](./adr/ADR-003-retention-deletion.md), [Shopify contract](./shopify-contract.md), [dev plan §12/§13](./free_mvp_development_plan.md)
- Product posture: **read-only, off the synchronous path.** No Shopify writes, no billing, no downstream connectors in the MVP. Sightline being down must not affect merchant operations.

## 1. Assets

| Asset | Sensitivity |
|---|---|
| Shopify offline access/refresh tokens (per shop) | **Critical** — grant read access to a merchant's store |
| Token-encryption keys / app secret (HMAC + JWT signing) | **Critical** |
| Operational ledger (orders/fulfillment/inventory/refunds evidence) | **Level 1 PCD** — ids, statuses, timestamps, SKU/qty, tracking |
| Tenant identity (`shopId`) and per-tenant isolation | **Critical** (correctness + privacy) |
| Findings / projections | Level 1 PCD (derived) |
| Deployment & ops credentials (Fabric, CI) | **Critical** |

**Explicitly not stored:** customer name, email, phone, address (Level 2 PCD) — see [contract §5](./shopify-contract.md).

## 2. Trust boundaries

1. **Merchant browser (Admin iframe) → Harper resources** — authenticated by a Shopify session JWT in a custom header.
2. **Shopify → Harper webhook ingress** — authenticated by HMAC over the raw body.
3. **Harper → Shopify Admin API** — authenticated by the offline access token.
4. **Operator/CI → Fabric deployment** — separate credential path, never shared with merchant traffic.
5. **Tenant ↔ tenant** — logical isolation inside one shared multi-tenant Harper deployment (the load-bearing boundary; §4).

## 3. Threat analysis by surface

Status legend: **M** = mitigation established by a Phase 0 ADR/contract; **S** = to build/verify in the scaffold; **R** = residual/monitored.

### 3.1 Install, OAuth & session auth
| Threat | Mitigation | Status |
|---|---|---|
| Forged/replayed session token → impersonate a shop | HS256 verify: signature (timing-safe), `alg`, `aud`=client_id, `iss`/`dest` host match, `exp`, `nbf`; short-lived tokens (ADR-001) | M |
| `Authorization` header abused / token confusion | Token carried in `X-Shopify-Session-Token`; Harper's own auth layer rejects stray `Authorization` (ADR-001) | M |
| `alg:none` / algorithm-confusion downgrade | `alg` must equal `HS256`; anything else rejected (ADR-001, tested) | M |
| Stolen offline token → read merchant data | Tokens in Harper native secrets (encrypted, never logged/replicated as plaintext); least scopes; failed refresh → `reauthorization_required` (ADR-001, contract §2) | M |
| Token exchange / refresh race → torn credential | Atomic version-guarded rotation / claim primitive (ADR-001/002) | M |
| Over-broad access | Minimal read scopes; **no `read_all_orders`**; no write scopes (contract §2) | M |

### 3.2 Embedded iframe / browser
| Threat | Mitigation | Status |
|---|---|---|
| Clickjacking / framing by a hostile page | `frame-ancestors` limited to the **verified** shop + Shopify Admin (`?shop=` is a pattern-checked fallback only); an unauthenticated load falls back to `https://*.myshopify.com` — see §8 | S |
| XSS in the SPA → token/data theft | Strict CSP, no inline/eval, framework escaping, Polaris components; session token is short-lived | S |
| CORS / connect leakage | Strict `connect-src`; no wildcard origins (plan §12) | S |
| Third-party-cookie dependence | Avoided by design — session-token flow, no cookies (ADR-001) | M |

### 3.3 Webhook ingress
| Threat | Mitigation | Status |
|---|---|---|
| Spoofed webhook (no valid HMAC) | Constant-time HMAC over the untouched raw body **before** parsing → 401 (plan §12) | S |
| Replay / duplicate delivery | `(shopId, webhookId)` idempotency key; duplicate = 2xx no-op (plan §13) | S |
| Ingress DoS / burst overload | Minimal durable handler, fast 2xx, backlog worker + reconciliation; burst test gate (plan §13) | S |
| Authenticated read abuse (one token, unbounded expensive reads) | Per-shop fixed-window limits at the single shared auth point — 600 requests/min, and 10/min for `/api/v1/export`, which pages to 5000 rows per call, yields to the event loop between pages, and runs one at a time per worker thread (a second concurrent export on that thread gets 429 + Retry-After; `src/api/exportGate.ts`); oversized session tokens refused before any decoding. Counters are per worker thread, so the effective bound is the limit × worker threads × nodes: a soft damper on one shop's demand, not a quota, not a security boundary, and **not** a volumetric-DoS control — that remains an edge/L7 concern | S |
| Payload tampering / unexpected shapes | Verify-before-parse; unknown additive fields tolerated; breaking shapes dead-letter (backlog #9) | S |
| PII arriving in payloads | `include_fields` whitelists exclude PII; Level-2 fields redacted without approval; ingress stores only an allowlist of those fields, and a body is cleared once processed (contract §5) | M |

### 3.4 Background workers & processing
| Threat | Mitigation | Status |
|---|---|---|
| Double-processing under multi-node/thread | Per-item atomic single-winner insert → exactly-once regardless of worker count (ADR-002) | M |
| Work lost on restart | Durable inbox + startup recovery scan (ADR-002, proven) | M |
| Duplicate active schedulers | Periodic sweeps run as Harper scheduler jobs (leader-coordinated, lease without compare-and-set, so a transient dual-leader window is possible); every sweep is idempotent (ADR-002) | M |
| Poison message stalls the pipeline | Processing is a scheduler job with a failure-capped drain; a delivery dead-letters after MAX_ATTEMPTS (permanent errors immediately) and is skipped for the rest of the drain (ADR-002) | S |

### 3.5 Admin API access (Harper → Shopify)
| Threat | Mitigation | Status |
|---|---|---|
| Reconciliation abused to exfiltrate beyond scope | Read-only least scopes; 60-day window; no `read_all_orders` (contract §2) | M |
| Throttle/cost exhaustion | Respect Shopify cost/throttle feedback; durable cursors; resume-safe (backlog #12) | S |
| Cursor advances past uncommitted work | Cursor never advances beyond committed projection (backlog #12) | S |

### 3.6 Tenant data access (see §4)
| Threat | Mitigation | Status |
|---|---|---|
| Cross-tenant read via manipulated id/filter (IDOR) | Every query derives `shopId` from the verified principal, never caller input; no `@export` tables; explicit field allowlists (ADR-001, plan §8) | M/S |
| Enumeration via deep links | Deep links re-scoped to the principal; expired 7-day records handled gracefully (backlog #18) | S |

### 3.7 Retention, deletion & compliance
| Threat | Mitigation | Status |
|---|---|---|
| Data retained past 7 days / "deleted" but physically present | Explicit `DELETE`-by-age purge (removes data + index); **TTL not relied on** (ADR-003, proven) | M |
| Redaction request not honored / not idempotent | Targeted `DELETE WHERE shopId/customer`, idempotent; mandatory privacy webhooks wired (ADR-003, contract §4) | M/S |
| Redaction undone by a delivery still in flight (accepted before the request, written after it) | 7-day redaction tombstone checked by the worker before and after it writes, and by the reconcile sweep; matching deliveries dropped silently with a counter (`docs/data-inventory.md`, Redaction tombstones). **Needs compliance review before release.** Not closed across nodes (async replication) | M |
| Purge silently fails | Purge-lag/failure metrics + alerts; verify-by-re-query (ADR-003 → #10/#21) | S |

### 3.8 Deployment, ops & supply chain
| Threat | Mitigation | Status |
|---|---|---|
| Secrets in git / CI logs | Secrets in Harper native secrets / deployment secret mgmt; never committed; nothing secret in spike files (ADR-001) | M |
| Deploy creds share merchant trust path | Separate dev/staging/prod credentials; least-privilege deploy; tested rollback (backlog #24) | S |
| Malicious/compromised dependency | Minimal-dependency policy (spikes are zero-dep); each dep justified; audit + secret scan in CI (backlog #22) | M/S |
| Logs leak tokens/PII/HMAC | No tokens/HMAC/raw payloads/PII in logs; safe correlation IDs only (plan §12/§13) | S |

## 4. The load-bearing control: tenant isolation

Sightline is one shared multi-tenant Harper deployment; **every** privacy and correctness guarantee rests on `shopId` being derived from the verified principal and applied to every query, with no `@export` tables and explicit response allowlists. This must be enforced by a **cross-tenant test suite that attacks every query resource with manipulated ids/filters** (backlog #4/#14/#22). Treat any endpoint that can return another shop's data as a P0.

## 5. Residual risks & assumptions

- **Detector false positives** (absence ≠ downstream failure) — product/trust risk, mitigated by conservative eligibility + evidence + copy discipline (plan §17); not a security threat but a trust one.
- **Quarterly API-version bump** — stale `api_version` can silently change payloads or cause delisting (contract §1); operational risk requiring a recurring task.
- **Shared-cluster blast radius** — a tenant-isolation bug exposes all shops; mitigated by §4 testing; Scale-tier dedicated clusters are a future option.
- **On-disk index residue** could not be directly inspected via the ops API; we rely on `DELETE` (not TTL) which removes index entries, plus verify-by-re-query (ADR-003).

## 6. Top actions before the scaffold / before launch

1. Cross-tenant isolation test harness against every query resource (§4) — **P0**.
2. Raw-body HMAC verify-before-parse + idempotency + burst test (§3.3).
3. CSP/`frame-ancestors`/CORS hardening for the embedded app (§3.2).
4. Purge + redaction jobs on the worker/lease, with metrics and verify-by-re-query (§3.7).
5. Secret-free logging + dependency audit/secret scan in CI (§3.8).
6. Recurring `api_version` bump task (§5).

## 8. Verification status (issue #23)

Each Phase-0 **S** ("to build/verify") is now resolved against shipped code. Full detail in the [security review report](./security-review.md).

| Surface (§) | Control now in place | Evidence |
|---|---|---|
| Install/OAuth/session (3.1) | JWT verify incl. alg/aud/iss/exp/nbf; offline-token envelope encryption; atomic rotation | `verifySessionToken.ts`, `identity.ts`, `rotateCredential.ts` + tests |
| Iframe/browser (3.2) | `frame-ancestors` built from the VERIFIED principal, with `?shop=` accepted only if it matches `^[a-z0-9][a-z0-9-]*\.myshopify\.com$`; a load with no verifiable session token gets `https://*.myshopify.com https://admin.shopify.com` (nothing has yet said which store it is), never a wildcard origin; session-token flow (no 3P cookies) | `src/resources/frameAncestors.ts` + `test/frameAncestors.test.ts`, `src/auth/shopDomain.ts`; `identity`/`verifySessionToken` |
| Webhook ingress (3.3) | Constant-time HMAC verify-before-parse → 401 no-mutation; `(shopId,webhookId)` idempotency | `webhookHmac.ts`, `webhookIngress.ts` + tests |
| Workers (3.4) | Idempotent, deterministically-keyed processing; durable inbox; dead-letter visibility | `processor.ts`, `jobs.ts` + `processor.test.ts` |
| Admin API (3.5) | Read-only least scopes; durable cursor never past committed work; throttle-aware | `adminApi.ts`, `reconcile.ts` + `reconcile.test.ts` |
| **Tenant data access (3.6)** | Every query derives `shopId` from the principal; **shop-namespaced keys**; field allowlists; no `@export`; the summary/flows/privacy read caches are keyed by that same `shopId`, one cache per endpoint | **`test/crossTenant.test.ts`** (every endpoint attacked), `test/readCache.test.ts`, `queries.ts`, `tenant.ts`, `readCache.ts` |
| Retention/deletion (3.7) | `DELETE`-by-age purge (data+index); idempotent redaction; purge-lag metrics | `retention.ts`, `redaction.ts` + tests; observability #22 |
| Authenticated read abuse (3.3) | Per-shop request + export limits at `identity.authenticate()`, the one line every read shares; refusals are 429 carrying a wait time, and are counted (`rate_limit.requests`, `rate_limit.exports`) | `src/auth/rateLimit.ts` + `test/rateLimit.test.ts`; `exportResource.ts` |
| Deployment/supply chain (3.8) | **0 npm runtime deps** (`npm audit`: 0 vulns); PII/secret-safe logging; unconditionally fail-closed secret reads via Harper scoped secrets | `package.json`, `observe.ts` redaction, `secretsPolicy.ts`, `config.yaml` `env:` |

**Issue #23 changes:**
- **Cross-tenant integrity fix (P1):** `detectorKey` was `${detector}:${orderId}:${ruleVersion}` — *not* shop-namespaced, so two tenants sharing an order id would collide on one finding/expectation row (only latent because Shopify order ids are globally unique, but exploitable if the app secret leaks). Now `${detector}:${shopId}:${orderId}:${ruleVersion}`, matching every other table key. Regression-tested in `crossTenant.test.ts`.
- **Fail-closed secret reads (P0, closed in code):** both dev fallbacks — the committed `shpss_…` app secret and the `sha256('sightline-dev-token-key')` token key — are deleted. `secretsPolicy.ts` reads Harper **scoped** secrets (`grants: ['sightline']`) first and `process.env` second, and throws `MissingSecretError` when neither answers. There is no strict-mode flag: the previous `SIGHTLINE_REQUIRE_SECRETS` gate defaulted off, so the weak-material configuration it guarded against was the default one.
  - Scoped secrets narrow the exposure surface as well as closing the fallback: values stay out of `process.env`, so an environment dump, a `/proc/<pid>/environ` read, or an inherited child process no longer discloses them. `config.yaml`'s `env:` block makes an unmet requirement a load-time failure with a named reason (`missing` / `ungranted` / `custody-unavailable`) rather than a request-time 500.
  - **Residual, accepted:** custody is a single cluster-shared keypair held in memory on nodes that have it, so a fully compromised running node still yields decrypted secrets — OS isolation remains the boundary. And `SIGHTLINE_TOKEN_KEY` has no rotation path yet (no dual-key decrypt, no re-encrypt sweep), so a key change invalidates every stored token. Owner action outstanding: restore custody, rotate the burned app secret, provision the three secrets.

## 7. Backlog mapping

Auth #3/#4/#6 · webhook/ingress #7/#8/#9 · reconciliation #12 · retention/redaction #10/#20 · query isolation #4/#14 · observability #21 · security review #22 · reliability/backup #23 · deployment #24. This draft feeds the formal threat model in **issue #22**.
