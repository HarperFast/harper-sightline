# Runbook: retention purge failure / residue

**Owner:** Sightline on-call → data/privacy owner

### Alert
- `event="purge.residue"` warn line (expired rows still present after a run), or
- `purge.failure` / `purge.error` counters rising.

### Why it matters
Sightline promises a **7-day retention** window with physical deletion (ADR-003);
the plan explicitly warns not to equate cache staleness with legal deletion. An
hourly purge job (`app/jobs.ts` `startPurgeLoop`, backed by
`app/src/retention.ts`) deletes rows older than the window across the ledger
tables. Residue (expired rows still present after a run) or repeated failures mean
the deletion guarantee — a compliance commitment — is not being met.

### Signals
- `purge.tick` lines with `deleted` counts (healthy purges).
- `purge.residue` warn: `{residue: N}` expired rows remained after a run.
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
   transient delete failure that the next hourly run clears) from **hard failure**
   (`purge.error` — the job could not run at all).
3. Correlate with recent deploys: a `harper-fabric-sealed-column-add-flaky` schema
   flake can disrupt a table's operations; verify with `describe_table`.

### Remediate
- **Transient residue**: the purge is idempotent and runs hourly; confirm the next
  run clears residue to 0. If it does, log and close.
- **Persistent residue / hard failure**: fix the underlying table/schema issue,
  then trigger a purge without waiting an hour — redeploy (the loop runs a purge
  ~30 s after boot) or invoke `runPurge()` via an operations action. Because purge
  is idempotent, a manual run is safe alongside the scheduled one.
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
