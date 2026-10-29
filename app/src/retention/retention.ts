// Seven-day retention purge (ADR-003). An explicit per-record DELETE removes record
// data and secondary-index entries, unlike TTL eviction, which leaves index residue.
// Idempotent and re-runnable, so concurrent runs are safe. `now` is injected for tests.

export const DAY_MS = 86_400_000;
export const RETENTION_DAYS = 7;

// The digest outbox's window (OUTBOX_RETENTION_TARGETS), swept separately from the
// seven-day ledger. Lives here, not in ledgerTargets.ts, so queries.ts and
// privacyPolicy.ts can import it without pulling in db.ts.
export const OUTBOX_RETENTION_DAYS = 30;

// Bounds the deletes of one deleteMatchingKeys call (redaction); its callers
// re-check with countMatching. The purge pages in PURGE_BATCH instead.
export const MAX_DELETES_PER_RUN = 10_000;

// The purge deletes in batches until a table is clear or the run's time budget is
// spent, taking one batch per table in turn so a table far behind cannot starve the
// rest. Each batch is its own short search, so no read outlives Harper's 30 s
// transaction limit. The budget is well inside the 5-minute sightline-purge
// interval; a run that ends with rows left reports them as residue and the next
// run continues. A fixed cap per run (10,000 per table) fell behind above about
// 2.8 rows/s per table.
export const PURGE_BATCH = 1_000;
export const PURGE_BUDGET_MS = 60_000;

// Residue (expired rows left after a run) is counted up to this many per table, so
// a table far behind costs one bounded index read, not a walk of all its residue.
export const RESIDUE_COUNT_LIMIT = 10_000;

export interface SearchQuery {
	conditions: Array<{ attribute: string; value: unknown; comparator?: string }>;
	operator?: 'and' | 'or';
	select?: string[];
	limit?: number;
}

// Minimal table surface purge and redaction need (a Harper table, or a fake in tests).
export interface PurgeableTable {
	search(query: SearchQuery): AsyncIterable<Record<string, unknown>>;
	delete(id: string): Promise<void>;
}

export interface RetentionTarget {
	name: string; // table name, for logging
	keyField: string; // primary-key attribute (e.g. id | eventId)
	tsField: string; // retention timestamp attribute
	table: PurgeableTable;
}

export interface PurgeTableResult {
	deleted: number;
	residue: number; // expired rows still present after the purge, up to RESIDUE_COUNT_LIMIT (0 unless capped)
	capped: boolean; // the time budget ran out first — the next run continues
}

export interface PurgeOptions {
	budgetMs?: number;
	clock?: () => number; // wall clock for the budget, injected for tests
}

export interface PurgeResult {
	cutoff: number;
	deleted: number;
	residue: number; // total expired rows still present after the run — the purge-behind signal (0 when keeping up)
	byTable: Record<string, PurgeTableResult>;
	failures: string[];
}

export function cutoffMs(nowMs: number, retentionDays = RETENTION_DAYS): number {
	return nowMs - retentionDays * DAY_MS;
}

export async function countMatching(
	table: PurgeableTable,
	conditions: SearchQuery['conditions'],
	operator: 'and' | 'or' | undefined,
	keyField: string,
	limit: number,
): Promise<number> {
	let n = 0;
	for await (const _row of table.search({ conditions, operator, select: [keyField], limit })) n++;
	return n;
}

// Searches and deletes each match by primary key; returns the delete calls made.
// Per-key errors are swallowed (a key already removed by a concurrent purge is
// harmless); callers verify removal with countMatching, so a real failure is not masked.
export async function deleteMatchingKeys(
	table: PurgeableTable,
	keyField: string,
	conditions: SearchQuery['conditions'],
	operator?: 'and' | 'or',
	limit = MAX_DELETES_PER_RUN,
): Promise<number> {
	const keys: string[] = [];
	for await (const row of table.search({ conditions, operator, select: [keyField], limit })) {
		const key = row[keyField];
		if (typeof key === 'string') keys.push(key);
	}
	let deleted = 0;
	for (const key of keys) {
		try {
			await table.delete(key);
			deleted++;
		} catch {
			// already gone (idempotent / concurrent purge) — residue check is the source of truth
		}
	}
	return deleted;
}

// Per-table failures are captured, not thrown, so one bad table does not block the
// rest. Residue on a table the run finished means a delete did not take; on a table
// the budget cut short it is lag the next run continues.
export async function purgeExpired(
	targets: RetentionTarget[],
	nowMs: number,
	retentionDays = RETENTION_DAYS,
	{ budgetMs = PURGE_BUDGET_MS, clock = Date.now }: PurgeOptions = {},
): Promise<PurgeResult> {
	const cutoff = cutoffMs(nowMs, retentionDays);
	const deadline = clock() + budgetMs;
	const failures: string[] = [];
	const runs = targets.map((target) => ({
		target,
		condition: [{ attribute: target.tsField, value: cutoff, comparator: 'less_than' }],
		deleted: 0,
		more: true,
		failed: false,
	}));
	// Every table gets a batch per round, so the budget is checked between rounds.
	for (let pending = runs; pending.length; pending = pending.filter((r) => r.more && !r.failed)) {
		for (const run of pending) {
			try {
				const n = await deleteMatchingKeys(run.target.table, run.target.keyField, run.condition, undefined, PURGE_BATCH);
				run.deleted += n;
				// A short batch: the table is clear, or a delete failed and the residue check reports it.
				run.more = n === PURGE_BATCH;
			} catch (err) {
				run.failed = true;
				failures.push(`${run.target.name}: ${(err as Error).message}`);
			}
		}
		if (clock() >= deadline) break;
	}

	const byTable: Record<string, PurgeTableResult> = {};
	let deleted = 0;
	let residueTotal = 0;
	for (const run of runs) {
		deleted += run.deleted;
		if (run.failed) continue;
		try {
			// Verifies physical deletion (ADR-003 §4): re-query for remaining expired rows.
			const residue = await countMatching(run.target.table, run.condition, undefined, run.target.keyField, RESIDUE_COUNT_LIMIT);
			byTable[run.target.name] = { deleted: run.deleted, residue, capped: run.more };
			residueTotal += residue;
			if (residue > 0 && !run.more) failures.push(`${run.target.name}: ${residue} expired rows remain after purge`);
		} catch (err) {
			failures.push(`${run.target.name}: ${(err as Error).message}`);
		}
	}
	return { cutoff, deleted, residue: residueTotal, byTable, failures };
}
