# Runbook: dead-lettered deliveries

**Owner:** Sightline on-call → data/normalizer owner

### Alert
- `ops.snapshot` health `deadLetter.count > 0`, or
- `process.dead_lettered` counter rising.

### Why it matters
A delivery dead-letters when it can never succeed: a broken/unsupported payload
shape (thrown as a *permanent* error), or a transient failure that exhausted
`MAX_ATTEMPTS`. Dead-letter is the **visible terminal state** — the row stays in
`WebhookDelivery` with `status="dead_letter"` (it is not silently dropped), and
the correctness invariant "an accepted delivery is eventually normalized or
visible in a dead-letter state" holds. But that order's evidence never reached
the ledger/detector, so a real gap could go unrecorded.

### Signals
- `ops.snapshot` `deadLetter.count` (aggregate) marks health unhealthy.
- `getSummary` (merchant API) exposes `recorder.deadLetteredDeliveries` per shop —
  an unhealthy recorder must never render as "no gaps" (screen spec).
- `process.error` lines around the same time hint at the cause.

### Diagnose
1. Identify the dead-lettered rows: query `WebhookDelivery` for
   `status="dead_letter"` (via Harper Studio / operations API — see
   `fabric-investigation` skill). Note `topic`, `attempts`, and the row id
   (`shopId:webhookId`); **do not** dump the stored `payload` into shared logs
   (PII-stripped, but still merchant data).
2. Classify:
   - **Permanent** (dead-lettered on attempt 1): unsupported/broken payload shape.
     A new Shopify API version or an un-handled topic variant is the usual cause.
   - **Transient exhausted** (`attempts` reached `MAX_ATTEMPTS`): a dependency was
     down for the whole retry window — see [webhook-backlog](./webhook-backlog.md).

### Remediate
- **Permanent shape bug**: fix the normalizer (`app/src/normalize.ts`) to handle
  the shape (add/adjust a versioned normalizer + fixture test), ship, and rely on
  reconciliation to backfill the affected orders from the Admin API — the
  authoritative order state re-enters through the same reducer, so the projection
  and any real finding are reconstructed without needing to replay the webhook.
- **Transient exhausted**: fix the dependency; reconciliation likewise backfills
  the missed orders on its next sweep. Confirm reconciliation is healthy.
- MVP has no automated dead-letter replay endpoint; reconciliation is the
  recovery path. Record the incident and affected order count.

### Verify recovery
`deadLetter.count` stops rising; affected orders reappear in the ledger via
reconciliation; `getSummary.recorder.healthy` returns to `true` for the shop
once no dead letters remain in the retention window (they also age out at 7 days).

### Escalate
A recurring permanent dead-letter for a common topic (e.g. all `orders/paid`)
indicates a Shopify contract drift — escalate to the data/normalizer owner and
re-check the pinned Admin API version and `include_fields`.
