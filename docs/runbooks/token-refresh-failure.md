# Runbook: token refresh failure / reauthorization required

**Owner:** Sightline on-call

### Alert
- `ops.snapshot` health `reauthorization.shops > 0`, or
- repeated `reconcile.error` for a single shop with an auth-shaped `message`.

### Why it matters
Background work (reconciliation, install backfill) uses an **expiring offline
access token** with atomic refresh-token rotation. When a refresh fails, the
credential is marked `reauthorization_required`: Admin API jobs for that shop
stop, and the shop needs the merchant to re-consent. Webhook capture is
unaffected (it uses HMAC, not the offline token), so the recorder keeps
capturing — but reconciliation for that shop is paused, weakening gap detection.

### Signals
- `ShopCredential.status = "reauthorization_required"` for the shop (counted in
  `ops.snapshot` `reauthorization.shops`).
- Reconcile skips or errors for that shop; its `reconcile:<shop>` checkpoint
  stops advancing → also shows as [stale reconciliation](./stale-reconciliation.md).
- **No token value ever appears in logs** — tokens are stored only as encrypted
  envelopes and are redaction-masked. Do not attempt to log or print a token to
  diagnose.

### Diagnose
1. Confirm it is genuinely a refresh failure vs. a never-bootstrapped credential.
   A shop that never exchanged an `id_token` has *no* credential (capture-only),
   not a `reauthorization_required` one.
2. Common causes: the merchant revoked/changed app permissions; the refresh token
   expired past its window; a Shopify-side auth change; or a
   `harper-secrets-custody-desync` breaking the credential decrypt/rotate path.
3. Check for a custody/decrypt failure specifically — if *many* shops flip to
   `reauthorization_required` at once, suspect secrets custody, not per-merchant
   consent.

### Remediate
- **Single shop, genuine reauth**: the fix is merchant-driven — they reopen the
  app / reinstall to re-consent, which runs `ensureCredential` and mints a fresh
  offline token. Surface this in-app on the Privacy/health screen (already
  designed to show reauthorization state); no operator token handling.
- **Mass reauth = custody desync**: this is an infra incident, not per-merchant.
  Re-initialize Harper secrets custody (Fabric-side) per
  `harper-secrets-custody-desync`, then confirm credentials decrypt and
  `reauthorization.shops` drops.

### Verify recovery
The shop's `ShopCredential.status` returns to `active`, reconcile resumes, and its
checkpoint advances.

### Escalate
Suspected secret/custody compromise → security owner. Never work around a failed
refresh by disabling HMAC or widening scopes.
