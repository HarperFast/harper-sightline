# Sightline — Reliability, Load, Retention & Recovery Report (issue #24)

- Date: 2026-08-05
- Scope: the free-MVP recorder. Proves correctness/capacity/deletion/recovery behavior.
- Split: **correctness invariants and capacity are proven locally** by `app/test/reliability.test.ts`; the **production-like gates** (10-minute 100 rps burst, encrypted backup + restore) run against the **staged environment under #25** using the tools committed here.

## 1. Gates (plan §13) and status

| Gate | Target | Status | Evidence |
|---|---|---|---|
| Webhook ack latency | p95 < 1s, always < 5s (Shopify timeout) | Tool committed; run at staged (#25) | `scripts/loadtest.mjs` (`npm run loadtest`) |
| 10-min 100 rps burst, no loss | 0 rejected deliveries **and** the backlog drains back to baseline with no new dead letters | Tool committed; run at staged (#25) | `scripts/loadtest.mjs` — ack percentiles **plus** a drain phase polling `/api/v1/ops` |
| Processing keeps up with ingest | observed drain rate ≥ offered rate | Tool committed; **expected to be the binding constraint** — see §5.1 | `scripts/loadtest.mjs` reports drain rate vs offered rate |
| No loss + catch-up after restart | every accepted delivery eventually processed | **PASS (local)** | `reliability.test.ts` restart + idempotent-redelivery cases |
| High-volume 7-day query latency, bounded memory | p95 < 500ms, memory-bounded | **PASS (local)**, staged confirm at #25 | `reliability.test.ts` — page clamped to `MAX_LIMIT`, not the whole ledger |
| 7-day purge at volume | expired physically removed, 0 residue | **PASS (local)** | `reliability.test.ts` purge case; `retention.test.ts` |
| Encrypted backup + restore | backup encrypted, restore verified | Procedure below; run at staged (#25) | §4 |

The "run at staged" gates need real Fabric infra (a deployed URL for load, a managed backup for restore); they cannot be exercised in unit CI. The harness + procedure are committed so #25 executes them deterministically and records the numbers back here.

## 2. Local results (`npm test`)

`app/test/reliability.test.ts` (representative local run, dev laptop):

- **Restart / no loss:** 500 deliveries, first worker crashes mid-drain, a fresh worker resumes from the durable inbox → all 500 processed, exactly one ledger write each. **No loss, correct catch-up.**
- **Crash between handle and status write:** a redelivered row is handled more than once (at-least-once) but produces exactly one ledger write (deterministic key → idempotent). Confirms the at-least-once + exactly-once-effect design.
- **High-volume query:** 20,000 in-window events, single page returns `MAX_LIMIT` rows (never the full ledger) with a `nextCursor`, in ~30ms locally — bounded memory + fast.
- **High-volume summary:** 10,000 events counted correctly in ~15ms.
- **Purge at volume:** 8,000 expired + 5,000 fresh → 8,000 deleted, 0 residue, exactly the fresh rows remain, ~17ms.

These are correctness-at-volume proofs; absolute timings are informational (they vary by machine). The staged run under #25 records the authoritative p95s on the target cluster shape.

## 3. Load harness usage (staged)

```
SIGHTLINE_BASE=https://<staging-host> \
SHOPIFY_API_SECRET=<app secret> SIGHTLINE_OPS_TOKEN=<ops token> \
LOAD_RPS=100 LOAD_DURATION=600 \
NODE_TLS_REJECT_UNAUTHORIZED=0 npm run loadtest
```

Fires HMAC-signed webhooks at `/webhooks/shopify/events`, reports ack p50/p95/max and per-status counts, then **waits for the accepted backlog to return to its pre-burst level**, reporting the drain time and the observed drain rate. Exits non-zero if any gate fails.

The drain phase is the point. Acking fast is exactly what the design guarantees by deferring all work to the worker (ADR-002), so an ack-only harness cannot fail for the reason that matters: before this, `LOAD PASS` printed on a run where every delivery was accepted and none was ever processed. Verifying drain no longer requires reading `ops.snapshot` by hand — `/api/v1/ops` serves the same `computeOpsHealth` object over HTTP, gated on `SIGHTLINE_OPS_TOKEN`, and because it reads replicated tables rather than one node's log it reports the whole cluster's backlog. The harness **refuses to run** without that token rather than falling back to the ack-only measurement it used to over-trust.

## 4. Backup & restore procedure (run at staged, #25)

Backup/restore is a Fabric-managed operation; this records the procedure and the acceptance the staged run must meet.

1. **Backup:** trigger the Fabric/Harper backup of the `sightline_core` + `sightline_ledger` databases. Confirm the backup artifact is **encrypted at rest** (deployment secret management) — inherits the at-rest guarantees in the [security review §4](./security-review.md).
2. **Restore drill:** restore into a clean production-like instance. Verify:
   - `/api/v1/health` returns `{ok:true}` and `scripts/smoke.mjs` passes.
   - A known shop's `OrderProjection` / `GapFinding` rows are present and match pre-backup counts.
   - **No token plaintext** is present — `ShopCredential` rows remain encrypted envelopes; the restored instance needs the same `SIGHTLINE_TOKEN_KEY` to decrypt (a restore to a new key intentionally cannot read old tokens → shops re-bootstrap).
   - The 7-day purge runs post-restore and re-establishes the retention boundary.
3. **Record** the backup size, restore duration, and verification results back into this report.

Recovery interplay: because capture is durable and reconciliation backfills from the Admin API, a restore that loses a small recent window self-heals on the next reconcile sweep (see the [deployment-rollback](./runbooks/deployment-rollback.md) and [shopify-outage](./runbooks/shopify-outage.md) runbooks).

## 5. Capacity assumptions

- **Retention bounds storage:** all ledger tables are 7-day, physically purged hourly (`MAX_DELETES_PER_RUN` = 10,000/table/run; multiple runs drain a larger backlog). Steady-state storage ≈ 7 days of a shop's order/fulfillment/inventory/refund events.
- **High-volume inventory is the watched cost** (plan §13/§17): `inventory_levels/update` can be voluminous. Monitored via the `ops.snapshot` event counts; if it dominates, an ingest filter or shorter inventory retention is the lever (extension seam, not MVP).
- **Query memory is bounded** by cursor pagination (`MAX_LIMIT` per page, keyset over a small over-fetch buffer) — a large ledger never materializes in one response. Aggregates (`summary`/`flows`) iterate the shop's window; acceptable at MVP volumes, revisit with the staged high-volume fixture.
- **Ingress is O(1) per webhook** before ack (verify HMAC, idempotent insert, fast 2xx); normalization is deferred to the worker, keeping ack latency flat under burst.

### 5.1 Ingest and drain capacity are not matched (open question for #25)

Ack capacity and drain capacity are set by different things, and the gap is large enough that the staged burst is really a test of the second:

- `processAcceptedBatch` takes **50 rows per tick** (`src/processor.ts`) on a **10-second** interval (`INTERVAL_MS`, `jobs.ts`) — about **5 deliveries/second per worker thread**. The loop runs on every worker thread on every node (jobs.ts is imported per thread, and the work is idempotent so concurrent ticks are safe), so aggregate throughput is roughly `5/s × threads × nodes`.
- A 10-minute 100 rps burst offers **60,000 deliveries**. Draining that needs ~12,000 thread-seconds at the rate above, so unless the target cluster has ~20 worker threads participating, the backlog grows for the whole burst and drains long after it ends.

This is not a defect on its own — the backlog is durable, ordering is not required, and `BACKLOG_STALE_MS` already alerts when the oldest unprocessed delivery exceeds 5 minutes. But it does mean **100 rps sustained is an ingest figure, not a throughput figure**, and the honest gate is the drain rate the harness now reports. If the staged run fails `drain>=offered`, the levers in order of bluntness are: raise the batch limit, shorten the interval, or accept a documented drain lag with the backlog alert as the safety net. Pick one against a real measurement rather than in advance.

## 6. Open items (→ #25)

- Execute the 10-min 100 rps burst on staging; record p95/max/loss here.
- Execute the encrypted backup + restore drill; record size/duration/verification here.
- Confirm high-volume query p95 < 500ms on the target cluster shape with a seeded 7-day fixture.
