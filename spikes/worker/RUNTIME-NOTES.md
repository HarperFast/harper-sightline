# Spike B — Harper Worker/Recovery Runtime Notes

Confirmed against Harper 5.2.0 on Fabric (`ayoo.josh-test.harperfabric.com`, a 2-node replicated cluster), driven via the operations API.

## Background execution model

- A component's `handleApplication(scope)` startup hook runs on **every worker thread** (Harper Plugin API). There is no built-in "run once per cluster" hook. **Single-active therefore requires our own distributed lock** — satisfied by the atomic-claim lease (`src/lease.ts`, `live/lease.mjs`).
- The instance is a **2-node replicated cluster**; component deploys replicate (seen in Spike A). The atomicity primitive we rely on is cluster-wide: concurrent workers hitting the cluster still yield exactly one winner per key (proven: 4-worker race, `total=N`, 0 duplicates).

## Exactly-once mechanism (the core result)

- Durable model: `inbox { id pk }` + `result { id pk = inbox id }`.
- **Processing a delivery = a single-winner `insert` into `result` keyed by the inbox id.** `insert` returns `inserted_hashes` (won) / `skipped_hashes` (lost); the primary key makes this atomic. ⇒ **exactly-once regardless of worker or node count**, no lease required for correctness.
- **Unprocessed** = inbox ids with no `result` row (`SELECT id` from each table, diffed in the worker — used the diff form rather than `NOT IN` for portability). A restarted worker's startup scan reprocesses exactly those.

## Proven live

| Scenario | Result |
|---|---|
| Restart recovery (crash after 20 of 50, restart) | resumes remaining 30; `inbox=50 results=50 missing=0 duplicates=0` |
| 4 concurrent workers over 60 items | winners 42/17/1/0, `total=60`, 0 duplicates |
| Lease | one winner of two contenders; held lease blocks; post-TTL takeover |

## Prompt processing

- The spike **polls** (`listUnprocessed` scan) — sufficient to prove durability/recovery.
- Harper Resources have a built-in `subscribe()` for real-time change notification (requires the **audit log** enabled), which is the prompt-processing optimization for the scaffold — deferred (issue #8). Polling + a periodic reconciliation scan is the safe floor regardless.

## Ops-API surface used

`create_database`/`create_table`/`drop_table`, `insert` (atomic claim via `inserted_hashes`/`skipped_hashes`), `sql` (`SELECT`), `delete` (`ids: [...]`).

## Constraint for the scaffold (issues #8, #9)

The spike collapses **claim and completion into one atomic insert** — valid when the unit of work *is* a deterministic write (e.g. writing a normalization result keyed by delivery id). For work that spans time between claiming and finishing, claim first with a **TTL'd processing marker** (so a crashed in-flight claim is reclaimable), do the work, then finalize idempotently. **Dead-letter** = a delivery whose processing has failed K times (track an attempt count). See [[ADR-002]].
