# ADR-001: Authentication and Shopify credential handling

- Status: **Accepted** (Spike A complete; one confirmatory step — real App Bridge token from Admin — deferred, see §7)
- Date: 2026-08-04
- Phase: 0 (risk retirement), GitHub issue #2
- Evidence: `spikes/auth/` (11 offline tests + 3 live integration tests), `spikes/auth/RUNTIME-NOTES.md`, `spikes/auth/live/atomicClaim.mjs`
- Runtime proven against: Harper **5.2.0** on Fabric (`ayoo.josh-test.harperfabric.com`), Node 24.18.0

## Context

Sightline is a public, embedded Shopify Admin app on Harper v5. Two distinct auth concerns:
1. **Browser → Harper** for merchant requests inside the Admin iframe.
2. **Harper → Shopify Admin API** for background reconciliation.

The plan assumed Shopify's embedded session-token + token-exchange flow maps onto Harper resources and that `@harperfast/oauth` is not on the request path. Spike A validated these against a live instance.

## Decision

### 1. Shopify session JWT is authoritative for merchant browser requests
Each embedded request carries a short-lived Shopify-signed session JWT (HS256, signed with the app secret). A guarded Harper resource verifies it in-process and derives a normalized `Principal { shopId, userId, roles, source }`. Validated: signature (timing-safe), `alg=HS256`, `aud=client_id`, `iss`/`dest` host equality, `exp`, `nbf`. `shopId` is derived from the verified `dest` host — **never** from caller input.

### 2. The session token travels in a custom header, not `Authorization`
**Harper's HTTP auth layer intercepts the `Authorization` header** and rejects an unknown `Bearer` value with `401 {"error":"invalid token"}` before the resource runs (observed live). Therefore the Shopify session token is sent in **`X-Shopify-Session-Token`**. The App Bridge/Polaris frontend (issue #4, screens) must call `getSessionToken()` and put the value in that header; guarded resources read it there.

### 3. Resources are guarded, deny-by-default
Harper resources are deny-by-default; a resource must define an authorization hook (`allowRead()`), then perform its own Shopify verification. Every merchant query derives `shopId` from the principal and never trusts a client-supplied shop id.

### 4. `@harperfast/oauth` is not on the MVP request path
`HarperFast/oauth` provides GitHub/Google/Azure/Auth0/Okta/OIDC redirect-flow providers — **no Shopify embedded provider**. Shopify's redirectless, cookie-free session-token flow does not fit it. The normalized `Principal` boundary reserves the plugin for future standalone/agency OIDC identity without changing resource logic.

### 5. Background access uses expiring offline tokens with atomic rotation
Offline access is obtained via Shopify token exchange (`requested_token_type=...offline-access-token`, `expiring=1`) → `{ access_token, expires_in, refresh_token, refresh_token_expires_in }`. Rotation is made atomic using Harper's **unique primary-key insert as a compare-and-claim** primitive: a rotator claims `(shopId, nextVersion)`; exactly one insert wins (proven: 12 concurrent inserts → 1 winner, 11 skipped, 0 errors); the winner performs the exchange and writes the credential; losers re-read. `refreshCredential` proves the surrounding optimistic-concurrency algorithm in a unit test.

### 6. The app secret lives in Harper native secrets
`SHOPIFY_API_SECRET` is stored via `set_secret`, scoped-granted to the component (`sightline` / `sightline-spike-auth`), encrypted at rest, never returned/logged/replicated as plaintext. Read at runtime via `(await import('harper')).secrets.SHOPIFY_API_SECRET` (dynamic import + optional access so it cannot break module load). Confirmed live: the granted component sees the secret and verifies a real-secret-signed token to a correct principal.

## Consequences / constraints the scaffold (issues #4–6) must honor

- **Frontend:** send the session token in `X-Shopify-Session-Token`, not `Authorization`.
- **Resource base:** a shared guarded base reads that header → `verifySessionToken` → `Principal`; resources subclass it and derive `shopId` from the principal.
- **Module-load discipline:** use direct `import { Resource } from 'harper';`; access `secrets` lazily. A single bad top-level import silently 404s *all* routes while the component still reports `healthy` — add a post-deploy smoke test asserting a known route returns 200.
- **Credential store:** `ShopCredential` rotation uses claim-based optimistic concurrency; failed refresh → `reauthorization_required` (issue #6).
- **Deploy:** component `project` name must match the secret grant for scoped-secret visibility; deploy via `deploy_component` (base64 tar) then `restart`.
- **Errors:** throw `Error` with `.statusCode`; Harper renders structured `{type,code,title,status,instance}` JSON. `AuthError` → 401.

## Alternatives considered

- **Harper-issued JWT for merchant traffic** — rejected: embedded apps cannot rely on third-party cookies; Shopify's session token is the authoritative, standard mechanism.
- **Token in `Authorization: Bearer`** — rejected: Harper's auth layer consumes it (proven). Custom header avoids the conflict without disabling Harper auth globally.
- **Non-expiring offline tokens** — rejected: new public apps must use expiring offline tokens; rotation is required regardless.

## Open / deferred

- **Task 4 (deferred):** verify a *genuine* App Bridge session token generated inside Shopify Admin (requires pointing the Partner app URL at a deployed build + install). The full cryptographic path is already proven with a token signed by the real secret; Task 4 only confirms a real Admin token's claim shapes match the verifier. Track as a scaffold-time confirmation.
- **Shopify refresh request params (issue #6):** confirm the exact refresh call for expiring offline tokens against Shopify's offline-access-tokens doc. `refreshCredential` injects `fetchNewToken`, so this is decoupled from the rotation logic.
