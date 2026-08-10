# Sightline Free MVP Screen Specification

This specification replaces the paid/replay portions of the existing App Store concept as the implementation reference for Sightline Record. Use Shopify App Home page patterns, App Bridge, and Polaris web components.

## Global behavior

- App navigation: Overview, Events, Orders, Findings, Privacy.
- Global context: “Last 7 days,” recording health, last reconciliation time.
- Never show replay buttons, recovery queues, destination health, paid plan prices, or downstream failure claims.
- Every screen supports loading, empty, partial-data, stale/reconciliation-delayed, authorization-expired, and recoverable-error states.
- All timestamps show merchant timezone with an accessible exact timestamp.
- Filters are reflected in the URL and keyboard accessible.
- Tables use cursor pagination; visualizations have equivalent text/table summaries.
- **CSV export** is offered on every list screen (Events, Orders, Findings), always scoped to the caller's current filter — never the whole table. Export is capped (`MAX_EXPORT_ROWS`); a result that hit the cap while more rows remained says so in the UI rather than silently shipping a partial file as if it were complete. Every exported cell that could begin with `=`, `+`, `-`, `@`, tab, or CR (an order name, SKU, or carrier is merchant-controlled text) is neutralized before it reaches the file, so opening it in a spreadsheet never executes a formula.

## 1. First-open/setup

Purpose: explain what the app records while initial reconciliation runs.

```text
Sightline is recording your Shopify operations

[1 Installed ✓] — [2 Webhooks connected ✓] — [3 Initial check in progress]

Sightline keeps seven days of order, fulfillment, inventory, and refund
activity. It is read-only and never sits in your fulfillment path.

[View data we store]                         Last checked 12 seconds ago
```

Acceptance:

- Progress is derived from durable backend state, not a client timer.
- A failed step gives a safe retry or reauthorization action.
- The page does not imply history exists before backfill completes.

## 2. Overview

Purpose: answer “Is recording healthy, and what needs attention?”

```text
Operations overview                                      Last 7 days

[Recording healthy] [18.4k events] [12 unconfirmed] [Reconciled 4m ago]

Order → fulfillment
Paid      Awaiting window      Confirmed      Unconfirmed
 842             21               809              12

Activity over time
Orders     ━━━━━━━━
Fulfillment  ━━━━━━  ━━━
Inventory ━━━━━━━━━━━━━━━
Refunds        ━  ━

Waiting for confirmation, by age
Under 24h    2        24–48h    1        48–72h    0        Over 72h    1

Capture integrity
Every change Sightline recorded in this window arrived as a webhook.
Arrived as a webhook: 18.4k     Found by direct check: 0

Needs attention
Order #1048  No Shopify fulfillment confirmation after 24h  [View evidence]
```

Acceptance:

- Counts reconcile to the selected time window and documented definitions. The order tiles, the flow lanes, the aging breakdown, and the Orders worklist all read the same window (`lastEventAt` inside the last 7 days) and the same lane definition (`src/orders.ts`), so they can never describe different sets of orders — the divergence this spec used to permit between the Overview and the flow lanes is a defect, not a feature.
- Health is separate from finding count: an unhealthy recorder cannot claim “no gaps.”
- Flow width/count is meaningful without color; status has text/icon labels.
- **Aging breakdown**: orders awaiting confirmation, bucketed by hours elapsed since payment (Under 24h / 24–48h / 48–72h / Over 72h — the last bucket is exactly the set the 72-hour confirmation detector has already flagged). Every bucket, and every top-level count on this screen, links into the Orders worklist pre-filtered to reproduce it — a merchant's next question after any number here is always "which ones?", and every number answers it.
- **Capture integrity**: how many of this window's events arrived as a webhook versus were found only by Sightline's own reconciliation check. The claim boundary is exact and must not be loosened: a direct-check discovery means Sightline's webhook did not receive that event — it is not proof Shopify failed to send it, and it says nothing about any other app's independent webhook subscription. The banner denies the "Shopify failed" reading without using that phrase, so a merchant cannot walk away thinking Sightline blamed Shopify's platform for its own capture gap.

## 3. Events

Purpose: provide a searchable seven-day operational ledger.

Filters: time, domain, topic/type, order/resource identifier, SKU, evidence source.

Columns: occurred time, domain, event, resource, concise state, source (`webhook` or `reconciliation`).

Event detail shows normalized fields, source/receipt time, related events, and whether it affected a projection/finding. Do not expose raw payloads or customer-identifying fields.

Acceptance:

- Search supports exact Shopify resource ID, merchant-visible order number where approved, and SKU.
- Results are cursor-paginated and tenant-scoped.
- Delayed/out-of-order receipt is visible without changing event occurrence order.

## 4. Orders (worklist)

Purpose: turn the Overview's order counts and aging breakdown into an actionable list — the answer to "which ones?" Before this screen existed, the only order list was Findings, which shows exclusively the orders that have already blown the confirmation deadline; this one shows every order Sightline is tracking, at whatever stage it is in.

```text
Orders Sightline is tracking                              Last 7 days

Lane [Any lane ▾]   Age [Any age ▾]   Sort [Latest activity first ▾]   [Filter]   [Export CSV]

Order   Lane                          Paid    Waiting  Last activity  Value  Tracking   
#1004   Awaiting                      10:04   2h       10:04          $50    —          [Open in Shopify]
#1002   Awaiting ⚠ attempt did not succeed   09:04   30h      13:04          $90    —          [Open in Shopify]
#1003   Fulfilled                     05:04   —        08:04          $40    FedEx      [Open in Shopify]
```

