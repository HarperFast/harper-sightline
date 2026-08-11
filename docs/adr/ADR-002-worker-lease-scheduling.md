# ADR-002: Durable background processing, recovery, and single-active workers

- Status: **Accepted** (Spike B complete)
- Date: 2026-08-04
- Phase: 0 (risk retirement), GitHub issue #2 (worker portion)
- Evidence: the throwaway `spikes/worker/` component — 7 unit tests plus live restart-recovery, 4-worker concurrency, and lease proofs, with findings in its `RUNTIME-NOTES.md`. Deleted after Phase 0; read it at `git show 2bfe12b:spikes/worker`. The decision below, and `app/jobs.ts`, are what carried forward.
- Runtime proven against: Harper **5.2.0** on Fabric (2-node replicated cluster), via the operations API
- Builds on: [ADR-001](./ADR-001-authentication.md) atomic single-winner insert

## Context

Sightline captures webhooks into a durable inbox and processes them with background workers (normalize → project → detect). Two risks could invalidate the architecture: work lost on a worker restart, and the same work processed twice under multiple/clustered workers. Harper's `handleApplication` startup hook runs on **every worker thread** and the instance is a **replicated cluster**, so both risks are real and single-active is not free.

## Decision

### 1. Durable inbox + exactly-once via atomic single-winner insert
Accepted deliveries live in a durable `inbox` table. Processing a delivery is a **single-winner `insert` into a `result` table keyed by the delivery id** — the primary-key insert is atomic (ADR-001), so exactly one worker wins per delivery. Processing is therefore **exactly-once regardless of worker or node count**; correctness does **not** require a lease.

### 2. Recovery is a startup scan for unprocessed work
"Unprocessed" = inbox ids with no `result` row. On startup (and periodically), a worker scans for these and processes them. Proven: crash after 20 of 50 → restart resumes the remaining 30 → `missing=0, duplicates=0`.

### 3. A lease provides single-active *scheduling*, not correctness
An atomic-claim lease (unique insert on a fixed key, with a TTL) elects one active poller so N workers don't all scan at once; a crashed holder is superseded after its TTL. This is an efficiency layer over the exactly-once core. Proven: one winner of two contenders, held-lease blocks, post-TTL takeover.

### 4. Poll now, `subscribe()` later
The spike polls, which is sufficient and the safe floor. Harper Resources' real-time `subscribe()` (requires the audit log) is the prompt-processing optimization, deferred to the scaffold (issue #8). A periodic reconciliation scan is retained regardless, so no correctness depends on notifications.

## Consequences / constraints for the scaffold (issues #8, #9)

- **Claim vs completion:** the spike collapses both into one atomic insert (valid when the work *is* a deterministic keyed write). For work spanning time, claim first with a **TTL'd processing marker** (crashed in-flight claims become reclaimable after the TTL), do the work, then finalize idempotently.
- **Dead-letter:** a delivery whose processing fails K times moves to a visible dead-letter state; track an attempt count on the inbox row.
- **Single-active across the cluster:** rely on the atomic primitive being cluster-wide (proven); the lease is for efficiency and must carry a TTL so a dead holder is replaced.
- **No external queue:** Harper's durable tables + atomic insert + polling/subscribe cover the need; the plan's "no external queue" constraint holds.
- **Ordering:** processing must be order-independent (out-of-order-safe projections, issue #11) — the inbox gives no ordering guarantee and none is assumed here.

## Alternatives considered

- **Lease-gated single processor for correctness** — rejected as the *correctness* mechanism: it makes double-processing a lease bug rather than impossible. Per-item atomic claim is impossible to double-process by construction; the lease is kept only for scheduling efficiency.
- **External queue (SQS/Pub-Sub) for delivery** — rejected for MVP: Harper durable tables + atomic claim + polling/subscribe suffice; matches the plan's no-external-queue constraint.
- **In-memory timer/leader only** — rejected: no durability across restart, and `handleApplication` runs per-thread so an in-memory leader is not single-active.

## Open / deferred

- **`subscribe()` prompt processing** (issue #8): confirm the server-side subscription API + audit-log enablement when building the real pipeline.
- **TTL'd processing-marker + dead-letter attempt counting** (issues #8/#9): design in the scaffold; the primitives are proven here.
