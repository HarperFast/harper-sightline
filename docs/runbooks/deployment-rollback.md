# Runbook: deployment rollback

**Owner:** Sightline on-call → Harper Fabric on-call

### Alert
- Post-deploy smoke failure (`npm run smoke` / `scripts/smoke.mjs`), or
- `/api/v1/health` returning 404 or non-`{ok:true}`, or
- A spike in `process.error` / `reconcile.error` immediately following a deploy.

### Why it matters
A bad import or a broken resource can make the component **silently 404 all
routes while still reporting healthy at the process level** (ADR-001) — the app
looks up but serves nothing. Sightline is a parallel recorder, so a bad deploy
does not touch merchant operations, but it does stop capture/serving, and capture
gaps during the outage rely on reconciliation backfill afterward.

### Signals
- `Health` route (`/api/v1/health`) is the standing guard — smoke checks a live
  route after every deploy precisely because process-health can lie.
- Schema-changing deploys can hit `harper-fabric-sealed-column-add-flaky` (a newly
  added column silently dropped on an existing `@sealed` table).

### Diagnose
1. Run the smoke check against the deployed target. A 404 on a route that should
   exist = a resource/import failure in `resources.ts`.
2. For schema changes, run `describe_table` on the affected table(s) and confirm
   every expected column is present. `scripts/deploy.mjs` self-heals the known
   flake, but verify.
3. Read the first `*.error` lines after the deploy for the failing module.

### Remediate
- **Roll back to the previous known-good component version** (versioned deploys
  with tested rollback are a #25/#24 requirement; use the platform's version
  pinning to redeploy the prior release). Rollback is safe: all processing is
  idempotent and durable — `accepted` deliveries persist and reprocess, the
  reconcile cursor resumes, purge is idempotent. No data is lost by reverting.
- If the failure is a schema-flake (missing column), re-run the deploy
  (`deploy.mjs` re-adds the column) and re-verify with `describe_table` before
  declaring recovery.
- Capture missed during the outage: reconciliation backfills order state from the
  Admin API on its next sweep — confirm reconciliation is healthy afterward.

### Verify recovery
Smoke passes, `/api/v1/health` returns `{ok:true}`, `ops.snapshot` health is
`healthy`, and `webhook.accepted` / `process.processed` resume advancing.

### Escalate
Repeated deploy failures or an unrecoverable schema state → Harper Fabric on-call.
Do not leave the component in a silently-404ing state; roll back first, diagnose
second.
