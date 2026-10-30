# ADR-003: Retention and physical deletion

- Status: **Accepted** (Spike C complete)
- Date: 2026-08-04
- Phase: 0 (risk retirement), GitHub issue #2 (retention portion) → issue #10
- Evidence: the throwaway `spikes/retention/` component — unit tests plus live purge, redaction, and TTL-characterization proofs, with findings in its `RUNTIME-NOTES.md`. Deleted after Phase 0; read it at `git show c9a4f5e:spikes/retention`. The decision below, and `app/src/retention/retention.ts`, are what carried forward.
- Runtime proven against: Harper **5.2.0** on Fabric, via the operations API

## Context

The MVP promises seven-day retention with real deletion of protected data, plus Shopify `shop/redact` / `customers/redact`. The plan explicitly warns: **do not equate cache staleness with legal deletion.** Spike C tested whether Harper's table TTL physically deletes.

## Findings

- Harper `@table(expiration/eviction/scanInterval)` is **caching** semantics: expiration marks a record *stale* (re-fetch from source); eviction removes record data **but leaves secondary-index entries** and re-fetches from source on query.
- On a **source-less** table (our ledger has no source), an expiring table **drops records almost immediately** — observed gone from all query paths by ~3s with `expiration:5`. And query-invisibility does **not** guarantee physical removal of index entries.

## Decision

### 1. Ledger tables do not use TTL
The operational ledger, projections, expectations, findings, and aggregates are **plain, non-expiring** tables. Putting `expiration` on them would lose data inside the retention window and would not guarantee deletion anyway.

### 2. Retention deletion is an explicit, observable purge job
A scheduled job issues real `DELETE ... WHERE <timestamp> < cutoff` per table. A real `DELETE` removes record data **and** secondary-index entries — the compliance-safe mechanism. Proven: age-purge removed old rows from count, attribute queries, and primary get, leaving recent rows intact.

### 3. Compliance redaction is targeted `DELETE`, idempotent
`shop/redact` / `customers/redact` are `DELETE ... WHERE shopId = ?` (and customer-linked keys), removing the tenant/subject everywhere; re-running is a safe no-op. Proven live.

### 4. Deletion is verified, not assumed
Retention/redaction jobs re-query after deleting to confirm zero residue; the plan's "verify physical deletion" requirement is met by DELETE + re-query, not by TTL.

## Consequences / constraints for the scaffold (issue #10)

- **Schedule the purge via the Spike B worker/lease** (single active runner, durable, restart-safe); it is idempotent and re-runnable.
- **Observable:** emit purge-lag and purge-failure metrics; alert on stalls (plan §13).
- **Coverage:** the purge must cover every ledger table and every protected field; a data-inventory test maps table/field → retention/deletion behavior.
- **Time fields:** GraphQL `Int` is 32-bit — store millisecond timestamps as `Float`/string/second-precision in schema-defined tables to avoid overflow.
- **TTL as efficiency only, if ever:** TTL/eviction may be considered later for genuine cache tables with a source; it is never the deletion guarantee for source-of-truth data.

## Alternatives considered

- **Rely on `@table(expiration)` for the 7-day window** — rejected: caching semantics, index residue, and (source-less) premature data loss. Fails both durability and the deletion guarantee.
- **Soft-delete flag** — rejected for compliance: the data (and index entries) physically remain; does not satisfy deletion.

## Open / deferred

- **Purge scheduling + metrics wiring** (issue #10): build on the Spike B worker/lease in the scaffold.
- **Backup retention:** ensure encrypted backups also age out within policy (issue #23) — out of Spike C scope.
