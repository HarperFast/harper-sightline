# Runbook: stale reconciliation

**Owner:** Sightline on-call → Harper Fabric on-call (infra) / token-refresh (see below)

### Alert
- `ops.snapshot` health `reconciliation.staleShops > 0`
  (`RECONCILE_STALE_MS` = 30 min with no successful pass), or
- `reconcile.error` counter rising.

### Why it matters
Reconciliation is the safety net for Shopify's at-least-once, no-ordering,
no-re-delivery webhooks: an incremental Admin API sweep (every 10 min) backfills
order state that webhooks never delivered. If it stalls, missed webhooks are no
longer caught, so gaps can be missed or findings can linger unresolved. Freshness
is tracked per shop by the `reconcile:<shop>` `WorkerCheckpoint.updatedAt`.

### Signals
- `event="reconcile.error"` lines with `message`.
- `reconcile.tick` lines absent for a shop that has orders.
- `ops.snapshot` `reconciliation.stalestAgeMs` climbing.
- Merchant Privacy/health screen shows a stale "last reconciled" state.

### Diagnose
1. **No credential** — reconcile skips a shop with no offline Admin token
   (capture-only). This is expected right after install until the merchant
   reloads the embed to bootstrap the token (`ensureCredential`). Not an incident
   unless it persists; if the credential should exist, go to
   [token-refresh-failure](./token-refresh-failure.md).
2. **Token invalid / refresh failed** — `reconcile.error` with an auth-shaped
   message, and/or `reauthorization.shops > 0`. → token-refresh runbook.
3. **Shopify throttling / API errors** — `reconcile.error` mentioning throttle or
   GraphQL cost. The sweep is throttle-aware and paces itself; a short spike is
   self-correcting.
4. **Worker not running / checkpoint not advancing** — `reconcile.tick` silent
   across snapshots even with active shops → worker stalled (see
   [webhook-backlog](./webhook-backlog.md) "worker not running").
5. **Widespread across all shops** — likely a Shopify outage
   ([shopify-outage](./shopify-outage.md)), not a per-shop issue.

### Remediate
- Throttle/transient: no action; confirm `stalestAgeMs` recovers on the next
  sweep. The cursor never advances past committed work, so a mid-sweep failure
  safely resumes — no gap or double-count.
- Worker stalled: redeploy/restart the component (reconcile is idempotent; the
  durable `updated_at` checkpoint means a restart resumes, not restarts, the
  cursor).
- Auth: follow token-refresh-failure.

### Verify recovery
`reconciliation.staleShops` returns to 0 and `reconcile.tick` resumes advancing
the checkpoint for the affected shop(s).
