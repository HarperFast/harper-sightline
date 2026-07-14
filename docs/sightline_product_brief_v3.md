# Sightline by Harper

**Shopify operational flight recorder: visual timelines, flow maps, and replay**

> **Core promise:** Know what happened in Shopify, where operational events moved, what failed, and what can be safely replayed. Sightline is never on the synchronous path. Shopify's native delivery keeps doing the work; Sightline records in parallel and recovers on demand.

## Replay terminology

Three verbs, used consistently through this document and the product:

- **Replay (re-serve):** re-deliver captured events from the Sightline ledger to integrations built on the Sightline feed. Direct, scoped, cursor- or query-driven.
- **Replay (re-announce):** make Shopify re-emit events for affected records by changing state on a safe carrier field (tag or metafield pulse), so every existing vendor subscription reprocesses through its normal, correctly signed Shopify delivery. This is the bulk version of the resync trick merchants already perform by hand, one order at a time.
- **Repair:** Admin API writes that correct missing or stale Shopify state (create a missing fulfillment from connector data, fix tracking, adjust inventory). Gated, operator-approved, Scale tier.

Nobody, including Sightline, can push events into Shopify's pipeline or make it re-send an original delivery. Re-announcement works because Shopify emits fresh events whenever state changes; Sightline authors the change, Shopify does the delivery.

## Business case

Sightline is a logo-capture app that complements Shopify rather than competing with it. Shopify is already the merchant catalog, checkout, storefront, and admin. The pain starts around Shopify, where orders, inventory, fulfillment, products, customers, returns, refunds, and Flow/webhook automations fan out to agencies, 3PLs, ERPs, CRMs, marketplaces, warehouses, analytics systems, and custom endpoints. Shopify Flow automates store and app processes, and Shopify webhooks provide the event substrate, but a growing operation still needs durable memory, visual diagnosis, and safe recovery when downstream flows break.

The market wants this because operational incidents are not abstract infrastructure problems. They are everyday commerce questions: Which paid orders missed fulfillment? Why is inventory stale after a sale? Which product updates failed to reach a feed? What changed, who touched it, and can we replay only the affected records? Today the answers cost hours of spreadsheet forensics per incident, and the recovery is a folk remedy: touch orders one at a time and hope the vendor resyncs. Sightline makes detection instant, scoping automatic, and recovery a scoped bulk operation with an approval step.

The architecture principle that shapes everything: **parallel, not inline.** Every destination keeps its own direct Shopify subscription. Traffic flows Shopify-to-destination exactly as today, with zero added latency and zero new failure modes. If Sightline is down, nothing in the merchant's operation notices. Sightline subscribes alongside, records everything, and recovery capability sits in standby until an incident needs it. Same recovery functionality as being the pipe, without ever being the pipe.

The growth ladder:

1. **Record (free).** Passive parallel capture builds the ledger and surfaces flow gaps. Logos and telemetry at near-zero support cost.
2. **Recover (paid).** Scoped replay: re-announcement for vendor lanes, re-serve feeds for custom integrations, import artifacts for everything else. Every free-tier gap alert is the pitch for this rung.
3. **Cluster (scale).** Multi-store agency operations, repair writes, long retention, dedicated Harper cluster when the ledger is business-critical infrastructure.

## TAM and ideal users

| Question | Answer |
|---|---|
| Total app-store surface | Millions of Shopify merchants in 175+ countries. Shopify reports $1.6T cumulative GMV and greater than 14% US ecommerce market share. |
| Practical ICP | Growing Shopify merchants, Shopify Plus teams, agencies, and systems integrators that already depend on fulfillment, inventory, ERP, marketplace, CRM, or analytics flows. Not the no-fan-out long tail: stores whose operations live entirely inside Shopify have nothing to record. |
| The wedge | Agencies and SIs. One install decision covers a portfolio of stores, the multi-store dashboard is the feature they cannot get elsewhere, and they carry Sightline into every new engagement. Launch motion targets agencies first, merchants second. |
| B2B or B2C? | Both. B2C merchants feel the pain through order, fulfillment, inventory, return, refund, and customer flows. B2B merchants add catalogs, company/location rules, pricing terms, and account workflows. |
| Who downloads it? | Commerce ops, ecommerce directors, agency operators, technical marketers, RevOps/ops leads, and developers responsible for Shopify incidents. |
| Why not a generic audit? | The buyer may already know the operation is complex. Sightline gives the missing next action: see affected flows, isolate records, and recover. |

## Product description

Sightline records and visualizes the operational timeline of a Shopify store, entirely off the synchronous path.

