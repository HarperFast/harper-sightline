# Sightline Free MVP Screen Specification

This specification replaces the paid/replay portions of the existing App Store concept as the implementation reference for Sightline Record. Use Shopify App Home page patterns, App Bridge, and Polaris web components.

## Global behavior

- App navigation: Overview, Events, Findings, Privacy.
- Global context: “Last 7 days,” recording health, last reconciliation time.
- Never show replay buttons, recovery queues, destination health, paid plan prices, or downstream failure claims.
- Every screen supports loading, empty, partial-data, stale/reconciliation-delayed, authorization-expired, and recoverable-error states.
- All timestamps show merchant timezone with an accessible exact timestamp.
- Filters are reflected in the URL and keyboard accessible.
- Tables use cursor pagination; visualizations have equivalent text/table summaries.

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

Needs attention
Order #1048  No Shopify fulfillment confirmation after 24h  [View evidence]
```

Acceptance:

- Counts reconcile to the selected time window and documented definitions.
- Health is separate from finding count: an unhealthy recorder cannot claim “no gaps.”
- Flow width/count is meaningful without color; status has text/icon labels.

## 3. Events

Purpose: provide a searchable seven-day operational ledger.

Filters: time, domain, topic/type, order/resource identifier, SKU, evidence source.

Columns: occurred time, domain, event, resource, concise state, source (`webhook` or `reconciliation`).

Event detail shows normalized fields, source/receipt time, related events, and whether it affected a projection/finding. Do not expose raw payloads or customer-identifying fields.

Acceptance:

- Search supports exact Shopify resource ID, merchant-visible order number where approved, and SKU.
- Results are cursor-paginated and tenant-scoped.
- Delayed/out-of-order receipt is visible without changing event occurrence order.

## 4. Findings

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

## 5. Privacy and app health

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