Columns: order (merchant-facing name, falling back to the raw id — never a blank cell), lane, paid time, time waiting since payment (`—` unless the order is awaiting confirmation: a fulfilled order is not waiting for anything), last observed activity, order value, tracking presence/carrier, and an **Open in Shopify** deep link.

Filters: lane (awaiting / fulfilled / no fulfillment expected / cancelled / refunded / unpaid), age since payment (minimum, and a maximum when the link comes from an aging bucket — see below), sort (latest or earliest observed activity first).

The list is **sorted and paginated on `lastEventAt`**, never on `paidAt`. `paidAt` is null for every order Sightline has seen but not seen paid (pending, authorized-not-captured, COD, draft), and a keyset pager on a nullable column emits a cursor it cannot decode, so the next page runs unbounded and returns the same page forever. `paidAt` stays a filter (age) and the derived `ageHours`; the sort key is the column the "Last activity" header names. Earliest-activity-first remains the triage order, because a quiet awaiting order's last observed activity is its payment.

States: loading, empty ("No orders match"), error (retry), authorization-expired, and stale/reconciliation-delayed via the shared context strip — the same states every other screen supports (see Global behavior).

Acceptance:

- **The lane definition comes from `src/orders.ts` and nowhere else.** The worklist's lane column, the Overview's flow lanes, and the aging breakdown all call the same `deriveOrderLane`/`isAwaitingConfirmation` functions over the same windowed set of order projections. No screen, and no query, may re-derive "paid and fulfillment-eligible and not yet fulfilled/cancelled/refunded" itself — three independent copies of that predicate is how the Overview and the flow lanes disagreed about the same orders before this was fixed.
- Every order appears at most once, in its single most-final lane (a cancelled order that was fulfilled first is `cancelled`, not both).
- A failed fulfillment attempt is a distinct flag on the row (visually separate from the lane badge), stated as direct evidence — "Shopify recorded a fulfillment attempt for this order that did not succeed" — never as an inference from absence, and it carries no absence disclaimer, because absence is not what is being reported.
- Results are cursor-paginated and tenant-scoped; an order id that belongs to another shop never surfaces, even if the id string collides.
- Every list, including this one, offers CSV export of the current filter (see Global behavior).

## 5. Order detail

Purpose: the full observed history of one order, at the depth a merchant needs to decide whether to act on it.

```text
Order #1004                                       [Awaiting]  [Open in Shopify]

Order   #1004         Value   $50.00
Paid    10:04          Waiting since payment   2h
Needs shipping   Yes    Fulfillment confirmed   —

What Sightline observed
10:04  Order paid

Events                                          Findings
10:04  order         orders/paid    webhook     (none yet)
```

Acceptance:

- **The observed timeline.** Every entry is something Sightline directly observed in Shopify — order paid, a fulfillment attempt that did not succeed, a fulfillment confirmation, a cancellation, a full refund — and every entry carries its own source timestamp. Entries are ordered chronologically by that timestamp, never by field order, and nothing on the timeline is an inference about what a warehouse, carrier, or other downstream party did.
- **Findings for the order.** Any finding raised against this order (by any detector) is listed inline, linking to its own finding detail, tenant-scoped the same as everywhere else.
- **Events for the order.** The order's own raw events are listed inline (time, domain, topic, state, source), linking to event detail, bounded to the 7-day retention window like every other event view.
- **The Admin deep link** ("Open in Shopify") always navigates the top-level Shopify Admin frame to this order, never a nested iframe — the merchant must land in real Admin, not inside Sightline's own embedded frame.
- An order with nothing but a payment (no fulfillment activity yet) still renders, with an empty-state note rather than a blank timeline section.

## 6. Findings

Purpose: show orders whose expected Shopify confirmation is absent.

List fields: order reference, paid time, expected confirmation, deadline/elapsed time, current state, last reconciled time.

Finding detail:

```text
Order #1048 is unconfirmed

What Sightline observed
10:04  Order paid
10:05  Fulfillment expected by Jul 13, 10:05
10:06  Last reconciled with Shopify
10:07  No qualifying fulfillment confirmation observed

Why this qualified
• Contains fulfillment-eligible items
• Not canceled or fully refunded
• Confirmation window elapsed

This does not prove that a warehouse or carrier failed. It means Shopify has
not shown the expected fulfillment confirmation yet.
```

Acceptance:

- Evidence comes from immutable event IDs and a named detector version.
- Resolved and suppressed states retain their explanation.
- No action mutates Shopify.

## 7. Privacy and app health

Purpose: make the zero-configuration service transparent and support review.

Show installed shop, granted scopes, recorded data categories, excluded customer fields, seven-day retention, webhook health, reconciliation health, and uninstall/deletion explanation.

No secrets, tokens, internal cluster names, or global tenant metrics appear.

## Additional design deliverables before frontend implementation

Create focused, implementation-grade mockups for:

1. Overview with healthy data and with stale reconciliation.
2. Events search plus event detail.
3. Findings list plus unconfirmed/resolved details.
4. First-open, empty, authorization-expired, and error states.
5. Mobile/narrow iframe behavior and visualization table alternatives.

Update the public App Store creative only after these screens are implemented with representative, non-fictional data. Keep paid-tier concepts visually labeled as future/paid and never imply they ship in Record.
