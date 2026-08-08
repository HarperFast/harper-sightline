# Sightline operations runbooks

Incident runbooks for the free-MVP recorder (issue #22). Each runbook is
self-contained: alert condition → signals → diagnosis → remediation → escalation.

## How observability works

Sightline has no external metrics backend in the MVP. Instead:

- **Metrics** are an in-process tally (`app/src/observe.ts`, the `metrics`
  registry). Counters and latency summaries are cumulative for a worker's
  lifetime and carry **no merchant-identifying labels** (a metric is a bare
  name, never keyed by shop).
- **The `ops.snapshot` heartbeat** (`app/jobs.ts`, once a minute) derives an
  aggregate health view from tables — backlog age/count, dead-letter count,
  reconciliation staleness, reauthorization count — via
  `computeOpsHealth` (`app/src/opsHealth.ts`) and logs it together with the
  metrics tally as one structured line. When health is degraded the line is
  emitted at `warn`, so a log-based alert can key off
  `event="ops.snapshot"` with `level="warn"`.
- **Logs** are single structured lines: `[sightline] {"level","event",...}`.
  Every field is passed through a redaction guard (`redactFields`) that masks
  tokens, HMACs, secrets, raw payloads, and customer PII before the line is
  written. `trace` is the default level.

Until the staging log/metrics pipeline is stood up under **#25 (staged Fabric
deployment & CI/CD)**, "alerts" are queries over these log lines. The alert
conditions below name the exact metric/field to watch so they transfer directly
to whatever dashboarding the staging environment provides. Alert drills
(#22 acceptance) exercise each condition against staging and confirm the owner
below is paged.

## Alert → runbook → owner

| Alert condition (signal) | Runbook | Owner (primary → escalation) |
| --- | --- | --- |
| `ops.snapshot.health.deadLetter.count > 0`, or `process.dead_lettered` rising | [dead-letters](./dead-letters.md) | Sightline on-call → data/normalizer owner |
| `ops.snapshot.health.backlog.oldestAgeMs > 5m` (`BACKLOG_STALE_MS`), or `process.error` rising, or backlog count climbing | [webhook-backlog](./webhook-backlog.md) | Sightline on-call → Harper Fabric on-call |
| `webhook.hmac_fail` spiking, or elevated non-2xx on `/webhooks/shopify/events` | [webhook-backlog](./webhook-backlog.md#hmac-rejection-spike) | Sightline on-call → security owner |
| `ops.snapshot.health.reconciliation.staleShops > 0` (`RECONCILE_STALE_MS` 30m), or `reconcile.error` rising | [stale-reconciliation](./stale-reconciliation.md) | Sightline on-call → Harper Fabric on-call |
| `ops.snapshot.health.reauthorization.shops > 0`, or repeated `reconcile.error` for one shop | [token-refresh-failure](./token-refresh-failure.md) | Sightline on-call |
| `purge.residue` warn line, `purge.failure`/`purge.error` rising, or expired rows still present | [purge-failure](./purge-failure.md) | Sightline on-call → data/privacy owner |
| Failed deploy, health-probe 404, or post-deploy smoke failure | [deployment-rollback](./deployment-rollback.md) | Sightline on-call → Harper Fabric on-call |
| Shopify Admin API / webhook delivery outage (widespread `reconcile.error`, backlog with no ingress) | [shopify-outage](./shopify-outage.md) | Sightline on-call |
| `digest.error` rising, `tick.stalled` with `loop="digest"`, or `digest.build.subscription.failed` rising (esp. repeating for one `shopId`, which the per-shop isolation lets happen silently otherwise) — **not** a quiet shop's absent outbox row, which is expected behavior | [digest-not-building](./digest-not-building.md) | Sightline on-call |

> Owners are role-based. Map each role to a named person / PagerDuty schedule as
> part of staging cutover (#25) before App Store launch (#26).

## Product-truth reminder

Sightline observes Shopify; it never proves a downstream 3PL/ERP/carrier failed.
Incident comms and any operator-facing note must keep that boundary: a finding is
"no Shopify fulfillment confirmation observed," never "the warehouse failed."
