# Runbook: digests are not being built

**Owner:** Sightline on-call

### Alert
- `digest.error` counter rising, or
- `tick.stalled` with `loop: "digest"`.

**A missing `DigestOutbox` row, by itself, is NOT an alert condition.** A quiet,
healthy period legitimately produces no digest — that is deliberate (see "Why it
matters"), and a recurring "all clear" would train people to ignore the channel.
Do not page on absence; page on the error/stall signals above.

### Why it matters
There is no sender (deferred; see the plan). The digest build loop's whole job is
to gather a shop's last complete period, decide whether there is anything
actionable to say, and — only if so — persist a `pending` row to `DigestOutbox`.
If the loop errors or wedges, a merchant who is subscribed and expects a digest
does not get one, and nothing else in the app surfaces that: the Notifications
screen shows "last checked", not "last attempted and failed".

### Signals
- `event="digest.error"` lines with `message` (the pass threw; the whole tick for
  every shop that iteration is aborted).
- `event="tick.stalled"` with `loop: "digest"` (a previous pass never returned;
  the ticker's 30-minute stall budget let a new one start anyway).
- `event="digest.built"` — logged **only** when at least one shop actually built
  (`built > 0`) or was quiet-but-evaluated (`skippedQuiet > 0`) that tick. A tick
  where every subscription was simply not due yet (`skippedNotDue` only) logs
  **nothing** — its absence is not a signal of anything.
- No aggregate digest health is wired into `ops.snapshot` yet — diagnosis is
  log search plus reading the subscription row directly.

### Diagnose
1. Search logs for `digest.error` — an exception aborts the whole pass for every
   shop that tick, not just one.
2. Search logs for `tick.stalled` with `loop: "digest"` — a wedged previous pass.
3. Read the shop's subscription row. `status` must be `'active'` and `email`
   must be set — `shouldBuild` (`src/digest.ts`) declines otherwise, and the
   Notifications screen shows the same paused/no-address state, so this is
   usually visible without touching the database.
4. Compare `lastBuiltAt` to the current period start (`periodStartFor`, UTC,
   closed periods only). If they are equal, this period is already built —
   correct behavior, not a fault.
5. If `lastBuiltAt` advanced but no outbox row exists for that period, the
   period was genuinely quiet: `hasSomethingToSay` was false. Also correct — a
   healthy, quiet period produces no digest by design.

### Remediate
- **Quiet period.** No action. Confirm by gathering the same window's numbers
  manually (`gatherDigestInput`, `src/digestData.ts`) and checking
  `hasSomethingToSay` would in fact be false.
- **Wedged loop.** The ticker's 30-minute stall budget already lets the next
  scheduled pass proceed; if `tick.stalled` keeps repeating, restart the
  component and pull the stack trace from the paired `digest.error`.
- **Subscription paused by uninstall.** `uninstallShop` deletes the
  subscription outright. Expected if the app was removed; nothing to fix.
- **Purge removed the evidence.** Outbox rows are purged after 30 days
  (`OUTBOX_RETENTION_DAYS`, `src/ledgerTargets.ts`) — a missing *old* digest is
  expected, not a fault. Confirm the row's period actually falls outside that
  window before treating it as a symptom.

### Verify recovery
`digest.error` stops recurring (or `tick.stalled` for `loop: "digest"` stops
repeating), and the next scheduled tick (hourly; `DIGEST_INTERVAL_MS`,
`app/jobs.ts`) advances `lastBuiltAt` for the affected shop and, if that period
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
itself is healthy.

**Note.** There is no sender. A `pending` outbox row is the finished state
today; nothing being delivered from it is not a fault.
