# Sightline — Free-MVP UX & Content Review (issue #16)

- Date: 2026-08-05, revised 2026-08-06 (second pass: closed every deferral below and corrected one review verdict — see §7)
- Scope: the implemented embedded SPA (`app/web/`) reviewed against the committed [screen specification](./free_mvp_screen_spec.md). Because the functional UI already shipped (#17–#20), this is the implementation-grade design record + a content/terminology/accessibility review, plus the fixes it drove.
- Companion: [screen spec](./free_mvp_screen_spec.md) (design source), [security review](./security-review.md) (privacy disclosures).

## 1. Screen & state coverage

Global states the spec requires on every screen: **loading, empty, partial, stale/reconciliation-delayed, authorization-expired, recoverable-error**. Status by screen (against `app/web/src/main.ts`):

| Screen | loading | empty | error (retry) | auth-expired | stale | partial | Notes |
|---|---|---|---|---|---|---|---|
| First-open/setup | ✓ | n/a | ✓ (Check again) | ✓ | n/a | n/a | Three-step stepper from `GET /api/v1/setup`, every step derived from durable state (spec §1). A blocked step offers reauthorization, never a Shopify write. First open lands here while the initial check runs. |
| Overview | ✓ | ✓ ("nothing awaiting confirmation") | ✓ | ✓ | ✓ | ✓ | Health is a separate banner from finding counts — an unhealthy recorder never renders as "no gaps" (spec §2). **Needs attention** list, **Activity over time** with a table equivalent, a reconciliation-delayed banner, and a "history still building" notice while backfill runs. Panels load independently, so one failure degrades to partial data. |
| Events (list) | ✓ | ✓ ("No events match") | ✓ | ✓ | ✓ (strip) | n/a | **Source** column plus the full spec §3 filter set: time range, domain, topic, resource ID, SKU, evidence source — all reflected in the URL. |
| Event detail | ✓ | n/a | ✓ | ✓ | ✓ (strip) | n/a | Normalized fields, source/receipt time, related events, projection/finding impact, and an explicit note when receipt lagged occurrence. No raw payload / PII. |
| Orders (worklist) | ✓ | ✓ ("No orders match") | ✓ | ✓ | ✓ (strip) | n/a | Spec §4 columns: order, lane, paid, waiting, value, tracking, Admin link. Lane/age/sort filters reflected in the URL. A failed fulfillment attempt renders as a distinct flag on the row, separate from the lane badge. |
| Order detail | ✓ | n/a | ✓ | ✓ | ✓ (strip) | ✓ | Spec §5: the observed timeline (every entry a direct observation with a source timestamp), the order's own events and findings, and the Admin deep link. An order with only a payment still renders, with an empty-state note rather than a blank timeline. |
| Findings (list) | ✓ | ✓ ("nothing is missing confirmation") | ✓ | ✓ | ✓ (strip) | n/a | Spec §6 columns: order, paid, confirmation expected by, open-for, status. Carries the claim-boundary line. |
| Finding detail | ✓ | n/a | ✓ | ✓ | ✓ (strip) | ✓ | **What Sightline observed** timeline, **Why this qualified** bullets, the verbatim spec §6 disclaimer, evidence links, rule version, last-reconciled. Last-reconciled failing degrades without breaking the finding. |
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

- **Findings copy — APPROVED (after a correction; see §7).** The finding description comes from `describeFinding` (detector, #14), which is non-accusatory, and the overview "Needs attention" row reads **"No Shopify fulfillment confirmation observed"** — not "failed". No screen renders replay/recovery/repair controls or downstream-failure language. The spec §6 disclaimer — *"This does not prove that a warehouse or carrier failed. It means Shopify has not shown the expected fulfillment confirmation yet."* — is now rendered **verbatim** on the detail screen of every unconfirmed finding, held in the `FINDING_DISCLAIMER` constant so it cannot drift; the findings list carries a shorter standing version of the same boundary. The verbatim sentence is scoped to `unconfirmed` deliberately: on a resolved or suppressed finding "has not shown … yet" would be false, and those states carry their own accurate description instead.
- **Privacy disclosures — APPROVED.** The Privacy screen leads with "No customer PII is stored" (no name/email/phone/address), lists the exact data categories, retention (7 days), and deletion behavior. This matches the [data inventory](./data-inventory.md) and [security review §4](./security-review.md). No secrets, tokens, cluster names, or global tenant metrics appear (spec §7).
- **Failed-attempt copy — APPROVED, reviewed separately from the absence copy.** "Shopify recorded a fulfillment attempt for this order that did not succeed" (the Orders worklist flag and order-detail timeline entry) is DIRECT evidence — Shopify itself recorded the attempt — so it is deliberately not hedged the way an absence finding is, and it carries no absence disclaimer, because it is not reporting an absence. It still names no downstream party: "did not succeed" is Shopify's own record of the attempt, not an accusation against a warehouse, carrier, or 3PL. The two copies read differently on purpose and must not be reconciled to a single template.
- **Capability discipline — APPROVED.** The UI checks capabilities and shows only `record`; no paid/replay affordance exists in the shipped SPA.

## 4. App Store concept correction

The App Store listing concept (`docs/sightline_shopify_app_store_mock.html`) was a **product-direction artifact**, not acceptance criteria (plan §"tone by design"). The second pass annotated it rather than rewriting it: a sticky banner and a `<title>` marker stated it was a concept and enumerated what does **not** ship in free Record — replay/recovery/repair, "failed flow"/destination-health claims, "1-click", pricing, and the illustrative reviews/5.0 rating.

**It has since been deleted** (2026-08-26). Four documents carried a warning about a file whose whole purpose was to show something the product deliberately does not do, which is a liability rather than a reference. The list of claims that must not reach the published creative — the part #26 actually needs — now lives in the [App Store review checklist](./app-store-review-checklist.md) §3, and the concept is recoverable from git history if the creative ever needs diffing against it. The real UI, the [screen spec](./free_mvp_screen_spec.md), and this review are the design sources.

The spec's header line — "Use Shopify App Home page patterns, App Bridge, and Polaris web components" — is now satisfied. The SPA was ported off hand-rolled CSS onto Polaris web components (`polaris.js` from `cdn.shopify.com`): `s-page`/`s-section` structure, `s-banner`, `s-badge`, `s-table`, `s-select`/`s-text-field`, `s-grid`/`s-box`, `s-link`, `s-button`, `s-spinner`, `s-unordered-list`. Local CSS is down to the activity bars alone, which have no Polaris equivalent and are sized in `em`/`currentColor` so they inherit Admin typography and theming.

Three notes on the port:

- **Row navigation is now real links.** The pre-port tables used whole-row `role="link"` + `tabindex` + Enter/Space handlers. Each row's first cell is now an `s-link`, so keyboard operation, focus ring, and screen-reader semantics come from the platform instead of from our own handlers — the `bindRowLinks` shim is gone.
- **Filters are read from element properties, not `FormData`.** Polaris fields hold their value as a property, so a native form submit cannot see them; each filter is read explicitly by id, and Enter within the filter group submits.
- **Navigation is duplicated on purpose, for now.** `s-app-nav` puts the sections in Admin's own sidebar (the native pattern), but it renders only inside real Admin and cannot be verified from local dev. The in-page nav is kept as a guaranteed fallback so the app can never ship unnavigable. **Once `s-app-nav` is confirmed in the live embed, drop the in-page nav** (`.appnav` in `index.html`).

## 5. Changes made

**First pass (2026-08-05)** — surgical, spec-aligned fixes to `app/web/`, no API changes:

1. Keyboard-operable row links + `:focus-visible` outline (accessibility).
2. Events list **Source** column (spec §3).
3. Distinct **authorization-expired** state (401 → reauthorize message, not a generic error) + a **Retry** button on recoverable errors (spec global states).
4. Overview **Needs attention** list of recent unconfirmed orders with non-accusatory copy (spec §2).
5. Finding detail **Why this qualified** eligibility bullets (spec §6).
6. `aria-label`/`role` annotations on rows, filters, and status regions.

**Second pass (2026-08-06)** — closed the §6 deferrals and the two gaps the first pass missed. This one *did* need read-API additions, all field-allowlisted in `apiContract.ts` and covered by `test/queries.test.ts` + the adversarial `test/crossTenant.test.ts`:

7. **The verbatim spec §6 disclaimer** on finding detail (the correction in §7) plus a standing boundary line on the findings list.
8. **First-open/setup screen** (spec §1) behind a new `GET /api/v1/setup`. Steps derive from durable state — the shop record, the credential, and the reconcile sweep's own completion marker — never a client timer. First open routes here (via `replaceState`, so no double render) while the initial check runs, and Overview warns that history is still building: the spec's "does not imply history exists before backfill completes". A blocked step offers reauthorization and nothing else; no setup affordance writes to Shopify.
   - The capture step keys on the **credential**, not on an observed delivery. Deliveries are the 7-day ledger and get purged, so keying the step on them would flip a healthy but *quiet* store back to "not set up" a week after install and bounce a returning merchant to the first-open screen. Whether anything has actually arrived is reported separately as `eventsObserved`, so the step can read "Connected — no events yet" without ever claiming capture that was not observed. Both cases are pinned by tests (`getSetup stays complete for a connected shop that has simply been quiet`).
9. **Reconciliation freshness + stale state.** `reconcileShop` now writes `lastReconciledAt`/`reconciliationState` per shop; `getSummary`/`getPrivacy` expose a `reconciliation` view whose `stale` flag reuses `opsHealth`'s `RECONCILE_STALE_MS`, so the merchant banner and the operator alert agree. A never-reconciled shop reports `ageMs: null` and cannot render as "reconciled just now".
10. **Global context strip** on every screen: window, recording health, last reconciliation, active timezone. Shares one cached `summary` request with the Overview.
11. **Activity over time** (spec §2) folded into the existing `summary` event scan — seven daily buckets by domain, so it costs no extra pass over the ledger — with the required table equivalent.
12. **Events filters completed**: time range (symbolic in the URL, so a shared filter stays meaningful), topic, and evidence source. `source` needed a new `listEvents` condition + allowlist entry; `topic`/`since`/`until` were already allowlisted server-side.
13. **Findings list spec §6 columns** (paid, confirmation expected by), joined per row from the projection/expectation under a `FINDING_LIST_FIELDS` allowlist. Both sides are tenant-checked before any field is copied — `listFindings join never crosses tenants` asserts an s2 finding cannot inherit s1's identically-keyed order facts.
14. **Finding detail "What Sightline observed" timeline** (spec §6), chronological, every entry an observation with a source timestamp.
15. **Privacy screen completed to spec §7**: shop, granted scopes, a "what we never store" exclusion list, webhook capture health, reconciliation health. Two tests assert the payload carries no token material and no other tenant's counts.
16. **Accessible exact timestamps** (`<time datetime>` + title + named zone) and **narrow-iframe behavior** (scroll containers, 600px breakpoint).

**Third pass (2026-08-26)** — three merchant-facing findings from an outside review of the shipped app. No API changes; all three are in `view.ts`, plus one storage fix behind the second:

17. **Events opens as a list, not as a search form.** The screen led with seven filter controls (time range, from, to, domain, topic, state, evidence source, order id, SKU) before the first row of data — which reads as a developer console and asks a merchant to describe what they want before they have seen anything. The default view is now the recent activity itself, stated in words ("Everything Shopify has reported to Sightline in the last 7 days, newest first"), with the whole filter set behind one `<details>` disclosure. Details that matter:
    - The disclosure **opens itself whenever a filter is actually in force** (`isFiltered`), including for someone who opened a filtered link they did not build — a filter applying with its control hidden is a screen lying about why it is short. The chip row stays outside the disclosure either way, so what is filtered is always visible and removable.
    - **Export stays outside** the disclosure. It is the differentiator over Shopify's own activity log (view-only, 250 rows, no export) and must not be reachable only by opening the filters.
    - Every control stays in the DOM, so `main.ts`'s per-id reads are unchanged. A native `<details>` rather than a component: keyboard operation, the expanded/collapsed state announced to a screen reader, and find-in-page all come from the platform. `bindFilters` now ignores Enter raised on a `<summary>` — otherwise "submit the filters" would have made the disclosure impossible to open from the keyboard.
    - The two free-text filters carry an example and a one-line hint, because they are the two a merchant cannot guess: `resourceId` holds Shopify's **numeric** id, so someone typing the order name they can actually see (`#1023`) got an empty page that looks exactly like an empty ledger. The dropdowns whose meaning is not self-evident (Domain, Evidence source) got the same one-line hint.
    - The empty state now distinguishes "no events match these filters" from "no events recorded in the last 7 days" — unfiltered, there is nothing to *match*, and on a new install the second sentence is the true one.
18. **"Granted access: read-only scopes pending confirmation" (Privacy) was both alarming and permanent.** It reads to a merchant as a stuck app reporting its own bug — and it was not in fact pending: the granted scope list arrives with the token exchange, and only `installShop` (the OAuth-callback path, which managed install never takes) recorded it, so `Shop.scopes` stayed empty forever. Two changes: `recordExchangeOutcome` now writes the scope list on **every** path where a token arrives (first exchange and each refresh, so it also cannot go stale), and the fallback copy states what the app *asks for* — "Read-only access to orders, fulfillments, inventory, products and locations … never requests write access of any kind" — without claiming Shopify confirmed it back. The real badge list still wins whenever it has been recorded. Pinned by `test/lifecycle.test.ts` and a Privacy-copy test that fails on the words that read as an error state.
19. **Two findings for one order no longer scan as a duplicate row.** An order can be waiting for confirmation *and* carry a fulfillment attempt Shopify recorded as unsuccessful — separate detectors, separate rows by construction — but the list showed them as two unrelated rows with the same order name (`#1023`), which a merchant scanning quickly reads as a bug in the list. Rows for one order are now adjacent, each says which of its group it is ("1 of 2 for this order" — on every row, since a positional convention is invisible to someone reading one row or hearing one row), and a note explains what it means, rendered only when it is actually true of what is on screen. Deliberately conservative: purely presentational, first-appearance order of orders preserved, nothing merged, hidden, re-sorted or dropped.

Also in this pass, from the same review: `frame-ancestors` no longer trusts `?shop=`, and the read API is rate limited per shop — both in [security review](./security-review.md) §1.3 (F6, F7). The export failure alert now states the wait time a rate-limited export returns instead of a generic "Export failed".

## 6. Deferrals — none outstanding

The one item left open after the second pass, **true shop-timezone rendering**, is now implemented (§2): `Shop.ianaTimezone` added to the sealed schema, read via `shop { ianaTimezone }` and cached by the reconcile sweep, carried to the SPA on the session payload, with a labelled fallback to the viewer's zone. Recorded in the [pinned Shopify contract](./shopify-contract.md) §6 as a display-only read that can never fail reconciliation.

> **Deploy note:** this added a column to a `@sealed` table, which `deploy_component` has intermittently dropped on an existing table. Verify with `describe_table` on `sightline_core.Shop` after deploying and confirm `ianaTimezone` is present; if it is missing, redeploy before relying on store-timezone rendering. The UI degrades to the viewer's zone (correctly labelled) if the column never materialises, so a dropped column is a cosmetic regression, not an outage.

## 6b. UI test coverage

Until now the SPA was only ever *built* in CI, never exercised — the weakest layer in the MVP, and it had just grown. `app/web/src/view.ts` now holds every screen as a **pure function from data to markup**, with `main.ts` reduced to fetching, DOM writes, listener binding, and routing. That split makes the UI testable in plain node with no browser, DOM shim, or added dependency (the app still has zero runtime deps).

`app/test/view.test.ts` (43 cases) covers what a screenshot review would otherwise have to catch by eye:

- **Product truth** — the disclaimer appears verbatim on unconfirmed findings and is *absent* on resolved/suppressed, where its wording would be false; the boundary line is on the list; and no screen contains failure language or names a downstream party outside the two sentences that explicitly deny the claim.
- **Per-state rendering** — unhealthy recorder never reads as "no gaps"; stale reconciliation; never-reconciled ≠ "reconciled just now"; incomplete initial check; partial data (singular and plural); and a healthy overview showing *none* of those banners.
- **Setup** — quiet-store "Connected — no events yet" vs "Receiving events"; blocked steps offering reauthorization and *not* a pointless retry.
- **Escaping** — hostile order ids, topics, and filter values cannot inject markup or break out of an attribute.
- **Timezone** — the same instant under two zones renders differently (proving the zone is threaded through) while the `<time datetime>` instant is unchanged; an unknown zone falls back and says "your device" rather than claiming store time.
- **Accessibility** — the activity graphic's `aria-label` carries the same per-day numbers as its table equivalent; zero-count days render no bar height.
- **Polaris regression guard** — every screen is an `s-page` with `s-section`s, and the pre-port CSS class names cannot reappear.

CI runs these as their own `UI tests` step, which closes the "CI runs … UI … checks" criterion on #25.

Still open on #25, and deliberately not addressed here: the staging smoke script covers health, session (authed + unauthed), setup, summary, privacy, findings, and webhook HMAC, but not the install, reconciliation, or uninstall flows. Install is evidenced by the live dev-store install; reconciliation and uninstall remain unsmoked.

## 7. Correction to the first pass

The first pass marked findings copy **APPROVED** on the strength of `describeFinding` being non-accusatory and the detail screen's "observed-evidence framing." That verdict was wrong on one point: the spec §6 disclaimer sentence existed only in `free_mvp_screen_spec.md` and as a code comment in `main.ts` — **it was never rendered**. The load-bearing product-truth guardrail for the whole app was absent from the shipped UI while the review recorded it as satisfied. It now renders verbatim from a named constant (§5 item 7).

Two process notes worth keeping: the first pass's own coverage table had **no row for the setup screen**, so the missing spec §1 screen read as out-of-scope rather than as a gap — a review table built from the shipped code inherits that code's omissions. And #17 ("Implement setup, overview, and health experience") closed with the setup half unbuilt. Reviews of already-shipped UI should enumerate screens from the **spec**, not from the router.
