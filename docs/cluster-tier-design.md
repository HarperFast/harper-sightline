# Sightline — Cluster Tier Design (post-MVP phase 2)

- Status: **design only — not committed, not funded.** Downstream of the Recover tier; nothing here is buildable until that phase exists.
- Date: 2026-08-11
- Scope: the **Cluster** rung of the growth ladder — billed as **Scale** in the [product brief](./sightline_product_brief_v3.md) §Tiers: agency multi-store dashboard, repair-write module, long retention, priority connector builds with SLAs, private deployment on a dedicated Harper cluster.
- Predecessor phase: [Recover tier design](./recover-tier-design.md).

## 0. Why this document decomposes rather than designs

The brief's Scale tier is five independent products sold as one line item. They share a buyer and almost nothing else: an agency dashboard is an identity and UI problem, repair writes are a correctness and consent problem, long retention is a parameter, connector SLAs are a commercial process, and a dedicated cluster is an operations problem. Designing them as one system would produce a document nobody could build from.

So: §1 decomposes and orders them, §2 designs the first one properly, §3 sizes the rest honestly. Each of C2–C5 needs its own document before it is built.

## 1. Decomposition

| # | Sub-project | Kind | Depends on | Own spec needed |
|---|---|---|---|---|
| **C1** | Agency multi-store dashboard | identity + UI | Recover (entitlement) | designed here (§2) |
| **C2** | Repair-write module | Admin writes, high risk | C1 for the operator surface | **yes — highest risk in the product** |
| **C3** | Long retention (beyond 90 days) | parameter + cost | Recover §2.2 per-shop retention | no, folds into Recover's model |
| **C4** | Priority connector builds + SLAs | commercial process | Recover §2.7 connectors | process doc, not architecture |
| **C5** | Private deployment / dedicated cluster | operations | **deploy reliability (§3.4)** | yes |

**Ordering.** C1 first: it is the stated wedge ("one install decision covers twenty stores," and the brief's TAM table names the multi-store dashboard as "the feature they cannot get elsewhere"), and every other Scale capability is easier to sell once a portfolio view exists to hang it on. C3 is nearly free once Recover's `expiresAt` model lands. C2 is the highest-risk work in the entire product and should not start until C1 gives it an operator surface with a real approval flow. C5 is blocked on something unrelated to the tier — see §3.4. C4 is a commercial commitment, not a build.

## 2. C1 — Agency multi-store dashboard

### 2.1 The crux: the current identity plane cannot express this

This is the finding that shapes the whole sub-project, and it is not a matter of adding a query filter.

Sightline's tenancy today is: `src/auth/identity.ts` verifies a Shopify session token, `principal.shopId` is derived from it and never from caller input, and `src/api/queries.ts` constrains every search by that `shopId`. That invariant is the product's tenant isolation, it is tested (`crossTenant.test.ts`), and it is correct.

But a Shopify session token is **issued by one store's embedded admin and scoped to that store**. An agency operator looking at twenty stores is not inside any store's admin. There is no session token that means "this person may see these twenty shops." The cross-store view therefore cannot be authenticated by the mechanism the whole app currently rests on.

Cluster needs a **second identity plane**:

- an **Org** (the agency) with members, authenticated *outside* Shopify — email/SSO — on a **non-embedded** surface;
- **per-shop grants** linking an org to the shops it may see;
- the existing embedded per-shop experience unchanged, still session-token authenticated.

Two planes, one authorization model. The embedded app answers "who is this merchant"; the org plane answers "which shops may this operator see."

### 2.2 Grants must originate inside the store

The direction of trust is the part to get right. An agency must not be able to assert access to a store, and Sightline staff must not be able to grant it either.

**Proposed flow:** a grant is created *from inside the store's embedded app*, by someone holding that store's admin session — which is the only available proof of authority over that store — and is then accepted by the org. Revocation works from either side and is immediate.

Consequences:

- A grant is merchant-authorized by construction, which is also the only story that survives a privacy review.
- `app/uninstalled` must revoke every grant for that shop, and the shop must leave every portfolio view at once. The uninstall path already revokes the token and clears shop state (`src/shopify/lifecycle.ts`); grants join that list, and the smoke coverage added for uninstall should be extended to assert grant revocation too.
- `shop/redact` must remove the shop from org-visible aggregates as well as from its own rows.
- Grant creation, acceptance, and revocation are all audit events (`src/audit.ts`).

### 2.3 What changes about tenant isolation

The invariant moves from "one verified shop" to "a verified set of shops," which is a genuinely more dangerous shape — most multi-tenant leaks are an over-broad set, not a wrong single id.

- `queries.ts` gains shop-*set* constraints. Every existing single-shop path must keep working unchanged; the set path is additive.
- A revoked or expired grant must drop out of the set immediately, including for an in-flight session.
- Cross-store aggregates must not let one agency's portfolio reveal anything about a shop it was never granted, and must not let a merchant infer which other stores an agency manages.
- `crossTenant.test.ts` needs a whole second dimension: org with no grants, org with a revoked grant, org with a grant to shop A querying shop B, a shop that uninstalled mid-session, and a member removed from the org mid-session.

This is where I would spend the review effort on C1.

### 2.4 Data model

| Table | Purpose |
|---|---|
| `Org` | the agency tenant |
| `OrgMember` | member + role, authenticated on the non-embedded plane |
| `ShopGrant` | `(orgId, shopId)`, status, `grantedBy`, `grantedAt`, `revokedAt` |

`ShopGrant` is the authorization record and the audit trail; it is never deleted on revoke, only stamped, so "who could see this store in July" remains answerable.

### 2.5 Surface

A **non-embedded** web surface: portfolio overview (per-store health, using the same `computeOpsHealth`-style derivation but scoped to granted shops), a cross-store findings list, and drill-through into the existing per-store screens. It is a new hosting and auth surface on the same component, with its own threat model — [threat-model.md](./threat-model.md) needs a section, not a footnote, because this is the first surface not protected by Shopify's session-token boundary.

`capabilities.ts` already carries the `multi_store` seam, so gating costs nothing at the call sites.

## 3. C2–C5, sized

### 3.1 C2 — Repair-write module

The highest-risk subsystem in the product: Admin API **writes that change the merchant's own state** — create a missing fulfillment from connector tracking data, fix tracking, adjust inventory, set tags and metafields downstream syncs key on.

The brief's rules are already the right ones and should be treated as requirements, not guidance: propose-and-approve with a dry-run diff, idempotency keys, full audit in the ledger, **compensating entries never edits** for append-only records, **never rewind derived or financial statuses**, and "Sightline can only put back what it saw."

Why it needs its own spec:

- It requires real write scopes (`write_orders`, `write_inventory`, `write_fulfillments`), which is a different App Store review class and a near-certain PCD escalation beyond the Level 1 granted 2026-08-04.
- A wrong repair is worse than no product. Unlike re-announcement — which asks Shopify to re-emit facts that already exist — repair *authors new facts* about the merchant's business. The failure mode is a fulfillment record for a shipment that never shipped.
- Correlation (Recover §2.7) is effectively a prerequisite: repairing from inferred absence is guessing. Repair should only act on connector-confirmed gaps.

Do not start C2 until C1 provides the approval surface and connectors provide confirmation.

### 3.2 C3 — Long retention

Once Recover stamps `expiresAt` per row from the shop's entitlement, "long retention" is a larger number in the entitlement plus a cost model. The work that remains is not code: policy language, the storage bill, and the compliance consequence that redaction must converge over a far larger row count (`MAX_DELETES_PER_RUN = 10_000` per run means a large long-retention shop's redaction spans many runs and must be *shown* to finish).

