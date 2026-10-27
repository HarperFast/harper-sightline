import type { QueryTable } from '../api/queries.ts';

// Operator-facing health from tables: cross-shop counts and ages only, no
// merchant-identifying labels, so it is safe for shared logs (unlike the shop-scoped
// getSummary). Pure and injectable so the alert logic is tested against fake tables.

// Alert thresholds: a delivery is normally processed within seconds and
// reconciliation runs every 10 minutes (docs/runbooks).
export const BACKLOG_STALE_MS = 5 * 60 * 1000; // oldest accepted-but-unprocessed delivery
export const RECONCILE_STALE_MS = 30 * 60 * 1000; // no successful reconcile checkpoint

export interface OpsHealth {
	now: number;
	backlog: { accepted: number; oldestAgeMs: number | null };
	deadLetter: { count: number };
	reconciliation: { shopsTracked: number; staleShops: number; stalestAgeMs: number | null };
	reauthorization: { shops: number };
	healthy: boolean;
}

export interface OpsHealthDeps {
	deliveries: QueryTable; // WebhookDelivery
	checkpoints: QueryTable; // WorkerCheckpoint (reconcile:<shop> rows)
	credentials: QueryTable; // ShopCredential
}

// Iterates a search fully; the queried states have small cardinality.
async function collect(
	table: QueryTable,
	conditions: Parameters<QueryTable['search']>[0]['conditions'],
): Promise<Record<string, unknown>[]> {
	const rows: Record<string, unknown>[] = [];
	for await (const row of table.search({ conditions, operator: 'and' })) rows.push(row);
	return rows;
}

export async function computeOpsHealth(deps: OpsHealthDeps, now: number): Promise<OpsHealth> {
	const accepted = await collect(deps.deliveries, [{ attribute: 'status', value: 'accepted' }]);
	let oldestReceivedAt: number | null = null;
	for (const row of accepted) {
		const receivedAt = typeof row.receivedAt === 'number' ? row.receivedAt : null;
		if (receivedAt !== null && (oldestReceivedAt === null || receivedAt < oldestReceivedAt)) oldestReceivedAt = receivedAt;
	}
	const oldestAgeMs = oldestReceivedAt === null ? null : Math.max(0, now - oldestReceivedAt);

	const deadLetter = (await collect(deps.deliveries, [{ attribute: 'status', value: 'dead_letter' }])).length;

	// Reconcile checkpoints carry the last completed pass in `updatedAt`.
	const checkpoints = await collect(deps.checkpoints, [{ attribute: 'id', comparator: 'starts_with', value: 'reconcile:' }]);
	let staleShops = 0;
	let stalestAgeMs: number | null = null;
	for (const row of checkpoints) {
		const updatedAt = typeof row.updatedAt === 'number' ? row.updatedAt : null;
		const ageMs = updatedAt === null ? null : Math.max(0, now - updatedAt);
		if (ageMs === null || ageMs > RECONCILE_STALE_MS) staleShops += 1;
		if (ageMs !== null && (stalestAgeMs === null || ageMs > stalestAgeMs)) stalestAgeMs = ageMs;
	}

	// Needs merchant re-consent: surfaced but not "unhealthy".
	const reauthShops = (await collect(deps.credentials, [{ attribute: 'status', value: 'reauthorization_required' }])).length;

	const backlogStale = oldestAgeMs !== null && oldestAgeMs > BACKLOG_STALE_MS;
	const reconcileStale = staleShops > 0;
	const healthy = deadLetter === 0 && !backlogStale && !reconcileStale;

	return {
		now,
		backlog: { accepted: accepted.length, oldestAgeMs },
		deadLetter: { count: deadLetter },
		reconciliation: { shopsTracked: checkpoints.length, staleShops, stalestAgeMs },
		reauthorization: { shops: reauthShops },
		healthy,
	};
}
