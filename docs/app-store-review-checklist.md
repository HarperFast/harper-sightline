# Sightline — Shopify App Store Review Checklist (issue #26)

- Status: **in progress** — this is the working document for #26
- Date: 2026-08-06
- Scope: free **Record** tier only. No paid tier, no write capability, no replay.

Legend: **✅ done** · **🟡 code done, needs owner action or verification** · **⛔ blocked** · **☐ not started**

## 0. The critical path, in order

Everything below is either on this chain or independent of it. The chain is not code:

1. ⛔ **Harper native secrets custody restored** (Fabric-side, external dependency) — `custody_fingerprint` is null cluster-wide, which is *why* the dev fallbacks exist.
2. ⛔ **F1/F2 closed** — rotate the burned Shopify app secret, provision a real `SIGHTLINE_TOKEN_KEY`, set `SIGHTLINE_REQUIRE_SECRETS=1`, delete the fallbacks. Blocked on (1).
3. ☐ **Production instance + `application_url`** — every URL in `shopify.app.toml` currently points at `ayoo.josh-test.harperfabric.com`, a test instance.
4. ☐ **Clean production-store install** completing the definition-of-done walkthrough (§4).
5. ☐ **Release-owner sign-off** (§6).

A production install on dev-fallback secrets is not a launch candidate, so (2) genuinely gates (4).

## 1. Technical requirements

