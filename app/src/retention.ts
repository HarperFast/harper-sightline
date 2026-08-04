// Seven-day retention purge (ADR-003). An explicit per-record DELETE removes
// both record data AND secondary-index entries — the compliance-safe mechanism,
// unlike TTL eviction which leaves index residue and (source-less) can drop data
// inside the window. The purge is idempotent and re-runnable, so concurrent runs
// across threads/nodes are safe. `now` is injected so tests are time-controlled.

export const DAY_MS = 86_400_000;
export const RETENTION_DAYS = 7;

// Bounds records deleted per table per run so one run can't monopolize a worker
// thread; residue beyond this is cleared by the next scheduled run (self-healing).
export const MAX_DELETES_PER_RUN = 10_000;

export interface SearchQuery {
	conditions: Array<{ attribute: string; value: unknown; comparator?: string }>;
	operator?: 'and' | 'or';
	select?: string[];
	limit?: number;
}

// The minimal table surface purge/redaction need — backed by a Harper table in
// the component, a fake in tests. `search` yields matching records (each
// carrying its primary key); `delete` removes one record by primary key.
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
	residue: number; // expired rows still present after the purge (should be 0 unless capped)
	capped: boolean; // hit MAX_DELETES_PER_RUN — more remain for the next run
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

// Count records matching a query, up to `limit`. Used to verify deletion.
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

// Search for records matching the query and delete each by primary key. Returns
// the number of delete calls made. Shared by purge and compliance redaction.
// Per-key delete errors are swallowed: a key already removed by a concurrent
// purge on another thread/node is expected and harmless — callers verify actual
// removal with countMatching (residue), so a genuine failure is never masked.
export async function deleteMatchingKeys(
	table: PurgeableTable,
	keyField: string,
	conditions: SearchQuery['conditions'],
	operator?: 'and' | 'or',
): Promise<number> {
	const keys: string[] = [];
	for await (const row of table.search({ conditions, operator, select: [keyField], limit: MAX_DELETES_PER_RUN })) {
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

async function purgeTarget(target: RetentionTarget, cutoff: number): Promise<PurgeTableResult> {
	const condition = [{ attribute: target.tsField, value: cutoff, comparator: 'less_than' }];
	const deleted = await deleteMatchingKeys(target.table, target.keyField, condition);
	const capped = deleted >= MAX_DELETES_PER_RUN;
	// Verify physical deletion (ADR-003 §4): re-query for any remaining expired row.
	const residue = await countMatching(target.table, condition, undefined, target.keyField, 1);
	return { deleted, residue, capped };
}

// Purge every target's records older than the retention window. Per-table
// failures are captured (not thrown) so one bad table doesn't block the rest;
// residue without capping means a delete didn't take — a real, alertable fault.
export async function purgeExpired(targets: RetentionTarget[], nowMs: number, retentionDays = RETENTION_DAYS): Promise<PurgeResult> {
	const cutoff = cutoffMs(nowMs, retentionDays);
	const byTable: Record<string, PurgeTableResult> = {};
	const failures: string[] = [];
	let deleted = 0;
	let residueTotal = 0;
	for (const target of targets) {
		try {
			const result = await purgeTarget(target, cutoff);
			byTable[target.name] = result;
			deleted += result.deleted;
			residueTotal += result.residue;
			if (result.residue > 0 && !result.capped) {
				failures.push(`${target.name}: ${result.residue} expired rows remain after purge`);
			}
		} catch (err) {
			failures.push(`${target.name}: ${(err as Error).message}`);
		}
	}
	return { cutoff, deleted, residue: residueTotal, byTable, failures };
}
