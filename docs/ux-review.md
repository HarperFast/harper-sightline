# Sightline — Free-MVP UX & Content Review (issue #16)

- Date: 2026-08-05, revised 2026-08-06 (second pass: closed every deferral below and corrected one review verdict — see §7)
- Scope: the implemented embedded SPA (`app/web/`) reviewed against the committed [screen specification](./free_mvp_screen_spec.md). Because the functional UI already shipped (#17–#20), this is the implementation-grade design record + a content/terminology/accessibility review, plus the fixes it drove.
- Companion: [screen spec](./free_mvp_screen_spec.md) (design source), [security review](./security-review.md) (privacy disclosures), annotated [App Store concept](./sightline_shopify_app_store_mock.html).

## 1. Screen & state coverage

Global states the spec requires on every screen: **loading, empty, partial, stale/reconciliation-delayed, authorization-expired, recoverable-error**. Status by screen (against `app/web/src/main.ts`):

| Screen | loading | empty | error (retry) | auth-expired | stale | partial | Notes |
|---|---|---|---|---|---|---|---|
| First-open/setup | ✓ | n/a | ✓ (Check again) | ✓ | n/a | n/a | Three-step stepper from `GET /api/v1/setup`, every step derived from durable state (spec §1). A blocked step offers reauthorization, never a Shopify write. First open lands here while the initial check runs. |
| Overview | ✓ | ✓ ("nothing awaiting confirmation") | ✓ | ✓ | ✓ | ✓ | Health is a separate banner from finding counts — an unhealthy recorder never renders as "no gaps" (spec §2). **Needs attention** list, **Activity over time** with a table equivalent, a reconciliation-delayed banner, and a "history still building" notice while backfill runs. Panels load independently, so one failure degrades to partial data. |
| Events (list) | ✓ | ✓ ("No events match") | ✓ | ✓ | ✓ (strip) | n/a | **Source** column plus the full spec §3 filter set: time range, domain, topic, resource ID, SKU, evidence source — all reflected in the URL. |
| Event detail | ✓ | n/a | ✓ | ✓ | ✓ (strip) | n/a | Normalized fields, source/receipt time, related events, projection/finding impact, and an explicit note when receipt lagged occurrence. No raw payload / PII. |
| Findings (list) | ✓ | ✓ ("nothing is missing confirmation") | ✓ | ✓ | ✓ (strip) | n/a | Spec §4 columns: order, paid, confirmation expected by, open-for, status. Carries the claim-boundary line. |
| Finding detail | ✓ | n/a | ✓ | ✓ | ✓ (strip) | ✓ | **What Sightline observed** timeline, **Why this qualified** bullets, the verbatim spec §4 disclaimer, evidence links, rule version, last-reconciled. Last-reconciled failing degrades without breaking the finding. |
| Privacy | ✓ | ✓ | ✓ | ✓ | ✓ | n/a | No-PII banner, shop, granted scopes, data categories, **what we never store**, webhook + reconciliation health, deletion, footprint. |

A global context strip (window, recording health, last reconciliation, active timezone) renders on **every** screen, which is where the shared stale/reconciliation-delayed signal lives; screens whose own payload carries it (Overview, Privacy) also state it inline.

## 2. Accessibility & no-color / table alternatives

Spec: keyboard + screen-reader accessible; visualizations have equivalent text/table summaries; meaning survives without color.

- **Keyboard navigation (fixed in this PR):** whole-row links (Events, Findings, Needs-attention) were click-only. They now carry `role="link"` + `tabindex="0"`, activate on **Enter/Space**, and show a visible `:focus-visible` outline. Filters/search are native form controls (already keyboard-operable) and now carry `aria-label`s and `role="search"`.
- **Screen reader:** loading uses `role="status"`; error/auth-expired use `role="alert"`; row links have descriptive `aria-label`s; data is in real `<table>`/`<dl>` semantics.
- **No-color:** the "Flow" visualization is a **label + count list** — it is already its own table-equivalent and conveys magnitude by number, not color. Status **badges pair color with the status word** (e.g. "unconfirmed"), so they read without color. The overview's order/finding stats are numeric tiles. **Activity over time** encodes magnitude as bar *height* with a per-domain total beside it, carries the same numbers in its `role="img"` label, and ships an exact per-day table behind "View activity as a table".
- **Contrast/theme:** light + dark via `prefers-color-scheme`; ok/warn tones have text labels, not color alone.
- **Timestamps:** every rendered time is a `<time datetime="…">` element with the full absolute instant in its `title`, so hover and assistive tech both get an unambiguous value. Display uses the **store's configured timezone** — `shop.ianaTimezone`, read from the Admin API and cached on the Shop record by the reconcile sweep, delivered to the SPA on the session so the first paint is already correct. Until the first sweep caches it (and if the browser's ICU doesn't recognise the zone) the viewer's zone is used instead. The context strip always names the zone in force *and whose it is* — "Times in America/New_York (store time)" vs "(your device)" — so a displayed time is never ambiguous and never silently mislabelled.
- **Narrow iframe:** every wide table is wrapped in an `overflow-x: auto` container, so tables scroll inside their own box and the iframe body never scrolls horizontally. A `max-width: 600px` breakpoint collapses the definition-list grid to one column, reflows filters, and tightens padding.

## 3. Content & terminology review (product + security sign-off)

The load-bearing product-truth boundary: an absence finding means **"Sightline has not observed the expected Shopify confirmation,"** never that a warehouse/carrier/3PL failed.

- **Findings copy — APPROVED (after a correction; see §7).** The finding description comes from `describeFinding` (detector, #14), which is non-accusatory, and the overview "Needs attention" row reads **"No Shopify fulfillment confirmation observed"** — not "failed". No screen renders replay/recovery/repair controls or downstream-failure language. The spec §4 disclaimer — *"This does not prove that a warehouse or carrier failed. It means Shopify has not shown the expected fulfillment confirmation yet."* — is now rendered **verbatim** on the detail screen of every unconfirmed finding, held in the `FINDING_DISCLAIMER` constant so it cannot drift; the findings list carries a shorter standing version of the same boundary. The verbatim sentence is scoped to `unconfirmed` deliberately: on a resolved or suppressed finding "has not shown … yet" would be false, and those states carry their own accurate description instead.
- **Privacy disclosures — APPROVED.** The Privacy screen leads with "No customer PII is stored" (no name/email/phone/address), lists the exact data categories, retention (7 days), and deletion behavior. This matches the [data inventory](./data-inventory.md) and [security review §4](./security-review.md). No secrets, tokens, cluster names, or global tenant metrics appear (spec §5).
- **Capability discipline — APPROVED.** The UI checks capabilities and shows only `record`; no paid/replay affordance exists in the shipped SPA.

## 4. App Store concept correction

`docs/sightline_shopify_app_store_mock.html` is a **product-direction artifact**, not acceptance criteria (plan §"tone by design"). It is now **annotated**, not rewritten: a sticky high-contrast banner (and a `<title>` marker) states it is a concept, enumerates what does **not** ship in free Record (replay/recovery/repair, "failed flow"/destination-health claims, "1-click", pricing, and the illustrative reviews/5.0 rating), and points to this review + the screen spec + the real UI. The actual listing correction (removing those claims from the published creative) is tracked in **#26 (App Store readiness)**.

One further open decision, not a defect: the spec's header line says "Use Shopify App Home page patterns, App Bridge, and Polaris web components." App Bridge is loaded, but the SPA is hand-rolled HTML with Polaris-approximating CSS tokens rather than Polaris web components. It is accessible and functional; it will not look native in Admin. That is not an App Store blocker but it is a Built-for-Shopify one, and it should be an explicit accept-or-port decision under #26 rather than an undocumented divergence.

## 5. Changes made

**First pass (2026-08-05)** — surgical, spec-aligned fixes to `app/web/`, no API changes:

1. Keyboard-operable row links + `:focus-visible` outline (accessibility).
2. Events list **Source** column (spec §3).
3. Distinct **authorization-expired** state (401 → reauthorize message, not a generic error) + a **Retry** button on recoverable errors (spec global states).
4. Overview **Needs attention** list of recent unconfirmed orders with non-accusatory copy (spec §2).
5. Finding detail **Why this qualified** eligibility bullets (spec §4).
6. `aria-label`/`role` annotations on rows, filters, and status regions.

**Second pass (2026-08-06)** — closed the §6 deferrals and the two gaps the first pass missed. This one *did* need read-API additions, all field-allowlisted in `apiContract.ts` and covered by `test/queries.test.ts` + the adversarial `test/crossTenant.test.ts`:

7. **The verbatim spec §4 disclaimer** on finding detail (the correction in §7) plus a standing boundary line on the findings list.
8. **First-open/setup screen** (spec §1) behind a new `GET /api/v1/setup`. Steps derive from durable state — the shop record, the credential, and the reconcile sweep's own completion marker — never a client timer. First open routes here (via `replaceState`, so no double render) while the initial check runs, and Overview warns that history is still building: the spec's "does not imply history exists before backfill completes". A blocked step offers reauthorization and nothing else; no setup affordance writes to Shopify.
   - The capture step keys on the **credential**, not on an observed delivery. Deliveries are the 7-day ledger and get purged, so keying the step on them would flip a healthy but *quiet* store back to "not set up" a week after install and bounce a returning merchant to the first-open screen. Whether anything has actually arrived is reported separately as `eventsObserved`, so the step can read "Connected — no events yet" without ever claiming capture that was not observed. Both cases are pinned by tests (`getSetup stays complete for a connected shop that has simply been quiet`).
9. **Reconciliation freshness + stale state.** `reconcileShop` now writes `lastReconciledAt`/`reconciliationState` per shop; `getSummary`/`getPrivacy` expose a `reconciliation` view whose `stale` flag reuses `opsHealth`'s `RECONCILE_STALE_MS`, so the merchant banner and the operator alert agree. A never-reconciled shop reports `ageMs: null` and cannot render as "reconciled just now".
10. **Global context strip** on every screen: window, recording health, last reconciliation, active timezone. Shares one cached `summary` request with the Overview.
11. **Activity over time** (spec §2) folded into the existing `summary` event scan — seven daily buckets by domain, so it costs no extra pass over the ledger — with the required table equivalent.
12. **Events filters completed**: time range (symbolic in the URL, so a shared filter stays meaningful), topic, and evidence source. `source` needed a new `listEvents` condition + allowlist entry; `topic`/`since`/`until` were already allowlisted server-side.
13. **Findings list spec §4 columns** (paid, confirmation expected by), joined per row from the projection/expectation under a `FINDING_LIST_FIELDS` allowlist. Both sides are tenant-checked before any field is copied — `listFindings join never crosses tenants` asserts an s2 finding cannot inherit s1's identically-keyed order facts.
14. **Finding detail "What Sightline observed" timeline** (spec §4), chronological, every entry an observation with a source timestamp.
15. **Privacy screen completed to spec §5**: shop, granted scopes, a "what we never store" exclusion list, webhook capture health, reconciliation health. Two tests assert the payload carries no token material and no other tenant's counts.
16. **Accessible exact timestamps** (`<time datetime>` + title + named zone) and **narrow-iframe behavior** (scroll containers, 600px breakpoint).

## 6. Deferrals — none outstanding

The one item left open after the second pass, **true shop-timezone rendering**, is now implemented (§2): `Shop.ianaTimezone` added to the sealed schema, read via `shop { ianaTimezone }` and cached by the reconcile sweep, carried to the SPA on the session payload, with a labelled fallback to the viewer's zone. Recorded in the [pinned Shopify contract](./shopify-contract.md) §6 as a display-only read that can never fail reconciliation.

> **Deploy note:** this added a column to a `@sealed` table, which `deploy_component` has intermittently dropped on an existing table. Verify with `describe_table` on `sightline_core.Shop` after deploying and confirm `ianaTimezone` is present; if it is missing, redeploy before relying on store-timezone rendering. The UI degrades to the viewer's zone (correctly labelled) if the column never materialises, so a dropped column is a cosmetic regression, not an outage.

## 7. Correction to the first pass

The first pass marked findings copy **APPROVED** on the strength of `describeFinding` being non-accusatory and the detail screen's "observed-evidence framing." That verdict was wrong on one point: the spec §4 disclaimer sentence existed only in `free_mvp_screen_spec.md` and as a code comment in `main.ts` — **it was never rendered**. The load-bearing product-truth guardrail for the whole app was absent from the shipped UI while the review recorded it as satisfied. It now renders verbatim from a named constant (§5 item 7).

Two process notes worth keeping: the first pass's own coverage table had **no row for the setup screen**, so the missing spec §1 screen read as out-of-scope rather than as a gap — a review table built from the shipped code inherits that code's omissions. And #17 ("Implement setup, overview, and health experience") closed with the setup half unbuilt. Reviews of already-shipped UI should enumerate screens from the **spec**, not from the router.
