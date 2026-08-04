# Spike C — Retention & Physical Deletion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Determine whether Harper's TTL (`expiration`/`eviction`) physically deletes ledger data within the 7-day window, and prove a compliance-safe deletion mechanism. The plan must not equate cache staleness with legal deletion.

**Architecture:** Harper's `expiration`/`eviction` is **caching** semantics — expiration marks a record *stale* (re-fetch from source), eviction removes record data **but leaves secondary-index entries** and re-fetches on query. For Sightline's source-of-truth ledger there is no source to re-fetch, and index residue past the window is a compliance risk. So retention/deletion is done with an **explicit, observable purge** (SQL `DELETE` by age) — which removes data *and* index entries — plus targeted deletion for `shop/redact` / `customers/redact`. Spike C proves the purge live and characterizes TTL to justify not relying on it.

**Tech Stack:** Harper 5.2.0 (Fabric, ops API), Node 24, `node:test`. Zero deps. Reuses `spikes/worker/src/harperOps.ts` pattern.

**Spec:** [Phase 0 spec](../specs/2026-08-04-phase-0-risk-retirement-design.md) Spike C.

## Global Constraints

- Throwaway evidence under `spikes/retention/`; not the scaffold.
- TypeStrip TS; `node --test 'test/*.test.ts'`; zero deps.
- Live scripts take creds from env (`HARPER_OPS_URL/USER/PASS`); throwaway tables in `data`; dropped on cleanup.

---

### Task C1: Retention window + purge logic (pure) + tests

**Files:** `spikes/retention/src/retention.ts`, `spikes/retention/test/retention.test.ts`, `package.json`, `dependencies.md`

**Interfaces:**
- `function cutoffMs(nowMs: number, retentionDays: number): number` → `nowMs - retentionDays*86_400_000`
- `function purgeSql(db: string, table: string, tsField: string, cutoff: number): string` → `DELETE FROM db.table WHERE tsField < cutoff`
- `function isExpired(receivedAt: number, nowMs: number, retentionDays: number): boolean`

- [ ] **Step 1: Failing tests** — cutoff math (7 days → now-604800000); `isExpired` true just past window, false within; `purgeSql` shape.
```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutoffMs, purgeSql, isExpired } from '../src/retention.ts';

test('cutoff is now minus retention', () => {
	assert.equal(cutoffMs(604_800_000 * 2, 7), 604_800_000);
});
test('isExpired at the boundary', () => {
	const now = 1_000_000_000_000;
	assert.equal(isExpired(now - 7 * 86_400_000 - 1, now, 7), true);
	assert.equal(isExpired(now - 1, now, 7), false);
});
test('purgeSql targets rows older than cutoff', () => {
	assert.equal(purgeSql('data', 't', 'receivedAt', 42), "DELETE FROM data.t WHERE receivedAt < 42");
});
```
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement `retention.ts`.**
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `spike(retention): retention-window + purge logic + tests`

---

### Task C2: Live — explicit purge physically removes data AND index residue

**Files:** `spikes/retention/live/common.mjs`, `spikes/retention/live/purge.mjs`

- [ ] **Step 1: `common.mjs`** — build ops from env; `DB='data'`, `T='spikec_ledger'`; helpers to (re)create the table, insert, `sql`, `dropTable`.
- [ ] **Step 2: `purge.mjs`** — 
  - create `spikec_ledger`; insert rows with `{id, shopId, receivedAt}` — half with `receivedAt` older than the cutoff, half recent.
  - Confirm both age-groups are present via primary `get` and via attribute query `SELECT id FROM data.spikec_ledger WHERE shopId='s1'`.
  - Run purge: `ops.sql(purgeSql('data','spikec_ledger','receivedAt',cutoff))`.
  - Assert: old rows gone from `SELECT COUNT(*)`, gone from the attribute query, and `get` by an old id returns nothing; recent rows remain.
  - Print counts; `PASS`/`FAIL`; drop table.
- [ ] **Step 3: Run** — expect old rows fully removed (data + query paths), recent rows intact.
- [ ] **Step 4: Commit** — `spike(retention): live explicit-purge proof (DELETE removes data + index)`

