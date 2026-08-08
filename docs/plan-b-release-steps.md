# Plan B release steps

Plan B ([plan](./superpowers/plans/2026-08-07-plan-b-orders-worklist-and-views.md))
was implemented and reviewed entirely offline: every test uses an in-memory table
and an injected `fetch`, and no step in it touched a live Shopify API, the Harper
cluster, or the dev store. **Nothing below has been executed.**

Plan B is stacked on Plan A — run [Plan A's release steps](./plan-a-release-steps.md)
**first**, including the scope re-authorization. Delete both files once run.

Run all of it from the repository root.

---

## 1. Deploy the schema, and verify two new indexes

```
cd app && npm run deploy
```

Then verify with `describe_table` via the ops API (`HARPER_OPS_URL` / `HARPER_USER`
/ `HARPER_PASS`, see [deployment.md](./deployment.md)). This repo has intermittent
Harper Fabric flakiness where `deploy_component` drops a newly-added column or
index on an existing `@sealed` table, so this is not optional. Confirm on
`sightline_ledger.OrderProjection`:

- `paidAt` is `@indexed` — the worklist's age filters use it
- `lastEventAt` is `@indexed` — **every** orders query now bounds on it

**Confirm the indexes cover pre-existing rows, not only rows written after the
deploy.** An index that covers only new rows would make the worklist silently miss
older orders — a quiet wrong answer rather than an error.

If `lastEventAt`'s index half-applies, the state backfill (step 2) still produces
correct, bounded output, but its per-tick *work* becomes a full scan — it will look
like success while costing far more than it should.

## 2. Watch the one-time state backfill converge

Plan B derives an order's lane and stores it on `OrderProjection.state`, which is
only written when an event rebuilds a projection. Every order already in the table
therefore has no lane until the backfill sweep gives it one — and a quiet
paid-unfulfilled order never rebuilds on its own, which is exactly the population
the worklist exists for.

The sweep (`src/stateBackfill.ts`, started from `jobs.ts`) is bounded, idempotent
and convergent. From the logs, confirm in this order:

1. Early ticks report **non-zero** `patched` counts. That is the proof it is working.
2. Later ticks report **zero**, and stay there. That is convergence.
3. If you see a `state.backfill.tied_batch` warning, more than 200 projections
   share a single `lastEventAt` millisecond. The sweep stays bounded and terminates,
   but the excess rows keep no lane until a new event rebuilds them. Unlikely in
   practice; loud if it happens.

**Expect a brief cosmetic window** between deploy and the first tick: a legacy
awaiting order shows a blank lane badge and `—` in the Waiting column on the
unfiltered worklist. It self-heals within a tick or two — do not mistake it for a
new defect.

## 3. Smoke the deployment

```
cd app && npm run smoke
```

## 4. Verify on the dev store

None of this is provable from the suite — every test uses an in-memory table.

1. **The worklist exists and drills in.** Open **Orders**. Confirm real orders with
   `#1001`-style names, lanes, ages and values. Click an Overview tile and confirm
   the list opens filtered to that lane, showing the same number the tile did.
2. **The aging breakdown.** Click each of the four age buckets and confirm each
   opens exactly its own count — not everything older. This is the defect class
   that recurred three times on this branch, so check all four.
3. **Order detail.** A row opens a chronological observed timeline with its events
   and findings, and **Open in Shopify** navigates the top-level Admin (not a
   nested iframe).
4. **CSV export.** Export a filtered list; confirm the file matches the on-screen
   filter, and that an order name beginning `=` does not execute as a formula.
5. **Failed attempts.** Confirm a `fulfillment_attempt_failed` finding reads
   "Shopify recorded a fulfillment attempt … that did not succeed" and does **not**
   carry the absence disclaimer.
6. **SKU search — the fix that matters most.** Search a SKU on **Events** and
   confirm the returned rows show that SKU in the SKU column. A blank cell there
   was the original defect. Then confirm an inventory row shows a SKU rather than a
   bare numeric id, and that its detail names the product and location.

## 5. Watch one query shape and one latency number

**The SKU hydration issues a single `operator: 'or'` query with up to 100
conditions per page.** The in-memory test table supports that shape; real Harper
may not behave the same. Load a page of 25–100 events with a SKU filter and watch
the latency against the p95 < 500ms target. If it is slow or unsupported, fall back
to per-row keyed lookups bounded by the page limit — `hydrateSkus` is the single
place to change — and record the change.

Also confirm the Overview still feels instant: `getSummary` now bounds its
projection scans in the database rather than in code, which should have made it
faster, not slower.
