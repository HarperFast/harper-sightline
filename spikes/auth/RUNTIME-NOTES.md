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

## Confirmed live against Fabric 5.2.0 (Task 3)

Deployed `sightline-spike-auth` to the Fabric instance and verified end to end.
These are observed facts, and several directly shape the scaffold (issue #4).

**Deploy mechanism (resolved):**
- `deploy_component` operation with `{ project, payload }`, where `payload` is base64 of a `.tar` of the project files (files at tar root). Works with the `test` ops creds. Component loads after the `restart` operation; `get_components` reports `status: healthy`.
- The `project` name must match a secret **grant** for scoped secrets to be visible — we deploy as `sightline-spike-auth` (granted).

**HTTP surface (resolved):**
- Component REST is served on **443 at the host root**: `https://ayoo.josh-test.harperfabric.com`. Port `:9925` is the operations API; `:9926` is not publicly exposed on Fabric.
- Standalone exported `Resource` classes route at **`/<ExactClassName>`** at root — **case-sensitive**, NOT under a `/<component-name>/` prefix. Confirmed via the platform's own `status-check` (`/status`) and ours (`/Ping`, `/Session`).

**Authorization model (resolved — scaffold-shaping):**
- Resources are **deny-by-default**. A public GET requires an authorization hook: `allowRead() { return true; }` (instance method). Without it the route 404s.
- **Harper's HTTP auth layer intercepts the `Authorization` header.** `Authorization: Bearer <shopify-session-token>` returns `401 {"error":"invalid token"}` from Harper *before the resource runs*. Therefore the Shopify session token must ride in a **custom header** — we use `X-Shopify-Session-Token`, and App Bridge on the frontend must send it there (not Authorization). **This is a decision for ADR-001 and the scaffold.**

**Resource API (confirmed live):**
- Header read inside an instance `get()`: `this.getContext().headers.get('x-shopify-session-token')`.
- Throwing an `Error` with `.statusCode` yields a structured JSON error `{ type, code, title, status, instance }` at that status. `AuthError` (401) → 401. Verified: missing/invalid-signature/expired all return correct 401s from our verifier.

**Secrets accessor (confirmed live):**
- `(await import('harper')).secrets.SHOPIFY_API_SECRET` is readable by the granted component. `/Ping` returned `secretNames: ["SHOPIFY_API_SECRET"]`, and a token signed with the real secret verified to a correct principal.
- Access secrets via **dynamic import + optional chaining** so a differing API shape cannot break module load.

**Module-load gotcha (cost us several redeploys):**
- A bad top-level import fails the **whole** resource module → *all* routes 404 while `get_components` still reports `healthy`. Culprits seen: `import * as harper` then `const { Resource } = harper` (gave `undefined` → `class extends undefined`), and a named `import { secrets }` when the symbol resolution differed. Fix: direct `import { Resource } from 'harper';` and lazy/dynamic secrets access.

**TypeStrip (confirmed live):**
- `.ts` resources with `.ts`-extension relative imports load and run on Fabric 5.2.0 (proven with a minimal `probe-ts` component that returned 200). The TypeStrip engineering assumption holds; no build step needed.

## Task 1 status

Component files created and the runtime facts pinned — now confirmed live rather than from docs alone (see above).
