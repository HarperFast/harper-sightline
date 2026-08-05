# Runbook: Shopify outage

**Owner:** Sightline on-call

### Alert
- Widespread `reconcile.error` across **many/all** shops at once, and/or
- Ingress goes quiet (`webhook.received` drops to ~0) while shops are active, or
- Admin API calls failing platform-wide (not a single shop's auth).

### Why it matters
Sightline depends on Shopify for both inputs: webhook deliveries (capture) and the
Admin API (reconciliation/backfill). A Shopify-side outage degrades both. Because
Sightline is **parallel, not inline**, an outage does not make Sightline cause any
merchant-facing harm — but during it, capture is paused and gap detection is
blind. The key property to protect is **no data loss and correct catch-up** once
Shopify recovers.

### Distinguish from our own faults
- **Ours**: a single shop affected, or a change that coincides with our deploy →
  see [deployment-rollback](./deployment-rollback.md) /
  [stale-reconciliation](./stale-reconciliation.md).
- **Shopify**: broad, cross-shop, correlates with Shopify's status page
  (status.shopify.com). Confirm before declaring an external outage.

### During the outage
1. **Do not** rotate secrets, force reauth, or redeploy in reaction — those widen
   our own risk and won't fix Shopify. HMAC verification and token storage are
   unaffected on our side.
2. Confirm accepted deliveries are still durable (they are — `WebhookDelivery`
   rows persist) and the processing worker is healthy so it drains whatever did
   arrive.
3. Expect `reconcile.error` and empty sweeps; the cursor does not advance past
   committed work, so it will safely resume from the last checkpoint.
4. Silence internal alerts that are purely downstream of the outage to avoid
   fatigue, but keep the incident open.

### After Shopify recovers
1. **Reconciliation is the catch-up mechanism**: the incremental Admin API sweep
   backfills all order state that changed during the outage (missed webhooks
   included), through the same normalization + projection + detector path. Missed
   webhooks are *not* re-delivered by Shopify — reconciliation is how we recover
   them.
2. Watch `reconcile.tick` resume and `reconciliation.staleShops` return to 0.
   Backfill may take several sweeps for busy shops; that is expected.
3. Verify no order that transacted during the outage is missing from the ledger by
   spot-checking a few against the Admin API.

### Verify recovery
`ops.snapshot` health returns to `healthy`, ingress and reconcile resume, and
`reconciliation.stalestAgeMs` falls back under threshold. Record outage window and
affected-shop count for the incident log.
