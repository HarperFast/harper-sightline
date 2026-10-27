# Runbook: digests are not being built

**Owner:** Sightline on-call

### Alert
- `digest.error` counter rising, or
- `tick.stalled` with `loop: "digest"`, or
- `digest.build.subscription.failed` rising, especially repeatedly for the same
  `shopId` — a single subscription's build failing on every tick, which the
  sweep isolates and continues past, so it never trips `digest.error` on its
  own.

**A missing `DigestOutbox` row, by itself, is NOT an alert condition.** A quiet,
healthy period legitimately produces no digest — that is deliberate (see "Why it
matters"), and a recurring "all clear" would train people to ignore the channel.
Do not page on absence; page on the signals above.

### Why it matters
There is no sender (deferred; see the plan). The digest build loop's whole job is
to gather a shop's last complete period, decide whether there is anything
actionable to say, and — only if so — persist a `pending` row to `DigestOutbox`.
If the loop errors, wedges, or fails for one shop, a merchant who is subscribed
and expects a digest does not get one, and nothing else in the app surfaces
that: the Notifications screen shows "last checked", not "last attempted and
failed".

### Signals
- `event="digest.build.subscription.failed"` with `shopId` and a scrubbed
  `message` (`src/digestBuild.ts`) — ONE subscription's gather/write threw. This
  is a per-shop try/catch, not the sweep's outer one: every other shop still
  builds normally, so this can fire on every tick for one shop while
  `digest.error` and `tick.stalled` both stay silent. Check this FIRST — see
  "Diagnose" below, where it is deliberately ordered ahead of the quiet-period
  conclusion.
- `event="digest.error"` lines with `message` (the pass itself threw, outside
  any per-subscription scope; the whole tick for every shop that iteration is
  aborted).
- `event="tick.stalled"` with `loop: "digest"` (a previous pass never returned;
  the ticker's **180-minute (3-hour)** stall budget let a new one start anyway —
  `ticker('digest', 180 * 60_000)` in `jobs.ts`, three times the hourly interval).
- `event="digest.built"` — logged when `built > 0`, `skippedQuiet > 0`, **or
  `failed > 0`** (`jobs.ts`'s `digestTick`; the `failed` disjunct exists
  precisely so a sweep with per-shop failures is never mistaken for a quiet,
  healthy one). A tick where every subscription was simply not due yet
  (`skippedNotDue` only, nothing built, quiet, or failed) logs **nothing** —
  that absence is not a signal of anything.
- No aggregate digest health is wired into `ops.snapshot` yet — diagnosis is
  log search plus reading the subscription row directly.

### Diagnose
1. Search logs for `digest.build.subscription.failed` for this `shopId`
   **first, before concluding anything about a quiet period** — a shop failing
   on every tick looks, from the outside (no digest arriving, `lastBuiltAt`
   possibly stale), exactly like a healthy shop with nothing to report. If this
   event is present for the shop, that is the cause: read the scrubbed
   `message` and stop here rather than continuing to steps 4–5 below.
2. Search logs for `digest.error` — an exception here aborts the whole pass for
   every shop that tick, not just one.
3. Search logs for `tick.stalled` with `loop: "digest"` — a wedged previous
   pass.
4. Read the shop's subscription row. `status` must be `'active'` and `email`
   must be set — `shouldBuild` (`src/digest.ts`) declines otherwise, and the
   Notifications screen shows the same paused/no-address state, so this is
   usually visible without touching the database.
5. Compare `lastBuiltAt` to the current period start (`periodStartFor`, UTC,
   closed periods only). If they are equal, this period is already built —
   correct behavior, not a fault. (Note: `lastBuiltAt` only advances on a
   pass that reaches the end of that subscription's try block, so a shop
   failing on step 1 will show a STALE `lastBuiltAt`, not an advancing one —
   another reason to check step 1 first rather than reading a stale timestamp
   as "not due yet.")
6. Only once 1–3 are clear and `lastBuiltAt` has genuinely advanced with no
   outbox row for that period: the period was quiet, `hasSomethingToSay` was
   false. Correct — a healthy, quiet period produces no digest by design.

### Remediate
- **Per-subscription failure (`digest.build.subscription.failed`).** Read the
  scrubbed message to classify the exception (a malformed row, a table
  hiccup, a transient error from `gatherDigestInput`'s dependencies). The
  sweep already isolates it — no other shop is affected — so the fix is
  whatever the underlying exception calls for; there is no separate replay
  mechanism, but the loop retries every shop again next tick automatically.
- **Quiet period.** No action. Confirm by gathering the same window's numbers
  manually (`gatherDigestInput`, `src/digestData.ts`) and checking
  `hasSomethingToSay` would in fact be false.
- **Wedged loop.** The ticker's **180-minute (3-hour)** stall budget eventually
  lets the next scheduled pass proceed on its own — three hours, not thirty
  minutes, so do not sit and wait it out on the shorter figure. If `tick.stalled`
  keeps repeating, restart the component and pull the stack trace from the
  paired `digest.error`.
- **Subscription paused by uninstall.** `uninstallShop` deletes the
  subscription outright. Expected if the app was removed; nothing to fix.
- **Purge removed the evidence.** Outbox rows are purged after 30 days
  (`OUTBOX_RETENTION_DAYS`, `src/ledgerTargets.ts`) — a missing *old* digest is
  expected, not a fault. Confirm the row's period actually falls outside that
  window before treating it as a symptom.

### Verify recovery
`digest.build.subscription.failed` stops recurring for the affected shop (or
`digest.error` stops recurring / `tick.stalled` for `loop: "digest"` stops
repeating), and the next scheduled tick (hourly; the `sightline-digest` job `interval` in
`app/config.yaml`) advances `lastBuiltAt` for the affected shop and, if that period
has something to report, writes exactly one new `DigestOutbox` row for it.
Re-running the tick must not create a second row for the same period — the
outbox id is `${shopId}:${periodStart}`, so a rebuild upserts rather than
duplicates.

### Escalate
If digests stop building for every subscribed shop at once, treat it as a
component-level fault, not a per-shop digest issue — check the `ops.snapshot`
heartbeat for overall health (backlog, dead letters, reconciliation) before
digging further into the digest loop specifically; a broken recorder upstream
can starve `gatherDigestInput` of accurate counts even when the digest loop
itself is healthy. If `digest.build.subscription.failed` is rising across MANY
different shops rather than repeating for one, treat that as a shared-cause
fault too (a schema/data assumption `gatherDigestInput` makes that broke for
everyone at once), not eleven unrelated single-shop incidents.

**Note.** There is no sender. A `pending` outbox row is the finished state
today; nothing being delivered from it is not a fault.
