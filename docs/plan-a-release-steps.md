# Plan A release steps

Plan A ([plan](./superpowers/plans/2026-08-07-plan-a-data-extraction-and-defects.md))
was implemented and reviewed entirely offline: every test uses an in-memory table and
an injected `fetch`, and no step in it ever touched a live Shopify API, the Harper
cluster, or the dev store. **Nothing below has been executed.**

These are the outward-facing and live-infrastructure steps, in the order they must
be run, plus the verification that unit tests structurally cannot provide. Delete
this file once it has been run.

Run all of it from the repository root.

---

## 1. Release the widened subscriptions AND the new scopes (Tasks 2 + final fix)

```
shopify app deploy --allow-updates
```

- Releases a new app version carrying the widened `include_fields` (orders gain
  `total_price` + `current_total_price`; fulfillments gain `location_id`) **and
  the two new access scopes, `read_products` + `read_locations`**, without which
  inventory enrichment silently fails in production.
- **A scope change requires every existing install to re-authorize.** You have one
  dev-store install today, so this costs one prompt — reopen the app in Admin
  after releasing and accept the new permissions. Confirm afterwards that
  `/api/v1/privacy` reports the new scopes in its `scopes` array; if it still
  shows the old three, the re-auth did not take and enrichment will keep failing.
- All added fields are PCD **Level 1** (order facts, no customer identifiers), so
  no new PCD approval is required — but this IS a released app version, days
  before App Store submission. This is the one step in Plan A with review exposure.
- The CLI rewrites `shopify.app.toml` to match released config. Afterwards, re-read
  the file and confirm both `include_fields` lists still contain the added fields.
  If the CLI reformatted them, commit that rewrite:
  `git add shopify.app.toml && git commit -m "chore(shopify): CLI-normalized app config after deploy"`

## 2. Deploy the schema (from Task 3)

```
cd app && npm run deploy
```

Then verify with `describe_table` via the ops API (`HARPER_OPS_URL` / `HARPER_USER`
/ `HARPER_PASS`, see `docs/deployment.md`). **This repo has an intermittent Harper
Fabric bug where `deploy_component` drops a newly-added column on an existing
`@sealed` table** — so verification is not optional. Confirm:

- `sightline_ledger.OperationalEvent` has `orderName`, `totalPrice`, `currency`,
  `locationId`, `hasTracking`, `trackingCompany`, `shipmentStatus`
- `sightline_ledger.OrderProjection` has `orderName`, `orderTotal`, `currency`,
  `fulfillmentFailedAt`, `hasTracking`, `trackingCompany`, `trackingAt`
- `sightline_ledger.GapFinding` has `detector`
- `sightline_ledger.EventSku`, `InventoryItem`, `ShopLocation` all exist

If any column is missing, redeploy and re-verify before going further.

---

## 3. Smoke the deployment

```
cd app && npm run smoke
```

Covers health, unauthenticated 401, webhook bad-HMAC 401, and the authed
session/summary/privacy/findings endpoints.

## 4. Verify the pipeline end-to-end on the dev store

Unit tests cannot prove any of this — every test uses an in-memory table and an
injected `fetch`, and nothing in Plan A has ever touched a live Shopify API.

1. **Order value + name.** Place and pay an order with two distinct SKUs. Via
   `/api/v1/events`, confirm the `orders/paid` event carries `orderName`,
   `totalPrice`, and `currency`.
2. **The SKU defect, fixed.** `GET /api/v1/events?sku=<one of those SKUs>` must
   return that event. Before this plan it returned nothing, always.
3. **Tracking + location.** Fulfil the order with a tracking number. Confirm the
   fulfillment event carries `hasTracking: true`, `trackingCompany`, `locationId`.
4. **Failed-attempt detector.** If you can produce a fulfillment Shopify records
   as `error`/`failure`, confirm a `fulfillment_attempt_failed` finding appears
   and that its copy reads "Shopify recorded a fulfillment attempt for this order
   that did not succeed." — NOT the absence detector's hedged wording.
5. **Inventory enrichment.** Wait one enrichment tick (~1 min after boot, then
   every 15 min). Confirm an inventory event's detail now returns `inventorySku`,
   `productTitle`, and `locationName` instead of a bare numeric id.
6. **Privacy disclosure.** `GET /api/v1/privacy` — confirm `dataCategories` lists
   what is genuinely stored now (order value, tracking, SKUs, product titles) and
   that `storesCustomerPii` is still `false`.

## 5. Watch for one new cost

The enrichment loop makes Admin API calls the app did not make before (one
`locations` query per shop when uncached, plus batches of ≤50 inventory items).
It is designed to converge and then go quiet on a stable catalog.

**Check it in this order — "quiet" alone proves nothing, because a totally failing
sweep is also quiet:**

1. First confirm you see a tick reporting **non-zero** `items` / `locations`.
   That is the proof enrichment actually works with the new scopes.
2. *Then* confirm later ticks report zero. That is convergence.
3. If you never see step 1, look for an `enrich.items.failed` / `enrich.error`
   line — most likely the scope re-authorization in step 1 of this checklist did
   not take.
