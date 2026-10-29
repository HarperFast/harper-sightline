import type { QueryTable } from '../api/queries.ts';
import { cutoffMs } from '../retention/retention.ts';

// Operator-facing health from tables: cross-shop counts and ages only, no
// merchant-identifying labels, so it is safe for shared logs (unlike the shop-scoped
// getSummary). Pure and injectable so the alert logic is tested against fake tables.

// Alert thresholds: a delivery is normally processed within seconds and
// reconciliation runs every 10 minutes (docs/runbooks).
export const BACKLOG_STALE_MS = 5 * 60 * 1000; // oldest accepted-but-unprocessed delivery
export const RECONCILE_STALE_MS = 30 * 60 * 1000; // no successful reconcile checkpoint
// The purge runs every 5 minutes; a row this far past its retention window means it
// has fallen behind (or stopped), and the retention promise is being broken.
export const RETENTION_OVERDUE_MS = 30 * 60 * 1000;
// Overdue rows are counted up to this many per table: an index read, bounded when far behind.
export const OVERDUE_COUNT_LIMIT = 1_000;

export interface OpsHealth {
	now: number;
	backlog: { accepted: number; oldestAgeMs: number | null };
	deadLetter: { count: number };
	reconciliation: { shopsTracked: number; staleShops: number; stalestAgeMs: number | null };
	reauthorization: { shops: number };
	// overdueRows is a floor once a table reaches OVERDUE_COUNT_LIMIT.
	retention: { overdueRows: number; overdueTables: string[] };
	healthy: boolean;
}

// A retention target as health reads it; the timestamp field must be @indexed.
export interface RetentionCheck {
	name: string;
	keyField: string;
	tsField: string;
	retentionDays: number;
	table: Pick<QueryTable, 'search'>;
}

export interface OpsHealthDeps {
	deliveries: QueryTable; // WebhookDelivery
	checkpoints: QueryTable; // WorkerCheckpoint (reconcile:<shop> rows)
	credentials: QueryTable; // ShopCredential
	retention?: RetentionCheck[]; // purged tables (RETENTION_TARGETS, OUTBOX_RETENTION_TARGETS)
}

// Streams a search, selecting only the fields read, and returns the match count. Rows
// are not collected: a backlog can be tens of thousands of rows of ~5 KB payload.
async function scan(
	table: QueryTable,
	conditions: Parameters<QueryTable['search']>[0]['conditions'],
	select: string[],
	each?: (row: Record<string, unknown>) => void,
): Promise<number> {
	let n = 0;
	for await (const row of table.search({ conditions, operator: 'and', select })) {
		n++;
		each?.(row);
	}
	return n;
}

export async function computeOpsHealth(deps: OpsHealthDeps, now: number): Promise<OpsHealth> {
	let oldestReceivedAt: number | null = null;
	const accepted = await scan(deps.deliveries, [{ attribute: 'status', value: 'accepted' }], ['receivedAt'], (row) => {
		const receivedAt = typeof row.receivedAt === 'number' ? row.receivedAt : null;
		if (receivedAt !== null && (oldestReceivedAt === null || receivedAt < oldestReceivedAt)) oldestReceivedAt = receivedAt;
	});
	const oldestAgeMs = oldestReceivedAt === null ? null : Math.max(0, now - oldestReceivedAt);

	const deadLetter = await scan(deps.deliveries, [{ attribute: 'status', value: 'dead_letter' }], ['id']);

	// Reconcile checkpoints carry the last completed pass in `updatedAt`.
	let staleShops = 0;
	let stalestAgeMs: number | null = null;
	const shopsTracked = await scan(
		deps.checkpoints,
		[{ attribute: 'id', comparator: 'starts_with', value: 'reconcile:' }],
		['id', 'updatedAt'],
		(row) => {
			const updatedAt = typeof row.updatedAt === 'number' ? row.updatedAt : null;
			const ageMs = updatedAt === null ? null : Math.max(0, now - updatedAt);
			if (ageMs === null || ageMs > RECONCILE_STALE_MS) staleShops += 1;
			if (ageMs !== null && (stalestAgeMs === null || ageMs > stalestAgeMs)) stalestAgeMs = ageMs;
		},
	);

	// Needs merchant re-consent: surfaced but not "unhealthy".
	const reauthShops = await scan(deps.credentials, [{ attribute: 'status', value: 'reauthorization_required' }], ['shopId']);

	const retention = await overdueRetention(deps.retention ?? [], now);

	const backlogStale = oldestAgeMs !== null && oldestAgeMs > BACKLOG_STALE_MS;
	const reconcileStale = staleShops > 0;
	const healthy = deadLetter === 0 && !backlogStale && !reconcileStale && retention.overdueRows === 0;

	return {
		now,
		backlog: { accepted, oldestAgeMs },
		deadLetter: { count: deadLetter },
		reconciliation: { shopsTracked, staleShops, stalestAgeMs },
		reauthorization: { shops: reauthShops },
		retention,
		healthy,
	};
}

// Rows older than their window plus RETENTION_OVERDUE_MS: the purge's residue, read
// from the tables so a purge that never runs shows up too.
async function overdueRetention(checks: RetentionCheck[], now: number): Promise<OpsHealth['retention']> {
	let overdueRows = 0;
	const overdueTables: string[] = [];
	for (const check of checks) {
		const before = cutoffMs(now, check.retentionDays) - RETENTION_OVERDUE_MS;
		let n = 0;
		const rows = check.table.search({
			conditions: [{ attribute: check.tsField, comparator: 'less_than', value: before }],
			select: [check.keyField],
			limit: OVERDUE_COUNT_LIMIT,
		});
		for await (const _row of rows) n++;
		if (n) overdueTables.push(check.name);
		overdueRows += n;
	}
	return { overdueRows, overdueTables };
}
