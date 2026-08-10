# Plan C release steps

Plan C ([plan](./superpowers/plans/2026-08-07-plan-c-email-digest.md)) was implemented and
reviewed entirely offline: every test uses an in-memory table, and no step touched a live
Shopify API, the Harper cluster, or the dev store. **Nothing below has been executed.**

Plan C is stacked on Plans A and B. Run [Plan A's release steps](./plan-a-release-steps.md)
and [Plan B's](./plan-b-release-steps.md) **first**. Delete all three files once run.

Run everything from the repository root.

> **There is no sender.** Plan C builds digests and stores them with `status: 'pending'`.
> Nothing is delivered to anyone. A `pending` row is the finished state — it is not a
> stuck queue, and no step below should be read as "check the mail went out."

---

## 1. Deploy the schema, and verify two new tables

```
cd app && npm run deploy
```

Then verify with `describe_table` via the ops API (`HARPER_OPS_URL` / `HARPER_USER` /
`HARPER_PASS`, see [deployment.md](./deployment.md)). This repo has intermittent Harper
Fabric flakiness where `deploy_component` drops a newly-added column on an existing
`@sealed` table, so this is not optional. Confirm in `sightline_core`:

- `DigestSubscription` exists with `shopId`, `email`, `cadence`, `status`, `createdAt`,
  `updatedAt`, `lastBuiltAt` — and that `status` is `@indexed`, since the build loop
  searches on it across all shops.
- `DigestOutbox` exists with `id`, `shopId`, `cadence`, `periodStart`, `periodEnd`,
  `subject`, `bodyText`, `bodyHtml`, `ordersAwaiting`, `failedAttemptsInPeriod`,
  `deliveryGaps`, `recorderHealthy`, `status`, `createdAt`.

  The two count columns are named for what they measure, and the names are worth reading
  literally. `ordersAwaiting` is **orders currently awaiting confirmation** — current state,
  not period-scoped, and not a count of findings; elsewhere in this codebase `unconfirmed`
  means a finding *status*, which is why this column is not called that.
  `failedAttemptsInPeriod` is scoped to the digest's closed window, unlike the Overview's
  unbounded sibling.
- **`DigestOutbox` must have NO `email` column.** This one is a confirmation of absence, not
  presence. The address lives only on `DigestSubscription`, so that clearing it or
  uninstalling really does erase it — which is what the privacy policy and the Notifications
  screen both promise. A stray `email` column here would make both statements false for up
  to 30 days. A future sender reads the address from the subscription at send time.

Every epoch-ms column on both tables is `Float`, not `Int`. If one came back as `Int`,
stop — a truncated millisecond timestamp would corrupt period boundaries silently.

## 2. Confirm the PUT actually routes

**This is the one structural unknown in the plan.** `DigestResource` implements `put()`,
which no other endpoint in `app/resources.ts` does — both existing write endpoints use
`post()` with `allowCreate()` and `allowUpdate()`. Whether Harper's router dispatches an
HTTP PUT to a resource class's `put()` method could not be verified offline, and
`resources.ts` cannot be imported under `node --test` (it transitively imports `harper`,
which has no file outside the deployed runtime).

Save an address on the Notifications screen. If it succeeds, this is settled and nothing
more is needed.

If the PUT 404s or 405s, the fix is small and already scoped: rename `put()` to `post()`,
add `allowCreate()`, and change the SPA's `apiSaveDigest` verb to POST. That is the proven
pattern in this file. Nothing else about the endpoint changes.

## 3. Verify tenant isolation at the resource level

The suite proves `applySubscriptionUpdate` ignores a body-supplied `shopId`, `createdAt`,
and `lastBuiltAt` — a request cannot retarget or backdate another tenant's subscription.
What it **cannot** prove offline is that `DigestResource.get`/`put` key on the authenticated
principal, because the resource is unimportable.

Confirm on the dev store that a session token for one shop reads and writes only that
shop's subscription.

## 4. Smoke the deployment

```
cd app && npm run smoke
```

## 5. Verify on the dev store

None of this is provable from the suite — every test uses an in-memory table.

1. **The screen is honest about delivery.** Open **Notifications**. Confirm the
   "not yet delivered" banner is present, and that the state reads paused with no address.
   The banner is the load-bearing copy on this screen: the app must not appear to promise
   mail it does not send.
2. **Invalid input is explained, not stonewalled.** Save `nope`. Confirm the validation
   reason appears rather than a bare `400`.
3. **A valid address activates.** Save one. Confirm the state reads active, and that the
   **Privacy** screen now reports an address is stored — **and does not show the address
   itself**. The privacy endpoint states that one exists; it must never echo it.
4. **The address is nowhere in the logs.** Search the logs for the local part of the
   address you used. Any hit is a defect — the audit record is deliberately shaped to
   carry `status`, `cadence`, and `hasEmail`, never the address.
5. **Force a build without waiting a day.** Set the subscription's `lastBuiltAt` to `0` via
   the ops API and wait for a digest tick (≈90s after boot, then hourly). Confirm one
   `DigestOutbox` row appears with a sensible subject and body and `status: 'pending'`.
6. **Idempotency.** Re-run the tick. Confirm it does **not** create a second row for the
   same period — the outbox id is `${shopId}:${periodStart}`, so a rebuild must upsert.
7. **Unsubscribe works and is honest.** Clear the address and save. Confirm the state reads
   paused with no address, and that Privacy reports none stored.
8. **Uninstall erases it.** Uninstall on the dev store and confirm the `DigestSubscription`
   row is gone. Reinstall to continue working.

## 6. Watch one number and one claim

**The digest's counts must agree with the Overview.** Open a built digest's `bodyText` and
compare its "orders awaiting fulfillment confirmation" against the Overview's awaiting tile
for the same shop. They derive from one definition (`isAwaitingConfirmation`) by design; a
disagreement means something re-derived it.

**Check a quiet shop produces nothing.** Pick a shop with a healthy recorder and **nothing
awaiting confirmation at all** — not merely one with no new findings. The digest's headline
count is current state, so any still-awaiting order keeps producing a digest for as long as
it stays awaiting. That shop should get no outbox row, while its `lastBuiltAt` still
advances. Correct behavior — a recurring "all clear" trains people to ignore the channel —
and easy to mistake for a broken loop. [The runbook](./runbooks/digest-not-building.md)
covers it.

**Expect a digest to recur while an order stays stuck.** An order awaiting for five days
produces a digest on each of those days, with its age growing each time. That is deliberate:
an unresolved, actionable item should keep surfacing, and the alternative — going quiet once
the finding was first detected — would stop telling a merchant about a stuck order that is
still stuck. Do not read it as a duplicate-send bug. There is no send at all.
