import type { QueryTable } from '../api/queries.ts';

// Operational health snapshot (#22): an aggregate, operator-facing view derived
// from tables. Distinct from getSummary (merchant-facing, shop-scoped): this is
// cross-shop and carries NO merchant-identifying labels — only counts and ages —
// so it is safe to emit to shared operator logs. Pure and injectable (like
// queries.ts) so the health/alert logic is unit-tested against fake tables.

// Alert thresholds. A delivery normally acks and is processed within seconds;
// reconciliation runs every 10 minutes. These bound "healthy" and back the
// runbook alert conditions (docs/runbooks).
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

// Iterate a search fully, returning the matched rows. Bounded in practice by the
// small cardinality of the states queried (accepted backlog, dead letters,
// reconcile checkpoints, credentials).
async function collect(
	table: QueryTable,
	conditions: Parameters<QueryTable['search']>[0]['conditions'],
): Promise<Record<string, unknown>[]> {
	const rows: Record<string, unknown>[] = [];
	for await (const row of table.search({ conditions, operator: 'and' })) rows.push(row);
	return rows;
}

export async function computeOpsHealth(deps: OpsHealthDeps, now: number): Promise<OpsHealth> {
	// Backlog: accepted-but-unprocessed deliveries and the age of the oldest.
	const accepted = await collect(deps.deliveries, [{ attribute: 'status', value: 'accepted' }]);
	let oldestReceivedAt: number | null = null;
	for (const row of accepted) {
		const receivedAt = typeof row.receivedAt === 'number' ? row.receivedAt : null;
		if (receivedAt !== null && (oldestReceivedAt === null || receivedAt < oldestReceivedAt)) oldestReceivedAt = receivedAt;
	}
	const oldestAgeMs = oldestReceivedAt === null ? null : Math.max(0, now - oldestReceivedAt);

	// Dead letters: deliveries that exhausted retries (visible, alertable).
	const deadLetter = (await collect(deps.deliveries, [{ attribute: 'status', value: 'dead_letter' }])).length;

	// Reconciliation freshness: per-shop `reconcile:<shop>` checkpoints carry the
	// last successful pass in `updatedAt`. Staleness is now − updatedAt.
	const checkpoints = await collect(deps.checkpoints, [{ attribute: 'id', comparator: 'starts_with', value: 'reconcile:' }]);
	let staleShops = 0;
	let stalestAgeMs: number | null = null;
	for (const row of checkpoints) {
		const updatedAt = typeof row.updatedAt === 'number' ? row.updatedAt : null;
		const ageMs = updatedAt === null ? null : Math.max(0, now - updatedAt);
		if (ageMs === null || ageMs > RECONCILE_STALE_MS) staleShops += 1;
		if (ageMs !== null && (stalestAgeMs === null || ageMs > stalestAgeMs)) stalestAgeMs = ageMs;
	}

	// Reauthorization: shops whose offline credential needs merchant re-consent
	// (a refresh failed). Expected merchant action, surfaced but not "unhealthy".
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
