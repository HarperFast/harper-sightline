# Runbook: retention purge failure / residue

**Owner:** Sightline on-call → data/privacy owner

### Alert
- `ops.snapshot` health `retention.overdueRows > 0`: rows more than 30 minutes
  (`RETENTION_OVERDUE_MS`) past their window, read from the tables, so it also
  fires when the purge is not running at all. `healthy` is false while it lasts, or
- `event="purge.residue"` warn line (expired rows still present after a run), or
- `purge.failure` / `purge.error` counters rising.

### Why it matters
Sightline promises a **7-day retention** window with physical deletion (ADR-003);
the plan explicitly warns not to equate cache staleness with legal deletion. A
5-minute purge job (the `sightline-purge` Harper scheduler job in
`app/config.yaml`, handled by `purgeJob` in `app/jobs.ts` and backed by
`app/src/retention/retention.ts`) deletes rows older than the window across the
ledger tables, in batches of 1,000 per table taken in turn, until every table is
clear or the run's 60 s budget is spent; a table the budget cut short carries its
residue into the next run without counting as a failure. It is **leader-coordinated**: one node runs each occurrence, so an
absence of `purge.tick` lines cluster-wide can mean the scheduler has no leader
rather than that the purge failed — check for `job.catchup` lines and the
`ops.snapshot` heartbeat before assuming a purge fault. There is no boot pass: the
scheduler does not fire a newly declared job on deploy, so the first pass after a
deploy comes up to 5 minutes later (longer if restarts keep re-anchoring it).
Residue (expired rows still present after a run, counted up to 10,000 per table) or repeated failures mean
the deletion guarantee — a compliance commitment — is not being met.

### Signals
- `purge.tick` lines with `deleted` counts (healthy purges).
- `purge.residue` warn: `{residue: N}` expired rows remained after a run. Right
  after a backlog this is lag: each run should lower it (on a laptop Harper 5.3.3,
  a 60 s run deleted 708k-754k rows). It is counted up to 10,000 per table, so
  10,000 is a floor. A residue that does not fall across runs means ingest
  outpaces the budget, or deletes are failing.
- `ops.snapshot` health `retention`: `{overdueRows, overdueTables}`, counted up to
  1,000 rows per table, so a large number is a floor.
- `purge.failures` warn: `{count, failures}` per-table failure reasons
  (table-name/error strings, redaction-capped — no row data).
- `purge.error`: the ledger purge threw.

The **digest outbox** is swept in the same tick but on its own 30-day cutoff and
inside its own try/catch, so one sweep failing never skips the other and its
failures are reported separately. Its signals mirror the ledger's:
- `purge.outbox` trace: `{deleted: N}` (healthy outbox purges).
- `purge.outbox.residue` warn: expired digests still present after a run.
- `purge.outbox.failures` warn: `{count, failures}`.
- `purge.outbox.error`: the outbox sweep threw.

Both sweeps feed the same `purge.deleted` / `purge.failure` counters, so a rising
counter says purge work happened or failed without saying which sweep — read the
log event name for that.

### Diagnose
1. Read the `purge.failures` line — `failures` names which table(s) failed and
   why (e.g. a delete rejected, an index issue, a schema flake after a deploy).
2. Distinguish **residue** (purge ran but some rows survived — usually a
   transient delete failure that the next run clears) from **hard failure**
   (`purge.error` — the job could not run at all).
3. Correlate with recent deploys: a `harper-fabric-sealed-column-add-flaky` schema
   flake can disrupt a table's operations; verify with `describe_table`.

### Remediate
- **Transient residue**: the purge is idempotent and runs every 5 minutes; confirm
  a later run clears residue to 0. If it does, log and close.
- **Persistent residue / hard failure**: fix the underlying table/schema issue,
  then let the next 5-minute occurrence run, or invoke `runPurge()` via an
  operations action. A redeploy does not run one sooner: there is no boot pass.
  Because purge is idempotent, a manual run is safe alongside the scheduled one.
- If a **specific compliance deletion** (shop/customer redaction) is what failed —
  not the time-based purge — see the compliance flow: redaction is idempotent and
  keyed, so re-running the `shop/redact` / `customers/redact` path is safe.

### Verify recovery
A subsequent `purge.tick` reports `residue` absent (no warn line) and
`ops.snapshot` health is not flagging expired data. For compliance-critical
incidents, spot-check that a known-expired row is physically gone (not just
unreadable) per the retention deletion-verification tests.

### Escalate
Any purge failure that leaves data past the 7-day boundary for a sustained period
is a **compliance incident** → data/privacy owner, and note it for the deletion-
verification evidence required at launch (#26).
