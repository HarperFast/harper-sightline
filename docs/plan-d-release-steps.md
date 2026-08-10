# Plan D release steps

Plan D ([plan](./superpowers/plans/2026-08-10-plan-d-followups.md)) was implemented and reviewed
entirely offline. Every test uses an in-memory table or a stubbed DOM, and nothing touched a live
Shopify API, the Harper cluster, or the dev store. **Nothing below has been executed.**

Plan D is a corrections branch on top of Plans A, B and C. If
[Plan A's](./plan-a-release-steps.md), [Plan B's](./plan-b-release-steps.md) or
[Plan C's](./plan-c-release-steps.md) steps have not been run yet, run those first — Plan D
changes one thing they check (see step 3). Delete each file once run.

Run everything from the repository root.

> **This is a short list on purpose.** Plan D is mostly test infrastructure: it adds no runtime
> dependency, no endpoint, and no screen. Two of the three items below are one-line confirmations.
> The first is the only genuinely unverified mechanism on the branch.

---

## 1. Confirm the deployed component resolves `#harper`

**This is the one mechanism nobody could verify offline, and the only step here that can fail.**

`app/src/db.ts` no longer imports `harper` directly. It imports `#harper`, a
[subpath import](https://nodejs.org/api/packages.html#subpath-imports) declared in
`app/package.json`:

```json
	"imports": {
		"#harper": {
			"types": "./types/harperImportsShim.d.ts",
			"test": "./test/harperStub.ts",
			"default": "harper"
		}
	}
```

This exists so `db.ts` — and therefore `ledgerTargets.ts`, `jobs.ts` and the resources — can be
loaded under `node --test`, which was previously impossible. In production nothing passes
`--conditions`, so resolution takes `default` and reaches the real `harper` exactly as before.

**What to do:** deploy, then confirm the component loads.

```
cd app && npm run deploy
```

**If it fails, it will fail loudly and at load time**, with an unresolved-specifier error naming
`#harper` — not a silent misbehaviour. That means Harper's component loader does not honour
`package.json` `imports`. The fallback is small and mechanical: revert `db.ts`'s import to bare
`harper`, and have the tests that need it use a different mechanism. Nothing else on this branch
depends on the mapping.

**Read the load logs rather than trusting the deploy's exit code.** This repo has history with
multi-node restarts where only one node reloads, so a half-applied deploy can look like a loader
problem and vice versa.

## 2. Note, do not verify: the test stub is not deployable

An earlier draft of this checklist asked you to confirm no deploy or CI environment sets
`NODE_OPTIONS` with `--conditions`, because `--conditions` is in Node's
`allowedNodeEnvironmentFlags` and so can be activated by environment variable with no CLI flag.

**That check turned out to be unnecessary, and the reason is worth knowing.**
`app/scripts/deploy.mjs` builds the deploy tarball from an explicit allowlist:

```javascript
const files = ['config.yaml', 'schema.graphql', 'resources.ts', 'jobs.ts', 'src', 'package.json'];
```

`test/` is not in it, so `test/harperStub.ts` is **never uploaded**. Activating the `test`
condition on a deployed component cannot reach the stub — it resolves to a path that does not
exist there, and fails loudly. The safety property is not "no default path activates the stub";
it is "the stub is not present."

No action. Recorded so that if someone later adds `test/` to that allowlist — for any reason —
they know it would turn a non-issue into a real one.

For completeness, one wording correction to the comment in `app/types/harperImportsShim.d.ts`:
Node does not ignore a `types` condition. It simply isn't in Node's default active-condition set,
and if force-activated it resolves to a `.d.ts` re-exporting from bare `harper`, which fails the
same loud way. The `types` entry exists only because TypeScript's resolver will not fall back to
the ambient `declare module 'harper'` through a subpath indirection.

## 3. Verify the outbox lost two columns

Plan C's checklist asked you to confirm `DigestOutbox` carried `subject`, `bodyText` and
`bodyHtml`. **Plan D removed the two body columns**, so that instruction is now wrong — this
supersedes it.

Confirm with `describe_table` via the ops API (`HARPER_OPS_URL` / `HARPER_USER` / `HARPER_PASS`,
see [deployment.md](./deployment.md)) that `sightline_core.DigestOutbox` has:

- `subject` — **present.** It is derived from the counts, the period and recorder health only, so
  it names no order.
- `bodyText` — **absent.**
- `bodyHtml` — **absent.**

This is a confirmation of absence, and it is load-bearing. The public privacy policy, the
`/api/v1/privacy` payload, `docs/data-inventory.md` and the Notifications screen all state that a
stored digest record holds counts and a subject line and **no order names**. The bodies named the
five longest-waiting orders. A stray body column would make all four statements false, and would
reintroduce a thirty-day retention of merchant data that everything else expires at seven days.

These tables have never been deployed, so this is a fresh create with no migration. If a body
column appears anyway, suspect the intermittent Fabric behaviour this repo has seen where
`deploy_component` half-applies a change to a `@sealed` table.

## 4. Smoke, and check one screen

```
cd app && npm run smoke
```

Then open **Notifications** on the dev store and read the whole screen, not just the banner. It
should say a record of each digest is kept for 30 days holding counts and a subject line, and it
should not claim anywhere that the stored record contains order names.

Nothing else merchant-facing changed on this branch.
