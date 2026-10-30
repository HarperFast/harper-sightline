import type { OrderProjection, WorkerCheckpoint } from '../domain/model.ts';
import { deriveOrderLane } from '../domain/orders.ts';

// Backfills the derived `state` column on projections written before it existed.
// `state` is written only when an event rebuilds a projection, and listOrders filters
// the stored column while getSummary/computeFlows derive the lane live. A quiet
// paid-unfulfilled order gets no further events, and reconciliation's cursor-scoped
// sweep never re-fetches it, so it needs its own sweep.
//
// It derives `state` from the row's own latches (the reducer computes it as
// `deriveOrderLane(next)`) instead of calling updateOrderProjection: a rebuild costs
// an event query per row and would never converge for projections whose events aged
// out of the 7-day ledger.
//
// A durable `lastEventAt` frontier (same shape as inventoryEnrich) bounds each tick
// to one batch. Later rows carry `state`, so once the frontier reaches the present
// the sweep writes nothing. Every reducer-written projection has `lastEventAt`; a row
// lacking it is invisible to every merchant-facing surface anyway.

// Bounds one pass so it cannot monopolize a worker thread.
export const BACKFILL_BATCH = 200;
export const BACKFILL_CHECKPOINT_ID = 'state-backfill:projections';

export interface BackfillQuerySpec {
	conditions: Array<{ attribute: string; value: unknown; comparator?: string }>;
	operator?: 'and' | 'or';
	sort?: { attribute: string; descending?: boolean };
	select?: string[];
	limit?: number;
	offset?: number;
}
export interface BackfillReadTable {
	search(spec: BackfillQuerySpec): AsyncIterable<Record<string, unknown>>;
	get(id: string): Promise<Record<string, unknown> | null>;
}

// Injected side effects. `patch` writes the derived column and the row's identity fields only, so a
// concurrent event write cannot lose another field.
export interface BackfillDeps {
	projections: BackfillReadTable & { patch(id: string, partial: Record<string, unknown>): Promise<void> };
	checkpoints: BackfillReadTable & { put(row: WorkerCheckpoint): Promise<void> };
}

export interface BackfillResult {
	scanned: number;
	// Rows that were missing `state`. Zero once converged.
	fixed: number;
	cursor: number;
}

// The checkpoint cursor is `ms` or `ms:skip`: `skip` counts rows already examined
// at exactly `ms`, so a group tied on one millisecond is paged through with an
// offset instead of being skipped or re-read forever.
function parseCursor(raw: unknown): { ms: number; skip: number } {
	const [msPart, skipPart] = String(raw ?? '').split(':');
	const ms = Number(msPart);
	if (!msPart || !Number.isFinite(ms)) return { ms: 0, skip: 0 };
	const skip = Number(skipPart);
	return { ms, skip: Number.isInteger(skip) && skip > 0 ? skip : 0 };
}

export async function runStateBackfill(now: number, deps: BackfillDeps): Promise<BackfillResult> {
	const checkpoint = await deps.checkpoints.get(BACKFILL_CHECKPOINT_ID);
	const { ms: cursor, skip } = parseCursor((checkpoint as { cursor?: unknown } | undefined)?.cursor);

	const rows: Array<Record<string, unknown>> = [];
	for await (const row of deps.projections.search({
		conditions: [{ attribute: 'lastEventAt', value: cursor, comparator: 'greater_than_equal' }],
		operator: 'and',
		sort: { attribute: 'lastEventAt' },
		limit: BACKFILL_BATCH,
		...(skip > 0 ? { offset: skip } : {}),
	})) {
		rows.push(row);
	}
	if (rows.length === 0) return { scanned: 0, fixed: 0, cursor };

	let fixed = 0;
	for (const row of rows) {
		if (row.state !== undefined && row.state !== null) continue;
		const id = String(row.id);
		// Re-read and derive from the fresh row: patching from a stale snapshot would
		// overwrite an event-driven rebuild's correct `state`.
		const fresh = ((await deps.projections.get(id)) ?? undefined) as OrderProjection | undefined;
		if (!fresh || (fresh.state !== undefined && fresh.state !== null)) continue;
		// The key, shop and lastEventAt ride along: if a purge or redaction deletes the row
		// before this lands, Harper recreates it from the patch alone, and those are what
		// the purge and a redaction find it by.
		await deps.projections.patch(id, { state: deriveOrderLane(fresh), id, shopId: fresh.shopId, lastEventAt: fresh.lastEventAt });
		fixed++;
	}

	// A full batch may have cut off rows tied at its highest lastEventAt, so the
	// frontier stays at that millisecond and records how many it has examined. A
	// partial batch means the present was reached.
	const maxSeen = Math.max(...rows.map((r) => Number(r.lastEventAt)));
	let nextMs: number;
	let nextSkip = 0;
	if (rows.length < BACKFILL_BATCH) {
		nextMs = maxSeen + 1;
	} else {
		nextMs = maxSeen;
		nextSkip = rows.filter((r) => Number(r.lastEventAt) === maxSeen).length + (maxSeen === cursor ? skip : 0);
	}
	await deps.checkpoints.put({
		id: BACKFILL_CHECKPOINT_ID,
		cursor: nextSkip > 0 ? `${nextMs}:${nextSkip}` : String(nextMs),
		updatedAt: now,
	});
	return { scanned: rows.length, fixed, cursor: nextMs };
}