**Capture.** On install, the app subscribes in parallel to key Shopify event topics (Pub/Sub-backed ingestion at multitenant scale) and builds a searchable, immutable event ledger. Because Shopify webhooks are at-least-once with no ordering guarantee and no re-delivery of missed events, the ledger runs a reconciliation sweep against the Admin API to detect and fill its own gaps. A byproduct: Sightline can detect events Shopify never delivered at all, a failure class merchants currently cannot see.

**Visualize and detect.** Raw events become business flows: order to fulfillment, inventory to downstream systems, product updates to channels, customer updates to CRM/email, returns/refunds to operations. Failure detection is inference from absence in the stream: paid orders with no fulfillment event inside the expected window, inventory sold with no downstream update, refunds created but never resolved. Detection output is not a red dot; it is the scoped record list ("these 39 orders, 10:04 to 10:19") that recovery needs as input, which is exactly the artifact ops teams currently build by hand.

**Recover.** One button, View & replay, backed by a planner that selects the right mechanism per lane:

- **Vendor lanes (3PLs, ERPs, sync apps with their own Shopify subscriptions):** re-announcement. Sightline pulses a safe carrier field on the affected records; Shopify emits fresh events through every existing subscription; the vendor's integration reprocesses through its normal path. Scoped to exactly the affected records, bulk at any incident size, operator-approved before execution. Per-connector knowledge of which apps re-evaluate on update (most sync-type apps) versus creation-only flows is product IP, built per vendor.
- **Sightline-native integrations:** re-serve. Integrations built on the Sightline feed (durable, cursor-based, replay-safe by contract) get direct replay: rewind a cursor or open a scoped session over the affected records. New agency glue should be built here; it is the most recoverable lane and the data-gravity path onto Harper.
- **Everything else:** generated recovery artifacts. Where a vendor exposes a bulk import or manual resync surface, Sightline generates the exact validated input file from ledger data. The operator's job drops from forensics-plus-data-entry to drag-and-drop.

The boundary, stated plainly: Sightline detects that work is missing, identifies exactly which records it is missing for, and re-delivers the input data to the system responsible for doing the work, through whichever door that system has. It does not do the work, cannot fabricate outputs (no fulfillment record for a shipment that never happened), and never pushes into closed vendor systems.

**Repair (Scale tier).** Where Shopify's own state is the gap and the ledger holds the correct facts, gated repair writes fill it forward: create the missing fulfillment from connector tracking data, fix tracking, adjust inventory, set the tags and metafields downstream syncs key on. Rules: propose-and-approve with a dry-run diff, idempotency keys, full audit trail in the ledger, append-only records get compensating entries never edits, derived and financial statuses are never rewound. Sightline can only put back what it saw.

**Connectors.** Read-only pull connectors ingest foreign ledgers (3PL, ERP, marketplace) for cross-system correlation, turning inferred gaps into confirmed ones ("order paid 10:04, never arrived in ShipHero"). Selection filter: the echo-back test. Systems that already write their outcomes into Shopify add little visibility and are declined honestly. Build model: on demand, funded by the first requesting customer as a one-time build fee with a delivery SLA, then added to the catalog for every subscriber. Dispatched-agent build economics keep fees low and turnaround in days, and the request queue doubles as a demand map.

**Product boundary.** Sightline captures, stores, visualizes, correlates, and recovers. It does not become the merchant's delivery infrastructure, does not sit inline, and does not build speculative connector inventory. Agencies, SIs, and customer teams build business logic on the feed; that keeps the product from becoming a custom-integration services unit.

## Tiers

| Tier | Price | Contents |
|---|---|---|
| **Record** | Free | Parallel event capture, 7-day history, search, timeline, flow map, absence-based gap alerts with scoped record lists, ledger reconciliation. Read-only Shopify scopes, zero configuration. Every alert renders the upgrade prompt. |
| **Recover** | ~$49/mo | 90-day retention, View & replay: scoped re-announcement (requires the tag write scope, requested at upgrade, the one exception to read-only below Scale), feed access with replay sessions, recovery artifact generation, existing catalog connectors, correlation, alerts and anomaly detection. Everything in this tier works the day you pay. |
| **Connector build** | One-time fee | New connector, quoted with delivery SLA, echo-back test applied before taking the money. Lands in the catalog for all Recover subscribers. |
| **Scale** | Custom | Agency multi-store dashboard, long retention, repair-write module (write scopes, propose-and-approve), priority connector builds, SLAs, private deployment, dedicated Harper cluster. |

## Storefront mockup and application screens