| Item | Status | Evidence / action |
|---|---|---|
| Embedded app using App Bridge + Session tokens | ✅ | `embedded = true`; session-JWT verification in `src/verifySessionToken.ts`, adapter in `src/identity.ts` |
| Uses Polaris / App Home patterns | ✅ | Ported to Polaris web components (PR #63) |
| OAuth / managed install, expiring offline tokens | ✅ | `src/exchangeToken.ts`, `src/lifecycle.ts`; atomic rotation, `reauthorization_required` on refresh failure |
| Webhook HMAC verification | ✅ | Raw-body constant-time verify before parse (`src/webhookHmac.ts`); invalid → 401, no mutation |
| Mandatory compliance webhooks | ✅ | `customers/data_request`, `customers/redact`, `shop/redact` declared in `shopify.app.toml` and implemented in `src/compliance.ts`; live-verified (#21) |
| `app/uninstalled` handling | ✅ | Token revoked, shop data erased (`src/lifecycle.ts`, `src/redaction.ts`) |
| No write scopes / no store mutation | ✅ | `scopes = "read_orders,read_fulfillments,read_inventory,read_products,read_locations"`; all write capabilities hard-`false` in `src/capabilities.ts` |
| Performance: fast webhook ack | ✅ | Ack p95 gate documented and tested (#24, `docs/reliability-report.md`) |
| Pinned API version | ✅ | `api_version = "2026-07"`; quarterly bump is a standing operational task (threat model §5) |
| **Load burst + backup/restore drills** | ☐ | Tooled and documented in #24, deferred to live infra. `npm run loadtest` now also proves the burst **drained** (backlog returns to baseline, no new dead letters, drain rate ≥ offered rate) rather than only that it was acked — see `docs/reliability-report.md` §3 and the capacity caveat in §5.1. Restore procedure in the same doc |
| **Rollback verified** | ☐ | Path is "deploy an earlier ref" (`docs/deployment.md`); never exercised end to end |
| **Staging smoke: uninstall** | 🟡 | **Covered:** `SMOKE_UNINSTALL=1 npm run smoke` bootstraps a throwaway shop, posts a signed `app/uninstalled`, and polls `/api/v1/setup` until the shop reads as no longer installed — so it asserts the state change, not just the ack. Opt-in because it writes state. **Needs:** the flag set in the staged deploy run |
| **Staging smoke: reconciliation** | ☐ | Still uncovered. Reconciliation needs a real offline Admin token, which the synthetic smoke shop has no way to obtain — this one can only be exercised against a genuinely installed store, so it belongs to the §4 walkthrough rather than to `smoke.mjs` |

## 2. Protected Customer Data

| Item | Status | Evidence |
|---|---|---|
| PCD Level 1 approval | ✅ | **Granted 2026-08-04.** Protected `orders/*`, `fulfillments/*`, `refunds/create` subscriptions deploy without rejection |
| Level 2 fields not requested | ✅ | `include_fields` whitelists exclude all PII; `src/pii.ts` strips at ingress before storage |
| Data minimisation documented | ✅ | `docs/shopify-contract.md` §3/§5, `docs/data-inventory.md` |
| Encryption at rest / in transit | ✅ | AES-256-GCM token envelopes (`src/crypto.ts`); HTTPS throughout (`docs/security-review.md` §4) |
| Retention + real deletion | ✅ | 7-day DELETE-based purge, verified by re-query (ADR-003) |

## 3. Listing requirements

| Item | Status | Action |
|---|---|---|
| **Privacy policy, publicly reachable** | 🟡 | **Built:** served unauthenticated at `/privacy-policy` (`src/privacyPolicy.ts`), versioned with the app, claims pinned by tests against the code's own constants. **Needs:** legal review, an effective date via `SIGHTLINE_POLICY_UPDATED`, and the production URL in the Partner Dashboard |
| **Support contact, reachable** | ✅ | `support@harperdb.io`, committed as the default in `src/support.ts` (product metadata, identical in every environment — so a deploy cannot forget it), overridable via `SIGHTLINE_SUPPORT_EMAIL` / `SIGHTLINE_SUPPORT_URL`. Surfaced on the Privacy screen and on the expired-session and load-failure states — the two places a merchant is actually stuck. **Owner still enters it in the Partner Dashboard listing**, which is a separate field the app cannot populate |
| App name, tagline, description | ☐ | Must describe **Record** only: parallel read-only capture, 7-day searchable ledger, absence-based findings. Draft not written |
| Screenshots | ☐ | Must come from the real UI with representative, non-fictional data. **Blocked on the live-embed check** (§5) |
| Pricing | ☐ | Free. No paid plan may be listed while the capabilities are `false` |
| **No replay / recovery / "1-click" claims** | ☐ | The early product-direction concept for this listing carried all of these, and none of them may reach the published creative: replay / re-announcement, recovery queues, repair actions, "1-click" recovery, downstream "failed flow" or destination-health claims, and a paid plan. Record's findings say only *"no Shopify confirmation observed"* — see [ux review §3](./ux-review.md). The concept file has been removed from the repo (recoverable from git history if the creative needs to be diffed against it) |
| No fabricated reviews or ratings | ☐ | The same concept carried **illustrative 5.0-star reviews with fictional reviewer names**. This is the highest-risk item in the whole submission — fabricated social proof is a hard rejection and a trust problem, not a copy nit |
| Support/FAQ/docs URL | ☐ | Owner |

## 4. Definition-of-done walkthrough

Run on a clean **production** store once §0 (1)–(3) are complete. From the development plan:

- [ ] Install from the App Store listing (or unlisted install link)
- [ ] App opens embedded in Shopify Admin with no console errors
- [ ] First open shows the setup stepper; the initial check completes
- [ ] Overview shows recording health separately from finding counts
- [ ] Events: search 7 days of order/fulfillment/inventory/refund activity
- [ ] Place and pay for an order; confirm it appears with correct state
- [ ] Withhold fulfillment past the deadline; confirm a finding opens with evidence, elapsed time, rule version, and the non-accusatory disclaimer
- [ ] Fulfill it; confirm the finding resolves and retains its history
- [ ] Privacy screen shows shop, scopes, exclusions, and both health signals
- [ ] `/privacy-policy` loads publicly, in a normal tab, while signed out
- [ ] Support contact is present and reaches a real inbox
- [ ] Uninstall; confirm token revoked and shop data erased (verify zero residue)
- [ ] Compliance webhooks: exercise `shop/redact` and confirm verified deletion

## 5. Verification still outstanding

- ☐ **Live-embed check after the Polaris port.** The UI is asserted at the markup level (43 UI tests) and confirmed to be the code actually served, but it has not been *seen* rendering. Gates screenshots, so it is on the listing critical path too.
- ☐ **`s-app-nav` in real Admin.** It cannot render outside Admin, so an in-page nav fallback ships alongside it. Once confirmed, remove `.appnav` from `web/index.html`.
- ☐ **Re-run CI on `main`.** Four commits merged during a GitHub Actions outage with local verification recorded on each PR instead: `43f5d0a`, `cc5a5da`, `b535570`, `c525a63`.

## 6. Release-owner sign-off

Sign only when the boxes above are closed. Each line is a separate judgement, not one blanket approval:

- [ ] **Security** — `docs/security-review.md` is signed "subject to the F1/F2 owner actions being completed". Those actions must be *done*, not merely planned.
- [ ] **Operations** — runbooks (`docs/runbooks/`), observability, rollback exercised, backup restored at least once.
- [ ] **Product truth** — no screen or listing asset claims a downstream failure, and no replay/recovery capability is implied. The spec §4 disclaimer renders verbatim on unconfirmed findings (pinned by test).
- [ ] **Rollback readiness** — an earlier ref has actually been deployed and verified, not just documented.

## 7. Deliberately excluded from this submission

Replay, re-announcement, repair, billing, connectors, multi-store dashboards, longer retention, email/SMS/Slack alerts, and the Gate 2 pilot export ([design](./gate2-pilot-design.md), unimplemented). All are represented as capability seams that return `false` — never as disabled buttons or placeholder screens.
