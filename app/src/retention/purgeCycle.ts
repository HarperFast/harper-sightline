import type { PurgeResult } from './retention.ts';
import { M, type LogLevel } from '../observability/observe.ts';

// Runs the ledger purge and the digest outbox purge back to back, each in its own
// try/catch, so a persistent ledger failure cannot disable the outbox retention
// disclosed to merchants. Deps-injected, and kept out of jobs.ts, so tests can
// import it under plain `node --test` without the Harper runtime.

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

// `now` is read once and shared by both sweeps so a tick is deterministic. The
// outbox cutoff therefore predates its own start by the ledger sweep's duration;
// that is safe because any row expiring inside the skew is picked up next tick.
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
		// Residue is expired rows still present after a run (purge lag).
		if (ledger.residue) deps.log('warn', 'purge.residue', { residue: ledger.residue });
		if (ledger.failures.length) deps.log('warn', 'purge.failures', { count: ledger.failures.length, failures: ledger.failures });
	} catch (e: unknown) {
		deps.metrics.inc(M.purgeError);
		deps.log('error', 'purge.error', { message: (e as Error).message });
	}

	// Own try/catch: see the module header. Same metrics as the ledger purge, which
	// are per-purge-activity rather than per-table.
	let outbox: PurgeResult | undefined;
	try {
		outbox = await deps.outboxPurge(now);
		deps.metrics.inc(M.purgeDeleted, outbox.deleted);
		if (outbox.failures.length) deps.metrics.inc(M.purgeFailure, outbox.failures.length);
		if (outbox.deleted) deps.log('trace', 'purge.outbox', { deleted: outbox.deleted });
		// Residue means the same as for the ledger.
		if (outbox.residue) deps.log('warn', 'purge.outbox.residue', { residue: outbox.residue });
		if (outbox.failures.length) deps.log('warn', 'purge.outbox.failures', { count: outbox.failures.length, failures: outbox.failures });
	} catch (e: unknown) {
		deps.metrics.inc(M.purgeError);
		deps.log('error', 'purge.outbox.error', { message: (e as Error).message });
	}

	return { ledger, outbox };
}