| Screen | Purpose | What it demonstrates |
|---|---|---|
| App Store hero | Public-facing install page for Sightline by Harper. | Clear value prop: visual timelines, flow maps, replay, no theme work, never in your critical path. |
| Old logs vs Sightline flow | The main before/after screenshot. | Old way: success/failure rows. New way: Sankey/alluvial flow map with a **View & replay** button. Free-tier claims are absence-based and provable: "39 paid orders never reached fulfillment." |
| Operational flow map | Daily view of where event volume is moving. | Flow width shows volume, color shows health, click-through opens the exact records behind the flow. |
| Timeline view | iMovie-style operational tracks across time. | Scrub a failure window, isolate affected stores, destinations, SKUs, or orders. |
| Replay queue | Incident recovery workflow, labeled Recover tier. | The planner's proposed recovery plan per lane, with per-line mechanism (re-announce, re-serve, artifact), approval step, and execution progress. |
| Reviews and pricing | A realistic App Store surface. | Free recorder, Recover tier, connector catalog, Scale path into agency dashboards and dedicated Harper clusters. |

## MVP versus production

| MVP | Production / cluster path |
|---|---|
| Parallel capture, 7-day history, event search, absence-based flow health with scoped record lists, old-vs-new screenshot, simple flow map, timeline tracks, tag-pulse re-announcement for a validated app shortlist, replay-safe feed with one reference consumer, App Store billing. | Full connector catalog and on-demand build pipeline, correlation engine across foreign ledgers, recovery artifact generators per vendor, repair-write module, multi-store agency dashboard, long retention, high-volume ingestion, alerting, SLAs, private deployment, dedicated Harper clusters. |

**Gate 1, before any build (one afternoon, dev store):** validate the re-announcement mechanism against the top 20 sync-type apps by install density. Question: does a tag pulse cause each app to re-evaluate the record? Output: the validated shortlist and the creation-only exclusion list. If the mechanism fails broadly, the recovery story collapses to feeds-plus-artifacts and the concept needs rescoping before a line of product code.

**Gate 2, before launch commitment (two weeks, five to ten agency-managed stores):** run the passive recorder and count real incidents surfaced by absence detection, tagged by size and by lane. If growing stores throw meaningful gaps at a real rate, the free tier sells itself and every alert is Recover ammunition. If the stream is quiet, Sightline is an insurance sale, a different and harder App Store motion. Costs a week of work against the ledger schema the product needs anyway.

## Slack-ready summary

Sightline by Harper is a Shopify operational flight recorder. It records key Shopify events in parallel, off the synchronous path, visualizes them as flows and timelines, and shows teams where order, inventory, fulfillment, product, customer, return, and refund events moved or broke. The hook is the before/after: old world is success/failure rows and spreadsheet forensics; new world is a visual flow map with a **View & replay** button scoped to exactly the affected records.

Recovery works with the grain of Shopify instead of against it. Nobody can make Shopify re-send an event, so Sightline makes Shopify speak again: pulse a safe field on the affected records and every vendor subscription reprocesses them through its normal signed delivery. That is the one-order-at-a-time resync trick merchants already use, made scoped, bulk, ledger-driven, and operator-approved, and it works at 742 orders the same as at one. Integrations built on the Sightline feed get direct replay. Everything else gets a generated recovery file. Sightline is never in the delivery path: if it disappears, the store notices nothing.

The business model: free tier records and proves the gaps exist, the Recover tier turns every gap alert into a one-button fix, connectors get built on demand as customers fund them, and agencies running portfolios on the multi-store dashboard graduate to dedicated Harper clusters when the ledger becomes business-critical infrastructure. The wedge is agencies: one install decision covers twenty stores.

## Source notes

- Shopify investor page: millions of merchants, 175+ countries, $1.6T cumulative GMV, >14% US ecommerce market share: <https://www.shopify.com/investors?page=1>
- Shopify Flow: free app across Basic, Grow, Advanced, and Plus; monitors store events and automates actions: <https://help.shopify.com/en/manual/shopify-flow>
- Shopify webhooks: app subscriptions declare a topic and destination (HTTPS, Google Pub/Sub, Amazon EventBridge); Pub/Sub recommended for production; no ordering guarantee; reconcile with the Admin API rather than relying on webhooks alone: <https://shopify.dev/docs/apps/build/webhooks>
- Shopify activity log limitations: view-only, not exportable, maximum 250 results: <https://help.shopify.com/en/manual/shopify-admin/activity-logs>
- Cloudhooks example: adjacent App Store product covers webhook infrastructure, logging, retries, and replay, validating the need to position Sightline around operational visualization and recovery: <https://apps.shopify.com/serverless-extensions>
