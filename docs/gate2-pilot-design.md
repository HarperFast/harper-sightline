# Sightline — Gate 2 Pilot Design (issue #27)

- Status: **Design complete, implementation deferred** (privacy review below must be signed off first)
- Date: 2026-08-06
- Scope: **outside the MVP milestones.** No MVP schema, detector, ingestion, or merchant-facing change.
- Companions: [product brief](./sightline_product_brief_v3.md) (Gate 1/Gate 2 framing), [development plan §15](./free_mvp_development_plan.md), [ADR-003](./adr/ADR-003-retention-deletion.md) (retention), [data inventory](./data-inventory.md), [security review](./security-review.md)

## 1. What this is

Gate 2 is a **commercial-validation instrument, not a feature.** It answers one question:

> Do real stores throw operational gaps often enough, in large enough clumps, to build a paid recovery tier on?

It is deliberately **not** the paid tier. Longer retention and write capabilities (`long_retention`, `replay`, `reannounce`, `repair` in `src/capabilities.ts`) stay hard-`false`; nothing here grants a capability or writes to Shopify.

**It is also not Gate 1.** The two gates answer different questions and neither substitutes for the other:

| | Question | Cost | Consequence of failure |
|---|---|---|---|
| **Gate 1** | *Can* we deliver recovery at all — does a tag pulse make third-party sync apps re-process a record? | One afternoon, dev store | Recovery collapses to feeds-plus-artifacts; the tier needs rescoping before any product code |
| **Gate 2** (this doc) | Is there enough pain to sell it? | Two weeks, 5–10 stores | Sightline is an insurance sale — a harder App Store motion |

Gate 1 is currently untracked and unrun. It is the cheaper and more decisive of the two, and it gates the paid tier more fundamentally than this does.

## 2. Constraints that shape the design

