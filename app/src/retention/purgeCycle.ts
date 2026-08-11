import type { PurgeResult } from './retention.ts';
import { M, type LogLevel } from '../observability/observe.ts';

// The two retention sweeps (ADR-003's seven-day ledger purge, and the digest
// outbox's own thirty-day purge) run back to back on the same tick, each in its
// OWN try/catch. That independence is the whole point: a persistent ledger-purge
// error must never silently disable the outbox's thirty-day retention, which
// this app discloses to the merchant in its privacy policy, its data inventory,
// and the Notifications screen. Sharing one try/catch would let a ledger failure
// skip the outbox sweep every tick, with the only symptom logged being an error
// about a different table.
//
// Deps-injected (log AND metrics, not just the tables/fetchers this codebase's
// other sweeps inject) so a test can assert on exactly what each sweep reported,
// not just its return value — the property under test IS the wiring: which
// events/counters fire when one sweep throws and the other doesn't. Lives in its
// own module, not jobs.ts, for the same reason src/ingest/inventoryEnrich.ts and
// src/jobs/stateBackfill.ts do: jobs.ts starts eight background loops at module scope,
// so importing it — even indirectly through src/db.ts — starts real timers. This
// module and retention.ts import nothing that reaches db.ts, so a test can import
// it directly under plain `node --test`.

export interface PurgeCycleDeps {
	purge(now: number): Promise<PurgeResult>;
	outboxPurge(now: number): Promise<PurgeResult>;
	log(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
	metrics: { inc(name: string, by?: number): void };
}

export interface PurgeCycleResult {
	// undefined only when that sweep's own call threw — the other sweep's result
	// is unaffected either way.
	ledger: PurgeResult | undefined;
	outbox: PurgeResult | undefined;
}

// `now` is captured ONCE by the caller (jobs.ts's purgeTick) and handed to
// both sweeps, rather than each of `deps.purge`/`deps.outboxPurge` defaulting
// to its own `Date.now()` as they do when called directly. Deliberate: one
// clock reading makes a tick deterministic and lets a test drive both sweeps
// from a single fixed `now`. The cost is that the outbox sweep's cutoff is
// computed at the instant the ledger sweep STARTED, not when the outbox sweep
// itself runs — and the ledger sweep does real work first (up to
// MAX_DELETES_PER_RUN deletes per table across all of RETENTION_TARGETS), so
// that skew can be seconds, not milliseconds, on a capped run. This is safe
// regardless of size, not just when it happens to be small: cutoffMs() is a
// continuous instant with no boundary to cross, and any row whose expiry
// falls inside the skew is simply picked up on the next tick — the purge is
// idempotent and runs hourly (jobs.ts), and retention.ts already documents
// leftover ("residue") rows as self-healing on the next scheduled run.
export async function runPurgeCycle(deps: PurgeCycleDeps, now: number): Promise<PurgeCycleResult> {
	let ledger: PurgeResult | undefined;
	try {
		ledger = await deps.purge(now);
		deps.metrics.inc(M.purgeDeleted, ledger.deleted);
		if (ledger.failures.length) deps.metrics.inc(M.purgeFailure, ledger.failures.length);
		if (ledger.deleted) {
			const perTable = Object.fromEntries(
				Object.entries(ledger.byTable)
					.filter(([, x]) => x.deleted)
					.map(([t, x]) => [t, x.deleted]),
			);
			deps.log('trace', 'purge.tick', { deleted: ledger.deleted, perTable });
		}
		// Residue = expired rows still present after a run (purge lag). Alertable
		// via this warn line; the ops.snapshot also reflects it via backlog/age.
		if (ledger.residue) deps.log('warn', 'purge.residue', { residue: ledger.residue });
		if (ledger.failures.length) deps.log('warn', 'purge.failures', { count: ledger.failures.length, failures: ledger.failures });
	} catch (e: unknown) {
		deps.metrics.inc(M.purgeError);
		deps.log('error', 'purge.error', { message: (e as Error).message });
	}

	// The outbox sweep gets its OWN try/catch rather than sharing the ledger
	// purge's. Sharing one meant a ledger-purge failure skipped the outbox
	// entirely on that tick — and since a persistent ledger failure repeats
	// every tick, the 30-day digest retention this app discloses publicly
	// would quietly stop running while the only symptom logged was
	// `purge.error` about a different table. The two sweeps are independent
	// (different tables, different cutoffs), so a failure in one must not
	// decide whether the other runs. Same metrics as the ledger purge: the
	// counters are per-purge-activity, not per-table, so ops.snapshot's tally
	// reflects outbox work instead of showing nothing for it.
	let outbox: PurgeResult | undefined;
	try {
		outbox = await deps.outboxPurge(now);
		deps.metrics.inc(M.purgeDeleted, outbox.deleted);
		if (outbox.failures.length) deps.metrics.inc(M.purgeFailure, outbox.failures.length);
		if (outbox.deleted) deps.log('trace', 'purge.outbox', { deleted: outbox.deleted });
		// Residue on the outbox means the same thing it means for the ledger —
		// expired rows still present after a run (purge lag) — and was the one
		// signal of the two sweeps that had no log line at all.
		if (outbox.residue) deps.log('warn', 'purge.outbox.residue', { residue: outbox.residue });
		if (outbox.failures.length) deps.log('warn', 'purge.outbox.failures', { count: outbox.failures.length, failures: outbox.failures });
	} catch (e: unknown) {
		deps.metrics.inc(M.purgeError);
		deps.log('error', 'purge.outbox.error', { message: (e as Error).message });
	}

	return { ledger, outbox };
}
