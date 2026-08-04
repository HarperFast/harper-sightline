# Spike C — Retention/Deletion Runtime Notes

Confirmed against Harper 5.2.0 on Fabric, via the operations API.

## Harper TTL is caching, not compliance deletion

`@table(expiration, eviction, scanInterval)` (seconds):
- **expiration**: record becomes *stale*; the next request triggers a **fetch from source**. Stays queryable during revalidation.
- **eviction** (default 0): after expiration+eviction, record data is physically removed **but secondary-index entries remain**, and a matching query **re-fetches from source**.

This is designed for **caching tables that have a source**. Sightline's ledger is source-of-truth (no source to re-fetch), so:

**Observed (C4):** a source-less `@table(expiration:5, eviction:0, scanInterval:2)` with an `@indexed shopId`: `inserted 5` → at t=0s all present (`byId=1 byIndex=5 total=5`) → **by t=3s all query paths return 0**.

Two consequences:
1. **Do not put `expiration` on ledger tables** — a source-less expiring table drops records almost immediately (well inside the 7-day window). Ledger tables are plain (non-expiring).
2. **Query-invisibility ≠ physical/legal deletion** — per the docs, eviction leaves secondary-index entries physically. The ops API can't inspect on-disk residue, so we do not rely on TTL for the deletion guarantee.

## Explicit purge is the deletion mechanism (proven)

- **Age purge (C2):** `DELETE FROM data.t WHERE receivedAt < cutoff` on a plain table removed old rows from `COUNT`, attribute queries, and primary `get`; recent rows intact (total 20→10, oldRemaining=0).
- **Targeted redaction (C3):** `DELETE ... WHERE shopId='s1'` removed that tenant everywhere, left `s2` intact, and a re-run was a safe no-op (idempotent). Maps to `shop/redact` / `customers/redact` retry-safety.
- A real `DELETE` removes data **and** index entries (unlike eviction), which is why it is the compliance-safe path.

## Gotchas

- **GraphQL `Int` is 32-bit** (−2147483648..2147483647). Millisecond timestamps overflow it (`Value ... must be an integer`). Use `Float`, a string, or second-precision for time fields in schema-defined tables. (ops-`create_table` tables are schemaless and accept JS numbers directly.)
- Component `restart` drops connections for up to ~60s; automation must tolerate transient `ECONNRESET`.

## Ops used

`create_table`/`drop_table`, `insert`, `sql` (`SELECT`, `DELETE FROM ... WHERE`), `describe_all`, `deploy_component`/`drop_component`/`restart`.
