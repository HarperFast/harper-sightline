# UI fixes: event detail 500, working filters, active-filter chips, key/value layout

Date: 2026-08-11
Status: approved, being implemented

Six defects found by using the app in the live dev store. Five are UI; the first
is a server bug that the offline test suite could not see.

---

## 1. Event detail always 500s

**Observed.** `GET /api/v1/events/<id>` returns:

```json
{ "code": "Error", "title": "An \"or\" operator requires at least two conditions", "status": 500 }
```

**Cause.** `hydrateSkus` (`src/queries.ts`) builds one `eventId` condition per
event and unconditionally passes `operator: 'or'`. Harper rejects an `or` with
fewer than two conditions (`resources/Table.ts`, `prepareConditions`). The detail
view hydrates exactly one event, so it fails every time. The same call is on the
list and export paths, so **a list page or CSV export containing exactly one
event fails too** — the bug is not detail-specific, it is single-row-specific.

**Why the tests missed it.** `test/fakeTable.ts` ignores the operator/condition
-count rule, so 426 passing tests included a query Harper refuses to run. This is
the interesting part of the fix: the fake is a contract with Harper, and it was
lying.

**Fix.**

1. `FakeTable.search` validates like Harper: `or` needs ≥2 conditions, `and`
   (and the `undefined` default) needs ≥1. This turns the defect red offline.
2. `hydrateSkus` passes one condition with the default `and` when there is a
   single id, and `or` only for two or more.

Regression tests: event detail with SKUs hydrates; a one-event list page hydrates.

## 2. Filter dropdowns render empty

Polaris `s-select` takes `<s-option>` children. Every select in `view.ts` emits
plain `<option>`, which the component ignores — so all seven dropdowns across
Events, Orders and Findings render with no choices at all.

**Fix.** Emit `<s-option>`, and carry the current selection as `value` on the
`s-select` itself (a documented property, and the one `fieldValue()` reads back)
rather than as `selected` on a child. `test/view.test.ts` asserted the broken
markup and is updated.

## 3. Filter controls with the wrong input type (Events)

- **Time** was a relative-range select only. Keep the presets and add `From` /
  `To` `s-date-field` pickers → `since` / `until`. Day boundaries are computed
  **in the timezone the screen renders in** (store zone when known, viewer's
  otherwise), via a pure helper with its own tests. Choosing dates clears the
  preset; choosing a preset clears the dates.
- **State** was free text. It is a closed vocabulary — Shopify's own
  `financial_status`, fulfillment `status`, and our `refunded` — so it becomes a
  select. Values are shown exactly as stored (no invented labels).
- **Topic** was free text. Also closed: the eight subscribed topics
  (`shopify.app.toml`); reconciliation reuses the same strings. Becomes a select.
- **Resource ID** and **SKU** stay free text — open sets.

## 4. No indication of, or escape from, active filters

**Fix.** A chip row above each list: one `s-clickable-chip removable` per active
filter, labelled `Field: value` in merchant-facing wording, whose `href` is the
same view with that one filter dropped, plus a `Clear all` link. Chips are driven
by a pure `filterHash()` helper so the list, the chips and the submit handler
cannot disagree about a URL.

This also gives `maxAgeHours` a visible existence: it reaches the orders list
only from an aging-bucket link and has no control, so today it filters the
worklist with nothing on screen saying so.

## 5. The Field/Value blocks look wrong

`fields()` renders `s-table variant="list"`, which repeats the literal `Field` /
`Value` header labels above every row. Replaced with a two-column
`s-grid`/`s-grid-item` layout: subdued label, value aligned in its own column,
collapsing to stacked pairs in a narrow iframe. No custom CSS, so Admin theming
and dark mode continue to work. One function, six screens.

## 6. Server errors are invisible in the UI

Harper serializes an error as `{type, code, title, status, instance}`. `api.ts`
reads only `.error`, so every failure reached the merchant as a bare `500`, and
diagnosing #1 needed a round trip through the live instance.

**Fix.** Read `title` (then `error`, then a bare string body). A failure now names
itself on screen.

---

## Testing

Offline, in `app/test`, as everything else in this repo:

- `fakeTable.test.ts` — the operator validation itself.
- `queries.test.ts` — single-event hydrate on both the detail and list paths.
- `view.test.ts` — every select emits `s-option` and carries its value; chips
  render with correct removal links; `Clear all`; the field grid; the state and
  topic vocabularies; zoned day bounds (including a DST boundary).

Then `npm test`, `npm run typecheck`, `npm run lint:required`, `npm run build`.

## Live verification (after deploy)

1. Events → click a timestamp: the detail renders (this is #1).
2. Every dropdown has choices; State and Topic are dropdowns; From/To open a
   calendar.
3. Apply filters → chips appear; removing one narrows the URL; `Clear all`
   empties it.
4. Privacy → Installation reads as a label/value block, not a `Field`/`Value`
   table.
