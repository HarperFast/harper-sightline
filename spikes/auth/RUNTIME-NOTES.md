# Spike A — Harper v5.2.0 Runtime Notes

Living record of the runtime facts every later task depends on. Confirmed items are
sourced from the v5.2.0 docs and/or observed directly.

## Package / CLI (confirmed)

- **Harper v5 ships as the `harper` npm package** (latest `5.2.0`, matches the Fabric instance). The older `harperdb` package is **v4** (4.7.x) — do not use it for this project.
- Local machine has both: `harperdb` 4.7.29 (legacy v4) and `harper` 5.0.21, installed under Node 23's global bin.

## Resource API (confirmed from docs)

- Base class import: `import { Resource } from 'harper';`
- Methods map to HTTP verbs (`get`, `post`, `put`, `patch`, `delete`) and receive a `target` arg.
- **Read a request header:** `this.getContext().headers.get('Authorization')`. Context also exposes `method`, `url`, `pathname`, `host`, `ip`, `body`, `data`, and `response`.
- **Set status:** return `new Response(JSON.stringify(body), { status })`, or set `this.getContext().response.status` and return the data object.
- **Errors:** throw an `Error` with `.statusCode` set → maps to that HTTP status.

## Secrets accessor (confirmed from docs)

- Scoped secrets (our case: `SHOPIFY_API_SECRET` granted to `sightline-spike-auth`) are read via `import { secrets } from 'harper'; secrets.SHOPIFY_API_SECRET`.
- The accessor is **live** (reflects rotations without reload). Values never returned by reads, never logged, never replicated as plaintext.
- Local test fallback: `process.env.SHOPIFY_API_SECRET` (see `src/readSecret.ts`).

## Harper runtime for integration/live tasks — DECISION

Running Harper **locally is not viable in this environment**:
- The local `harper` CLI is 5.0.21 (not 5.2.0), and starting it fails with `EPERM` writing `~/hdb/log/hdb.log` under the command sandbox (that path is outside the writable allowlist).

**Decision:** use the live **Fabric instance `ayoo.josh-test.harperfabric.com` (v5.2.0)** as the Harper runtime for anything that needs Harper (Task 3 integration, Task 4 live, Task 6 live). Pure-logic tasks (verifier, token exchange, rotation logic — Tasks 2, 5, 6-unit) run with `node --test` and need no Harper at all.

## Open items (confirmed at deploy time — Task 3/4)

- [ ] Exact deploy mechanism to Fabric (`deploy_component` operation with a packaged tarball vs Harper Studio vs `harper deploy`).
- [ ] The component's HTTP base URL + port once deployed (probe showed ops API on `:9925`; component HTTP port TBD — likely `:9926` or a Fabric-mapped 443 route).
- [ ] Confirm the live `secrets.SHOPIFY_API_SECRET` read succeeds inside the granted deployed component.

## Task 1 status

Component files created (`config.yaml`, `schema.graphql`, `resources.ts` with `Ping`, `package.json`, `dependencies.md`). Local run step intentionally superseded by the Fabric-runtime decision above; the runtime facts this task exists to pin are recorded from the v5.2.0 docs.
