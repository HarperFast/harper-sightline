# Sightline — Free-MVP UX & Content Review (issue #16)

- Date: 2026-08-05
- Scope: the implemented embedded SPA (`app/web/`) reviewed against the committed [screen specification](./free_mvp_screen_spec.md). Because the functional UI already shipped (#17–#20), this is the implementation-grade design record + a content/terminology/accessibility review, plus the fixes it drove.
- Companion: [screen spec](./free_mvp_screen_spec.md) (design source), [security review](./security-review.md) (privacy disclosures), annotated [App Store concept](./sightline_shopify_app_store_mock.html).

## 1. Screen & state coverage

Global states the spec requires on every screen: **loading, empty, partial, stale/reconciliation-delayed, authorization-expired, recoverable-error**. Status by screen (against `app/web/src/main.ts`):

| Screen | loading | empty | error (retry) | auth-expired | Notes |
|---|---|---|---|---|---|
| Overview | ✓ | ✓ ("nothing awaiting confirmation") | ✓ | ✓ | Health is a separate banner from finding counts — an unhealthy recorder never renders as "no gaps" (spec §2). Now includes a **Needs attention** list of recent unconfirmed orders. |
| Events (list) | ✓ | ✓ ("No events match") | ✓ | ✓ | Now shows the **Source** (webhook/reconciliation) column (spec §3). |
| Event detail | ✓ | n/a | ✓ | ✓ | Normalized fields, source/receipt time, related events, projection/finding impact. No raw payload / PII. |
| Findings (list) | ✓ | ✓ ("nothing is missing confirmation") | ✓ | ✓ | Status + open-for elapsed. |
| Finding detail | ✓ | n/a | ✓ | ✓ | Non-accusatory description + **Why this qualified** eligibility bullets (spec §4) + evidence event links + rule version. |
| Privacy | ✓ | ✓ | ✓ | ✓ | No-PII banner, data categories, deletion, footprint. |

**stale/reconciliation-delayed** and full **partial-data** distinctions are partially covered — see Deferrals (§5); they need a small summary-API addition and are not blockers for the read-only MVP.

## 2. Accessibility & no-color / table alternatives

Spec: keyboard + screen-reader accessible; visualizations have equivalent text/table summaries; meaning survives without color.

- **Keyboard navigation (fixed in this PR):** whole-row links (Events, Findings, Needs-attention) were click-only. They now carry `role="link"` + `tabindex="0"`, activate on **Enter/Space**, and show a visible `:focus-visible` outline. Filters/search are native form controls (already keyboard-operable) and now carry `aria-label`s and `role="search"`.
- **Screen reader:** loading uses `role="status"`; error/auth-expired use `role="alert"`; row links have descriptive `aria-label`s; data is in real `<table>`/`<dl>` semantics.
- **No-color:** the "Flow" visualization is a **label + count list** — it is already its own table-equivalent and conveys magnitude by number, not color. Status **badges pair color with the status word** (e.g. "unconfirmed"), so they read without color. The overview's order/finding stats are numeric tiles.
- **Contrast/theme:** light + dark via `prefers-color-scheme`; ok/warn tones have text labels, not color alone.

## 3. Content & terminology review (product + security sign-off)

The load-bearing product-truth boundary: an absence finding means **"Sightline has not observed the expected Shopify confirmation,"** never that a warehouse/carrier/3PL failed.

- **Findings copy — APPROVED.** The finding description comes from `describeFinding` (detector, #14), which is non-accusatory; the detail screen reinforces it with the observed-evidence framing and the eligibility bullets. The overview "Needs attention" row reads **"No Shopify fulfillment confirmation observed"** — not "failed". No screen renders replay/recovery/repair controls or downstream-failure language.
- **Privacy disclosures — APPROVED.** The Privacy screen leads with "No customer PII is stored" (no name/email/phone/address), lists the exact data categories, retention (7 days), and deletion behavior. This matches the [data inventory](./data-inventory.md) and [security review §4](./security-review.md). No secrets, tokens, cluster names, or global tenant metrics appear (spec §5).
- **Capability discipline — APPROVED.** The UI checks capabilities and shows only `record`; no paid/replay affordance exists in the shipped SPA.

## 4. App Store concept correction

`docs/sightline_shopify_app_store_mock.html` is a **product-direction artifact**, not acceptance criteria (plan §"tone by design"). It is now **annotated**, not rewritten: a sticky high-contrast banner (and a `<title>` marker) states it is a concept, enumerates what does **not** ship in free Record (replay/recovery/repair, "failed flow"/destination-health claims, "1-click", pricing, and the illustrative reviews/5.0 rating), and points to this review + the screen spec + the real UI. The actual listing correction (removing those claims from the published creative) is tracked in **#26 (App Store readiness)**.

## 5. Changes made in this PR

Surgical, spec-aligned fixes to `app/web/` (no API changes required):

1. Keyboard-operable row links + `:focus-visible` outline (accessibility).
2. Events list **Source** column (spec §3).
3. Distinct **authorization-expired** state (401 → reauthorize message, not a generic error) + a **Retry** button on recoverable errors (spec global states).
4. Overview **Needs attention** list of recent unconfirmed orders with non-accusatory copy (spec §2).
5. Finding detail **Why this qualified** eligibility bullets (spec §4).
6. `aria-label`/`role` annotations on rows, filters, and status regions.

## 6. Documented deferrals (small follow-ups, not MVP blockers)

Each needs a minor read-API addition and is out of scope for a content/UX pass:

- **Reconciliation freshness on Overview** ("Reconciled 4m ago" + a stale banner). The staleness signal exists operator-side (`opsHealth`, #22) but the merchant `summary` payload doesn't expose a per-shop last-reconciled time yet. Follow-up: add `reconciledAt`/`stale` to `getSummary` and render the global-context line + stale state.
- **Events filters: time range, topic, and evidence-source.** The list now displays source; filtering by source/topic/time needs `listEvents` params + `apiContract` allowlist additions.
- **Activity-over-time sparkline** (spec §2 "Activity over time"). Deferred; the Flow list + counts already give the table-equivalent the spec requires of any visualization.

These are captured here so #26 (App Store readiness) and any UX follow-up have a precise punch list; none affects the product-truth or privacy guarantees.
