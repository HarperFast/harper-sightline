# Runbook: webhook rejection & processing backlog

**Owner:** Sightline on-call → Harper Fabric on-call (infra) / security owner (HMAC)

Covers two related conditions on the ingress path: a **processing backlog**
(deliveries accepted but not draining) and an **HMAC rejection spike** (deliveries
being refused at the door).

---

## Backlog: accepted deliveries not draining

### Alert
- `ops.snapshot` health `backlog.oldestAgeMs > BACKLOG_STALE_MS` (5 min), or
- `backlog.accepted` climbing across snapshots, or
- `process.error` counter rising.

### Why it matters
Ingress accepts fast and a worker normalizes later (ADR-002). A growing backlog
means the worker is stalled or erroring — capture still succeeds (no data loss;
rows are durable in `WebhookDelivery` as `accepted`), but the ledger, projections,
and detector fall behind, so the merchant UI goes stale.

### Signals
- `event="process.error"` lines (worker exceptions), with `message`.
- `process.processed` flat while `webhook.accepted` keeps rising.
- `ops.snapshot` `backlog.accepted` / `backlog.oldestAgeMs` trend.
- **Counts are floors when capped.** The backlog scan stops at 10,000 rows
  (`BACKLOG_COUNT_LIMIT`) and sets `backlog.capped: true`. `backlog.accepted` then
  reads 10,000 however large the backlog is, so "climbing" stops being visible above
  it: watch `backlog.oldestAgeMs` and `process.processed` instead. The stale check
  stays exact when capped (a direct query for an accepted row older than 5 min), and
  `oldestAgeMs` is then the age of a stale row it found, a floor on the true oldest.

### Diagnose
1. Read recent `process.error` lines — a repeating `message` points at the failing
   dependency (table unavailable, schema flake, normalizer bug).
2. Check whether the `sightline-process` scheduler job is running at all:
   `process.tick` lines should appear whenever there is work, and the
   `system.hdb_scheduler_state` row `job:<component>:sightline-process` carries
   its `lastRunAt` / `lastStatus`. No `ops.snapshot` lines either = no scheduler
   leader; failover takes 4-6.25 minutes (heartbeat 60 s, stale after 5 min, watcher 75 s), after which the backlog drains.
3. Confirm the deliveries are genuinely `accepted` (not `dead_letter`) — a
   backlog of `accepted` rows retries; see [dead-letters](./dead-letters.md) if
   they are dead-lettering instead.

### Remediate
- **Transient dependency error** (DB blip, schema flake per
  `harper-fabric-sealed-column-add-flaky`): the pipeline retries automatically
  (`MAX_ATTEMPTS`), so recovery is usually just waiting for the dependency to
  heal. Each occurrence stops after 50 failed rows, so a sustained outage
  dead-letters at most 50 deliveries per `MAX_ATTEMPTS` occurrences (~50s). Verify the table with `describe_table` after any recent schema deploy.
- **Worker not running**: redeploy / restart the component so the scheduler
  re-registers `sightline-process`. Processing is idempotent (only `accepted`
  rows are listed; downstream writes are deterministically keyed), so a restart
  cannot double-process.
- **`process.keyless_skipped` above zero**: the drain is passing over accepted rows
  that hold no `id` or `shopId`. Such a row was written by a patch over a delivery
  that `shop/redact` had just deleted, before patches carried the key (Harper stores
  only the patched fields). It costs one read per lap and blocks nothing. It cannot
  be removed through the ops API: SQL `DELETE` reports it as a skipped hash because
  no key is stored (seen on Harper 5.3.3). Escalate to Harper Fabric on-call if the
  count grows.
- **Persistent normalizer bug**: the offending deliveries will dead-letter after
  `MAX_ATTEMPTS`; fix forward and reprocess is out of scope for MVP (dead-letter
  is the visible terminal state). Escalate to the normalizer owner.

### Verify recovery
`backlog.oldestAgeMs` falls back under threshold and `process.processed` advances
on the next `ops.snapshot`.

---

## HMAC rejection spike {#hmac-rejection-spike}

### Alert
`webhook.signature_fail` counter spiking (elevated 401s on `/webhooks/shopify/events`).
Counters are per worker thread and `ops.snapshot` shows the leader thread only, so a
spike may be larger than the snapshot shows; the 401 rate in access logs is the
instance-wide signal. (Renamed from `webhook.hmac_fail`, which the log redactor
printed as `[redacted]`.)

### Why it matters
Every delivery is HMAC-verified over the raw body before parsing; a failure 401s
with **no mutation**. A spike means either a secret mismatch (we reject *real*
Shopify traffic → silent capture loss) or someone is probing the endpoint.

### Diagnose
1. **Secret mismatch** is the dangerous case. Did the Shopify app secret rotate
   without `readShopifySecret` picking up the new value? Cross-check the deployed
   secret against the Shopify Partner dashboard. Note the standing
   `harper-secrets-custody-desync` risk — a custody desync can make secret reads
   fail.
2. **Probing / malformed senders**: failures with no matching legitimate topic,
   from unexpected sources, are noise — confirm real Shopify deliveries still
   succeed (`webhook.accepted` still advancing).

### Remediate
- Secret mismatch: restore/rotate the correct Shopify secret and confirm custody
  is initialized (see the secrets-custody runbook context). Once fixed,
  `webhook.signature_fail` returns to baseline and `webhook.accepted` resumes.
- Missed deliveries during the mismatch window are recovered by reconciliation
  (the Admin API sweep backfills order state independently of webhooks) — confirm
  reconciliation is healthy ([stale-reconciliation](./stale-reconciliation.md)).

### Escalate
Suspected secret exposure or a deliberate attack → security owner immediately;
do not rotate secrets in a way that widens the capture-loss window without
coordinating.
