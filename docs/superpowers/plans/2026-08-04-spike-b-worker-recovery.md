# Spike B — Durable Worker Recovery & Single-Active Leadership — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Prove that Harper v5.2.0 gives us durable background processing that (a) resumes accepted-but-unprocessed work after a worker restart, and (b) never double-processes under multiple/clustered workers.

**Architecture:** A durable `inbox` table holds accepted deliveries. Processing a delivery = an **atomic single-winner insert** into a `result` table keyed by the delivery id (reusing Spike A's proven primitive) — this makes processing exactly-once regardless of worker count. "Unprocessed" = inbox rows with no matching result. A restarted worker's startup scan reprocesses them. An optional `worker_lease` (atomic claim + TTL) gives single-active *scheduling* efficiency, but correctness does not depend on it. Worker logic is unit-tested in-memory; durability/concurrency is proven live against the Fabric instance via killable Node workers driving the ops API.

**Tech Stack:** Harper 5.2.0 (Fabric, driven via operations API), Node 24.18.0, `node:test`, global `fetch`. Zero dependencies.

**Spec:** [Phase 0 spec](../specs/2026-08-04-phase-0-risk-retirement-design.md) Spike B; builds on [ADR-001](../../adr/ADR-001-authentication.md)'s atomic-claim finding.

## Global Constraints

- Throwaway evidence under `spikes/worker/`; not the production scaffold.
- TypeStrip TS: erasable syntax, `.ts` import extensions, named exports, tabs, semicolons, `node:` builtins. Tests via `node --test 'test/*.test.ts'`.
- Zero third-party dependencies.
- Live scripts read Harper creds from env (`HARPER_OPS_URL`, `HARPER_USER`, `HARPER_PASS`); nothing secret is committed. Use a throwaway database `spikeb`; drop tables on cleanup.
- Errors: descriptive; never log payloads/secrets.

---

### Task 1: Durable model + ops-API helper

**Files:**
- Create: `spikes/worker/src/harperOps.ts` (thin ops-API client: `op(body)`, `sql(text)`, `createTable`, `dropTable`, `insert`, `find`)
- Create: `spikes/worker/README.md` (the model + how to run)
- Create: `spikes/worker/package.json`, `spikes/worker/dependencies.md`

**Interfaces:**
- Produces: `function makeOps(cfg: { url: string; user: string; pass: string }): Ops` where `Ops` has `op`, `sql`, `insert(db,table,records)`, `find(db,table,conds)`, `createTable(db,table,pk)`, `dropTable(db,table)`.
- Model (documented in README): `inbox { id (pk), payload, receivedAt }`; `result { id (pk = inbox id), processedBy, processedAt }`. Processing D = `insert result {id:D}`; single-winner insert ⇒ exactly-once. Unprocessed = inbox ids with no result row.

- [ ] **Step 1: Write `harperOps.ts`** — a fetch wrapper posting to the ops API with basic auth, `NODE_TLS_REJECT_UNAUTHORIZED` left to the caller/env. Methods return parsed JSON. (Concrete code mirrors `spikes/auth/live/atomicClaim.mjs`'s `op()` but typed and reusable.)
- [ ] **Step 2: Smoke it** — a throwaway script/inline call that runs `system_information` and prints the version; confirm 200. Run: `HARPER_OPS_URL=... node -e "..."`.
- [ ] **Step 3: Commit** — `git commit -m "spike(worker): ops-API helper + durable inbox/result model"`

---

### Task 2: Worker logic (pure) + unit tests

The core algorithm, independent of Harper: scan unprocessed, atomically claim+process each, idempotent on retry.

**Files:**
- Create: `spikes/worker/src/processInbox.ts`
- Create: `spikes/worker/test/processInbox.test.ts`

**Interfaces:**
- Produces: `type Store = { listUnprocessed(): Promise<string[]>; claimResult(id: string, by: string): Promise<boolean>; }` (`claimResult` = atomic single-winner insert; returns true iff this worker won).
- Produces: `function processInbox(by: string, store: Store): Promise<{ processed: string[]; skipped: string[] }>`

- [ ] **Step 1: Write the failing tests** — with an in-memory `Store` whose `claimResult` allows exactly one winner per id:
```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processInbox } from '../src/processInbox.ts';

function memStore(ids: string[]) {
	const results = new Map<string, string>();
	return {
		claimed: results,
		async listUnprocessed() { return ids.filter((i) => !results.has(i)); },
		async claimResult(id: string, by: string) {
			if (results.has(id)) return false;
			results.set(id, by);
			return true;
		},
	};
}

test('processes every unprocessed item exactly once', async () => {
	const s = memStore(['a', 'b', 'c']);
	const r = await processInbox('w1', s);
	assert.deepEqual(r.processed.sort(), ['a', 'b', 'c']);
	assert.equal(s.claimed.size, 3);
});

test('is a no-op when everything is already processed (idempotent restart)', async () => {
	const s = memStore(['a']);
	await processInbox('w1', s);
	const again = await processInbox('w1', s);
	assert.deepEqual(again.processed, []);
});

test('two concurrent workers never double-process', async () => {
	const s = memStore(['a', 'b', 'c', 'd']);
	const [r1, r2] = await Promise.all([processInbox('w1', s), processInbox('w2', s)]);
	const all = [...r1.processed, ...r2.processed].sort();
	assert.deepEqual(all, ['a', 'b', 'c', 'd']); // each exactly once across both
	assert.equal(s.claimed.size, 4);
});
```
- [ ] **Step 2: Run — expect FAIL** (module missing). `node --test 'test/processInbox.test.ts'`
- [ ] **Step 3: Implement**:
```typescript
export type Store = {
	listUnprocessed(): Promise<string[]>;
	claimResult(id: string, by: string): Promise<boolean>;
};

export async function processInbox(
	by: string,
	store: Store,
): Promise<{ processed: string[]; skipped: string[] }> {
	const processed: string[] = [];
	const skipped: string[] = [];
	for (const id of await store.listUnprocessed()) {
		const won = await store.claimResult(id, by);
		if (won) processed.push(id);
		else skipped.push(id);
	}
	return { processed, skipped };
}
```
- [ ] **Step 4: Run — expect PASS** (3 tests).
- [ ] **Step 5: Commit** — `git commit -m "spike(worker): exactly-once processInbox logic + tests"`

---

### Task 3: Live durability — restart recovery

Faithful test of "does a restarted worker resume from durable Harper state?": Harper holds the durable inbox; the killable Node worker is the process that restarts.

**Files:**
- Create: `spikes/worker/live/seed.mjs` (create `spikeb` db + `inbox`/`result` tables; insert N inbox rows)
- Create: `spikes/worker/live/worker.mjs` (one pass of `processInbox` against Harper, with `CRASH_AFTER=k` env to exit(1) after k claims)
- Create: `spikes/worker/live/verify.mjs` (assert every inbox id has exactly one result; print counts; drop tables)

**Interfaces:** Harper-backed `Store`: `listUnprocessed` = `SELECT id FROM spikeb.inbox WHERE id NOT IN (SELECT id FROM spikeb.result)`; `claimResult` = `insert result {id}` and return whether `inserted_hashes` contains the id.

- [ ] **Step 1: Implement `seed.mjs`** — create db/tables (`create_table` primary_key `id`), insert N=50 inbox rows `{id:"d-0"...}`. Print "seeded 50".
- [ ] **Step 2: Implement `worker.mjs`** — build the Harper `Store`, run `processInbox('wX', store)`; if `process.env.CRASH_AFTER` set, wrap `claimResult` to `process.exit(1)` after that many successful claims (simulate mid-run crash).
- [ ] **Step 3: Implement `verify.mjs`** — `SELECT COUNT(*) FROM spikeb.result`, and assert no inbox id lacks a result and no id has >1 result (PK guarantees ≤1; check == N). Exit non-zero on mismatch.
- [ ] **Step 4: Run the recovery scenario** (documented in README):
```bash
node seed.mjs                       # 50 accepted
CRASH_AFTER=20 node worker.mjs || true   # crashes after ~20 processed
node worker.mjs                     # restart: processes the remaining ~30
node verify.mjs                     # expect 50 results, exactly one each
```
Expected: `verify` prints `results=50 unprocessed=0 duplicates=0  PASS`.
- [ ] **Step 5: Commit** — `git commit -m "spike(worker): live restart-recovery proof (crash mid-run, resume, exactly-once)"`

---

### Task 4: Live single-active — no double-processing under concurrent workers

**Files:**
- Modify: `spikes/worker/live/verify.mjs` (reuse)
- Create: `spikes/worker/live/concurrent.mjs` (spawn K worker passes concurrently over the same inbox)

- [ ] **Step 1: Implement `concurrent.mjs`** — seed N rows, then `Promise.all` of K=4 `processInbox` passes (distinct `by` ids) against the same Harper tables; collect each pass's processed count.
- [ ] **Step 2: Run** — expect: sum of processed across the 4 workers == N, and `result` row count == N (each row exactly one winner; `skipped` accounts for the rest). Print per-worker winner counts.
- [ ] **Step 3: Verify + cleanup** — `verify.mjs` asserts `results==N, duplicates=0`, then drops tables.
- [ ] **Step 4: Commit** — `git commit -m "spike(worker): live concurrent-workers proof (exactly-once across 4 workers)"`

---

### Task 5: Lease for single-active scheduling (efficiency) — demonstrate + document

Correctness comes from Task 3/4 (per-item atomic claim). This shows the *scheduling* lease that stops N workers from all polling, and that a crashed lease-holder is superseded after TTL.

**Files:**
- Create: `spikes/worker/live/lease.mjs`
- Create: `spikes/worker/src/lease.ts` + `spikes/worker/test/lease.test.ts` (pure lease logic: acquire if free/expired, renew, release)

**Interfaces:** `type LeaseStore = { tryAcquire(holder, now, ttlMs): Promise<boolean>; }` backed live by atomic insert of a `lease` row keyed `"worker"`, with an `expiresAt`; acquisition when absent, or (via delete+insert) when `now > expiresAt`.

- [ ] **Step 1: Unit test** — free lease acquired by one of two contenders (exactly one true); an unexpired lease blocks others; an expired lease is re-acquirable. Write test, run FAIL.
- [ ] **Step 2: Implement `lease.ts`**, run PASS.
- [ ] **Step 3: Live `lease.mjs`** — two contenders call acquire concurrently against Harper (atomic insert on key `"worker"`): exactly one wins; after TTL expiry a new holder can take over. Print outcome; drop table.
- [ ] **Step 4: Commit** — `git commit -m "spike(worker): single-active lease (atomic claim + TTL) unit + live"`

---

### Task 6: Confirm Harper background-execution model + record findings

**Files:**
- Create: `spikes/worker/RUNTIME-NOTES.md`

- [ ] **Step 1: Record confirmed facts** — `handleApplication(scope)` runs on **every** worker thread (→ distributed lock required for single-active; we use the atomic-claim lease); polling used in the spike; `subscribe()` real-time (requires audit log) is the prompt-processing optimization deferred to the scaffold; the two-node replication observed on the instance means single-active is a cluster concern, satisfied by the atomic primitive being cluster-wide (proven: replicated deploys + single-winner inserts).
- [ ] **Step 2: Commit** — `git commit -m "spike(worker): record Harper background-execution + subscription findings"`

---

### Task 7: Write ADR-002

**Files:**
- Create: `docs/adr/ADR-002-worker-lease-scheduling.md`
- Modify: `docs/superpowers/specs/2026-08-04-phase-0-risk-retirement-design.md` (check Spike B boxes)

- [ ] **Step 1: Write ADR-002** — decisions: durable `inbox` + per-item **atomic single-winner insert** ⇒ exactly-once processing independent of worker/node count; startup recovery scan for unprocessed; optional lease for single-active scheduling efficiency + crashed-holder TTL takeover; polling now, `subscribe()` (audit-log) later; `handleApplication` per-thread caveat. Evidence: unit tests + live proofs (restart recovery, 4-worker concurrency, lease). Constraints for the scaffold (issue #8 durable processing / #9 dead-letter): claims must carry a TTL so a crashed in-flight claim is reclaimable; dead-letter = inbox rows whose processing has failed K times (track attempt count).
- [ ] **Step 2: Check Spike B boxes** in the Phase 0 spec, referencing ADR-002.
- [ ] **Step 3: Commit** — `git commit -m "docs(adr): ADR-002 worker lease/scheduling — Spike B complete"`

---

## Self-Review

**Spec coverage (Spike B):** durable subscriber resumes after restart → Task 3 ✓; no double-process under multiple workers → Task 2 (unit) + Task 4 (live) ✓; leases prevent duplicate active workers → Task 5 ✓; confirm Harper scheduling/leader pattern → Task 6 ✓; ADR-002 → Task 7 ✓.

**Placeholder scan:** pure-logic tasks have full code; live tasks specify exact ops (`create_table`, `insert`, the `NOT IN` unprocessed query, PK-insert claim) and exact run scenarios — no "handle errors" hand-waving.

**Type consistency:** `Store.claimResult`/`listUnprocessed`, `processInbox(by, store)`, `LeaseStore.tryAcquire` are used identically in tests, implementations, and live backers. The `result` table PK = inbox id is the single source of the exactly-once guarantee across all tasks.

**Known adaptation point (not a placeholder):** the exact Harper `sql` support for the `NOT IN (subquery)` unprocessed query is confirmed in Task 1/3; if unsupported, fall back to fetching processed ids and diffing in the worker (same `Store` interface, no downstream change).