1. **The ledger is purged at 7 days** with real DELETEs (ADR-003). A two-week measurement therefore **cannot be queried at the end** — the first week is physically gone.
2. **The detector deadline is 72 hours** (`FULFILLMENT_DEADLINE_MS`). An order paid on day 12 of a 14-day run cannot become a finding inside the run, and findings opened near the end are still unconfirmed at export.
3. **No MVP schema or detector change** (issue #27 acceptance criteria). Every measure is derived from rows that already exist.
4. **No customer PII exists to leak** — the model stores no name, email, phone, or address (data inventory). The residual privacy question is about *merchant* business data, not consumer data.

Constraint 1 is resolved by **exporting periodically inside the retention window** rather than accumulating state in-cluster: each export looks back ≤ 6 days, and the operator concatenates them. That keeps the 7-day retention promise, the privacy disclosure, and the schemas all unchanged — the alternative (a longer-retention aggregate table) would require a disclosure carve-out and explicit consent for storage, and buys only the removal of a manual step.

## 3. Source rows

All already present, all tenant-scoped:

| Table | Used for |
|---|---|
| `GapFinding` | incident existence, `detectedAt`, `resolvedAt`, `status`, `ruleVersion`, `evidenceEventIds` |
| `Expectation` | `deadline`, `state`, `createdAt` — the rule in force per order |
| `OrderProjection` | eligibility denominator (`paidAt`, `requiresFulfillment`), disposition (`fulfilledAt`, `cancelledAt`, `fullyRefundedAt`) |
| `OperationalEvent` | resolution provenance (`source`), unit counts (`fulfillableItemCount`), domain volumes |

## 4. Measures

Six required by the issue, plus two derived measures the same data supports for free and which materially change how the result reads.

### 4.1 Incident rate — *required*

Findings per **eligible order**, not a raw count (a raw count just scales with store size).

- Numerator: `GapFinding` rows with `detectedAt` in the bucket.
- Denominator: `OrderProjection` rows with `paidAt` in the bucket **and** `requiresFulfillment` — i.e. orders that could legitimately produce an expectation.
- Reported as **incidents per 100 eligible orders**, per store, per day.

### 4.2 Duration — *required*

Two distinct clocks, kept separate because they mean different things:

- **Incident duration** = `resolvedAt − detectedAt` on resolved findings — how long a gap stayed open once flagged.
- **Time to confirmation** = `fulfilledAt − paidAt` across *all* eligible orders — what normal operations look like. This is what calibrates the deadline constant (§4.8).

Report median and p90 over **resolved** findings only, plus `openAtExport` as its own count. Never average censored observations into a duration — a finding still open at export has an unknown duration, not a short one.

### 4.3 Affected records — *required*

- Orders per incident is 1 by construction (the detector is per-order), so the meaningful figures are **affected orders per store-day** and **affected units** (`fulfillableItemCount` on the order's events).
- Plus **burstiness** (§4.7), which is where the commercial signal actually lives.

### 4.4 Lane — *required*

For findings, "lane" is the **terminal disposition** — how the awaiting-confirmation state ended:

`fulfilled` (resolved) · `cancelled` (suppressed) · `fully_refunded` (suppressed) · `still_open` (censored)

Event-domain volumes (order / fulfillment / inventory / refund) ship alongside as context on where activity concentrates.

### 4.5 Rule version — *required*

`ruleVersion` is stamped on every `GapFinding` and `Expectation`. Every measure is **grouped by `ruleVersion`**, and each export header records the deadline constant in force, so a mid-pilot rule change cannot silently blend two populations into one rate.

### 4.6 Resolution source — *required*

When a finding resolves, which evidence resolved it?

**Derivation, and the tiebreak matters.** An order can carry **both** a webhook and a reconciliation success event — reconciliation upserts a deterministic `recon:<shop>:<order>:fulfilled` row that sits alongside whatever the webhook wrote. So take the fulfillment events with `state = 'success'` for the order and pick the one with the **earliest `receivedAt`** — when Sightline first *learned* of the confirmation. Not `occurredAt`: reconciliation stamps the order's own source timestamps, so ordering by `occurredAt` would frequently credit reconciliation for a confirmation the webhook actually delivered first. Getting this backwards would inflate the headline number in §4.6 in the flattering direction, which is exactly the direction to be careful about.

Then read that event's `source`:

- `webhook` — Shopify delivered the confirmation, just later than the deadline. Ambiguous: possibly a slow warehouse, possibly a conservative deadline.
- `reconciliation` — the Admin API sweep found a fulfillment **no webhook ever delivered**. This is direct evidence of real delivery loss.

**This is the single most commercially meaningful number in the pilot.** It quantifies how often the parallel recorder catches something the merchant's own vendor subscriptions would also have missed — which is the entire premise of the product. A high incident rate with ~0% reconciliation-resolved is a story about slow fulfillment; the same rate with a meaningful reconciliation share is a story about broken pipes.

### 4.7 Burstiness — *derived, not in the issue, and load-bearing*

Do incidents arrive in clumps or singly? Measured as the distribution of incidents per store per rolling hour, and the share of incidents belonging to a burst of ≥3 within an hour.

This matters because the paid tier's pitch is "742 orders at once, one button." If incidents are overwhelmingly **singletons**, bulk replay is worth far less than the brief assumes and the value proposition shifts toward long-tail hygiene. A go decision taken on rate alone could fund the wrong product.

### 4.8 Deadline sensitivity — *derived*

The 72-hour deadline is an unvalidated product constant, so the incident rate is partly a function of a guess. From the `paid → fulfilled` distribution (§4.2), re-derive what the incident rate *would have been* at 48h / 72h / 96h / 120h. Cheap, and it turns "the rate is X" into "the rate is X, and here is how sensitive that is to the one number we made up."

## 5. Export mechanism

A **read-only, operator-only** export. Specified here; **not implemented** (see §8).

```
GET /pilot/export?shops=<explicit list>&since=<ms>&until=<ms>&shape=daily|incidents
```

- **Never merchant-facing.** Not on the embedded app surface, not reachable with a Shopify session JWT. Gated behind a new operator capability that `capabilitiesFor()` never grants to a merchant, plus Harper-level operator auth.
- **Explicit shop allowlist, no roster in the database.** The export refuses any shop not named in the request. Consent is a contractual artifact held by the operator, not app state — which is both more honest and avoids the `Shop` schema change that criterion 2 forbids.
- **Bounded lookback** of ≤ 6 days per call, matching the retention window with a day of margin.
- **Pseudonymous.** `shop = HMAC-SHA256(pilotSalt, shopId)`, truncated. The salt lives with the operator, never in the component. Deterministic, so exports from different weeks join; non-reversible without the salt.
- **No record identifiers.** No `orderId`, no `findingId`, no `eventId`, no SKUs (a catalog identifies a store). Incident rows carry hour-bucketed timestamps, which is granular enough for burstiness and coarse enough not to pinpoint an order.

Two shapes:

```
daily      shop, day, ruleVersion, eligibleOrders, incidents, resolved, suppressed,
           stillOpen, medianDurationMs, p90DurationMs, affectedUnits,
           resolvedByWebhook, resolvedByReconciliation, lane counts,
           domainEventCounts{order,fulfillment,inventory,refund}

incidents  shop, detectedHour, ruleVersion, deadlineMs, lane,
           durationMs|null (null = still open at export), resolutionSource|null,
           affectedUnits
```

Header on every export: `apiVersion`, `ruleVersion`, `deadlineMs`, `windowStart`, `windowEnd`, `exportedAt`, `shopCount`.

## 6. Pilot protocol

**Participants.** 5–10 agency-managed stores fitting the ICP: growing merchants with **real downstream fan-out** (3PL / ERP / warehouse / analytics on their own webhook subscriptions). Explicitly exclude long-tail stores whose operations live entirely inside Shopify — they have nothing to record, so they are guaranteed quiet and would bias the result toward no-go.

**Duration.** 14 days, of which:

| Days | Phase | Why |
|---|---|---|
| 1–3 | Warm-up, **excluded from analysis** | Install backfill and reconciliation settle; and with a 72h deadline no finding can exist yet |
| 4–14 | Analysis window (11 usable days) | |

**Export cadence.** Day 6, day 13, and a final export on day 15 (to catch findings opened late on day 14). **Hard rule: never more than 6 days between exports** — a longer gap loses data permanently to the purge, and it cannot be recovered.

**Consent.** A written pilot agreement per store before install, naming: what is measured, that the export is aggregated and pseudonymized with no customer data, who can access it, how long it is kept, and that consent can be withdrawn at any time.

**Roles.** Operator runs exports on schedule · analyst aggregates and computes §4 · release owner takes the go/no-go against §7 thresholds.

## 7. Go/no-go thresholds

**Pre-registered — these are set before the run and not renegotiated after seeing the data.** That is the entire discipline of a gate; thresholds chosen afterwards will rationalise whatever the pilot happens to show. Numbers below are the proposal and require **release-owner sign-off before day 1**.

**GO — fund Recover.** All four:

1. Median store ≥ **1.0 incidents per 100 eligible orders** over the analysis window.
2. ≥ **50%** of participating stores show ≥ 1 incident.
3. ≥ **25%** of incidents are **reconciliation-resolved** (§4.6) — genuine delivery loss, not merely slow fulfillment.
4. ≥ **20%** of incidents belong to a burst of ≥ 3 within an hour (§4.7) — bulk replay has something to act on.

**NO-GO — rescope to insurance/hygiene positioning.** Either:

- Median < **0.2** incidents per 100 eligible orders, or
- more than half of participating stores show **zero** incidents.

**AMBIGUOUS — extend or re-scope, do not force a call.** Anything between the two, or any of:

- \> **30%** of incidents censored (still open at final export) — durations are unreliable.
- GO on rate but failing (3) — real pain, but a *fulfillment-speed* story, not a broken-pipes story. Different product.
- GO on rate but failing (4) — real pain, but a long-tail story. Bulk replay is not the wedge.

An ambiguous result is a legitimate outcome and must be reported as **underpowered**, never as "no demand." With 5–10 stores over 11 days against a rare event, absence of evidence is genuinely weak evidence of absence.

## 8. Privacy review

**Determination: no new personal data is processed, and no in-cluster storage is added.**

| Question | Finding |
|---|---|
| Customer PII in the export? | **None.** The model stores no name, email, phone, or address (data inventory), so none can be exported. No SKUs either — a catalog is store-identifying. |
| Merchant-identifying data? | Only a **salted HMAC pseudonym**. The salt is operator-held and never in the component; without it the export does not identify a store. |
| New persisted data in Harper? | **None.** Nothing is written; the export is a read. The 7-day retention promise and the merchant-facing privacy disclosure are **unchanged** — this is the main reason for choosing periodic export over an aggregate table. |
| Legal basis | Written per-store pilot consent (§6), obtained before install. |
| Where do exports live? | An access-controlled operator location named in the pilot agreement. **Not** in the repo, not in Harper, not in a shared drive with open link access. |
| Export retention | Raw exports deleted **90 days** after the final export or on go/no-go sign-off, whichever is sooner. The go/no-go memo — banded and aggregate, no per-store rows — is retained indefinitely. |
| Sharing | Any output shared beyond the release owner uses **volume bands** (e.g. <100 / 100–500 / 500–2000 / 2000+ eligible orders per week) instead of exact per-store counts, since an exact count plus a known participant list can re-identify a store. |

**Compliance interaction — the part that needs writing down.** `shop/redact`, `customers/redact`, and `app/uninstalled` delete in-cluster rows, but a compliance webhook **cannot reach an export the operator already holds.** Therefore, as an operational obligation on the operator:

- On a participant's uninstall, redaction request, or consent withdrawal: **stop exporting that shop immediately**, and **delete that pseudonym's rows** from every held export (the operator can map shop → pseudonym via the salt).
- Deleting the salt at the end of the pilot severs the last link between exports and stores; do this once the go/no-go is signed.

**Sign-off required before implementation:** release owner (privacy + commercial), per issue #27 criterion 3. This section is the review; it is not self-approving.

## 9. Threats to validity

Written here so the go/no-go reads honestly rather than as a clean number.

1. **The 72h deadline eats the window.** Only ~11 of 14 days can produce findings, and orders paid in the final 3 days cannot.
2. **Right-censoring.** Findings opened near the end are unresolved at export; their durations are unknown, not short.
3. **Deliberate selection bias.** Agency-managed, fan-out-heavy stores are the ICP, not a representative sample of Shopify. The result generalises to the ICP only — which is the point, but must not be reported as a platform-wide rate.
4. **Absence is not failure.** A finding means Sightline did not observe a confirmation. Only the reconciliation-resolved share (§4.6) is strong evidence of a real broken pipe.
5. **Small n.** 5–10 stores cannot produce a precise rate. This is a directional decision instrument, not a measurement study.
6. **The rate depends on a guessed constant.** Mitigated but not removed by the sensitivity analysis (§4.8).

## 10. Implementation checklist (deferred)

Not to be built until §8 is signed off:

- [ ] Release-owner sign-off on §7 thresholds and §8 privacy determination.
- [ ] Operator capability + Harper-level auth for the export route; confirm it is unreachable from a Shopify session and absent from the embedded surface.
- [ ] `pilotSalt` provisioning and custody (operator-held; see [secrets custody notes](./security-review.md)).
- [ ] Export resource over existing query helpers — read-only, bounded lookback, explicit shop allowlist, field-allowlisted like every other resource in `apiContract.ts`.
- [ ] Cross-tenant test: the export must refuse any shop absent from the allowlist, and must never emit `orderId`, `eventId`, `findingId`, or SKU.
- [ ] Export-cadence runbook entry (a missed pull loses data irrecoverably).
- [ ] Pilot agreement template.

## 11. Out of scope

No detector or schema change · no write capability, replay, re-announcement, or repair · no merchant-facing pilot UI · no cross-store dashboard · no longer retention · **Gate 1 execution**, which is a separate and higher-priority prerequisite for the paid tier.