Folds into Recover's design; no separate spec.

### 3.3 C4 — Priority connector builds + SLAs

Commercial, not architectural. Needs a request queue, quoted delivery windows, and a definition of "priority" that does not simply mean other customers wait. The brief's echo-back test stays the honest filter for declining connectors that add nothing. One process doc; no new subsystem.

### 3.4 C5 — Private deployment / dedicated Harper cluster

Technically the smallest of the five — a single-tenant deploy of the same component — and the one with a hard blocker that has nothing to do with the tier.

[deployment.md](./deployment.md) §"Multi-node clusters: component code does NOT replicate" documents that a Fabric instance behind one hostname can be several nodes, that a `restart` to the load-balanced ops endpoint reaches exactly one of them, and that this produces **half-deployed clusters**. `deploy.mjs` compensates by walking peers and probing the load-balanced hostname repeatedly. That is an acceptable workaround for our own staging instance. It is not something to put an SLA on top of and sell.

**So C5 is gated on deploy reliability, not on Cluster funding.** Selling a dedicated cluster with an availability commitment while a deploy can half-apply is selling a promise the deploy path cannot keep. Fix that first — and note it also blocks the "priority SLAs" half of C4.

## 4. Cross-cutting risks

1. **A second auth plane is a new attack surface.** It is not protected by Shopify's session boundary, it holds cross-tenant authorization, and it is the highest-value target in the system. It needs its own threat-model section and its own security review before it is exposed.
2. **The shop-set isolation invariant** (§2.3) is the most likely place for a real multi-tenant leak.
3. **Write scopes** (C2) change the app's review class and PCD posture.
4. **Deploy fragility** (§3.4) blocks anything with an availability commitment.
5. **One auth plane or two.** Recover §2.5 needs machine credentials for feed consumers; C1 needs org accounts for humans. These should be one design with two credential types, decided before either ships, or the product grows two half-designed auth systems.

## 5. Open questions

1. Is C1 actually the wedge in practice, or does the *first* Scale customer buy repair writes? The brief asserts agencies; no customer evidence exists yet, and the order in §1 rests on that assertion.
2. Does the org plane authenticate with email/password, SSO, or Shopify Partner identity — and does Partner identity make grants easier or merely narrower?
3. Can an org member be scoped to a subset of the org's shops, or is membership all-or-nothing? (All-or-nothing is simpler and probably wrong for large agencies.)
4. What does a merchant see about an org's access to their store, and where? A grant the merchant cannot inspect is a grant they cannot meaningfully consent to.
5. Long-retention pricing against real storage cost, which needs Gate 2 volumes.
6. Does private deployment change the compliance story — who is the data controller on a dedicated cluster?

## 6. Recommended sequencing

1. **Resolve the auth-plane question jointly with Recover §2.5.** Cheap now, expensive later, and it constrains C1.
2. **Fix multi-node deploy reliability** (§3.4). Independent of this tier, blocks C5 and SLAs, and it is already a live operational hazard rather than a future one.
3. **C1**, with the isolation test matrix in §2.3 treated as the acceptance criterion.
4. **C3** as a parameter of Recover's retention model.
5. **C2**, its own spec, only after C1 and connector-based confirmation exist.
6. **C4 / C5** as commercial and operational readiness allows.

Nothing here should start before the Recover tier exists and Gate 2 has justified a paid product at all.