---

### Task C3: Live — targeted compliance deletion (shop/customer redact), idempotent

**Files:** `spikes/retention/live/redact.mjs`

- [ ] **Step 1: `redact.mjs`** — seed rows for `shopId in {s1,s2}`; delete all `s1` rows via `DELETE FROM ... WHERE shopId='s1'`; assert s1 gone everywhere (count, attribute query, primary get), s2 intact; re-run the same delete and assert it is a safe no-op (idempotent). Drop table.
- [ ] **Step 2: Run** — expect s1 removed, s2 intact, second delete a no-op.
- [ ] **Step 3: Commit** — `spike(retention): live targeted redaction proof (idempotent)`

---

### Task C4: Live — characterize TTL/eviction (why we don't rely on it)

Deploy a short-TTL table (schema directive is the documented way to set TTL) and observe.

**Files:** `spikes/retention/ttl-probe/config.yaml`, `spikes/retention/ttl-probe/schema.graphql`, `spikes/retention/ttl-probe/deploy.mjs` (reuse the Spike A deploy/restart helper)

- [ ] **Step 1: Component** — `schema.graphql`:
```graphql
type SpikecTtl @table(expiration: 5, eviction: 0, scanInterval: 2) @export {
	id: ID @primaryKey
	shopId: String @indexed
	receivedAt: Int
}
```
`config.yaml`: `rest: true` + `graphqlSchema.files: './schema.graphql'`.
- [ ] **Step 2: Deploy + restart** to Fabric (project `spikec-ttl`), insert a few rows via ops (`insert data.SpikecTtl`... confirm DB name the schema creates — likely `spikec-ttl` component db or `data`; discover via `describe_all`).
- [ ] **Step 3: Probe over time** — immediately: `get`/attribute query return rows. After ~expiration+scanInterval (~10–15s): re-probe primary `get` and the `shopId`-indexed query; record exactly what remains (stale? gone? index entry without data?). This empirically confirms TTL is caching-oriented and not a reliable physical-deletion guarantee for a source-less ledger.
- [ ] **Step 4: Record + cleanup** — write observations to RUNTIME-NOTES; `drop_component` `spikec-ttl`.
- [ ] **Step 5: Commit** — `spike(retention): characterize Harper TTL/eviction (caching semantics)`

---

### Task C5: RUNTIME-NOTES + ADR-003

**Files:** `spikes/retention/RUNTIME-NOTES.md`, `docs/adr/ADR-003-retention-deletion.md`, spec box.

- [ ] **Step 1: RUNTIME-NOTES** — TTL semantics (documented + observed), purge proof results, redaction results, exact SQL/ops used.
- [ ] **Step 2: ADR-003** — decision: **explicit observable purge job (SQL DELETE by age) is the retention/deletion mechanism; TTL/eviction is not relied on for compliance** (caching semantics; index residue; source-refetch model). Targeted `DELETE WHERE shopId/customer` for redaction, idempotent. Constraints for scaffold (issue #10): purge runs on a schedule via the Spike B worker/lease, is observable (purge lag/failures metric), covers every ledger table + protected fields, and deletion is verified by re-query. Optionally use TTL as an efficiency hint only.
- [ ] **Step 3: Check Spike C box** in the Phase 0 spec.
- [ ] **Step 4: Commit** — `docs(adr): ADR-003 retention/deletion — Spike C complete`

---

## Self-Review

**Spec coverage (Spike C):** verify Harper expiration/eviction against indexed records → C4 ✓; explicit purge + physical removal → C2 ✓; compliance deletion targets shop/customer records idempotently → C3 ✓; ADR-003 → C5 ✓.

**Placeholder scan:** pure logic has full code; live tasks specify exact rows, queries, and assertions.

**Type consistency:** `cutoffMs`/`isExpired`/`purgeSql` used identically in tests and live scripts; `receivedAt`/`shopId` field names consistent across all tables.

**Known adaptation point:** the database name the TTL component's schema creates (component db vs `data`) is discovered via `describe_all` in C4 Step 2 before inserting — not assumed.
