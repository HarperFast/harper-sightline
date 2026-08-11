import type { OrderProjection, WorkerCheckpoint } from '../domain/model.ts';
import { deriveOrderLane } from '../domain/orders.ts';
import { log } from '../observability/observe.ts';

// One-time backfill of the derived `state` column on order projections written
// before that column existed.
//
// WHY THIS IS NEEDED. `state` is written only when an event rebuilds a
// projection (src/ingest/projection.ts). Every projection already in the table on
// deploy day therefore has no `state` until a new event arrives for that order.
// getSummary and computeFlows derive the lane LIVE, but listOrders filters the
// STORED column — so every lane count disagreed with the list it links to, and
// the worst-affected population is precisely the one the worklist exists for: a
// paid, unfulfilled, QUIET order gets no further events by definition, so it
// never rebuilds. Reconciliation does not save it either, because that sweep is
// cursor-scoped (it only re-fetches orders updated since its checkpoint) and a
// quiet order is never re-fetched. It needs its own sweep.
//
// WHY IT SETS `state` FROM THE ROW rather than calling jobs.ts's
// updateOrderProjection (a full rebuild from the ledger): `state` is BY
// CONSTRUCTION a pure function of this row's own latches — the reducer computes
// it as `deriveOrderLane(next)` at the end of every fold — so re-deriving it
// from the stored latches yields exactly what a rebuild would write into that
// column, while touching nothing else. A rebuild would also cost an event query
// per row, and would FAIL TO CONVERGE for the very rows that need this most: a
// projection whose events have aged out of the 7-day ledger rebuilds to nothing,
// so the column would stay empty forever and this loop would never go quiet.
//
// CONVERGENCE. A durable checkpoint holds a `lastEventAt` frontier, the same
// shape src/ingest/inventoryEnrich.ts uses. Each tick reads one bounded batch at or
// after the frontier, ascending, and advances past it. Rows written after the
// deploy always carry `state` (the reducer wrote it), so once the frontier
// reaches the present the sweep reads a handful of rows, writes nothing, and
// stays quiet — no "done" flag needed, and no unbounded scan of the whole table
// on any tick.
//
// Every projection the reducer has ever written has `lastEventAt`, so nothing is
// invisible to this frontier. A row somehow lacking it is already invisible to
// every merchant-facing surface too (listOrders, getSummary and computeFlows all
// require `lastEventAt` inside the window), so it has no count to disagree with.

// Rows examined per tick. Bounded so one pass cannot monopolize a worker thread;
// the sweep simply takes more ticks on a large backlog.
export const BACKFILL_BATCH = 200;
export const BACKFILL_CHECKPOINT_ID = 'state-backfill:projections';

export interface BackfillQuerySpec {
	conditions: Array<{ attribute: string; value: unknown; comparator?: string }>;
	operator?: 'and' | 'or';
	sort?: { attribute: string; descending?: boolean };
	select?: string[];
	limit?: number;
}
export interface BackfillReadTable {
	search(spec: BackfillQuerySpec): AsyncIterable<Record<string, unknown>>;
	get(id: string): Promise<Record<string, unknown> | undefined>;
}

// Injected side effects: the real Harper tables in the component (jobs.ts wires
// them), FakeTables in tests. `patch` rather than `put`: only the one derived
// column is written, so a concurrent event write cannot lose another field.
export interface BackfillDeps {
	projections: BackfillReadTable & { patch(id: string, partial: Record<string, unknown>): Promise<void> };
	checkpoints: BackfillReadTable & { put(row: WorkerCheckpoint): Promise<void> };
}

export interface BackfillResult {
	// Rows examined this tick (bounded by BACKFILL_BATCH).
	scanned: number;
	// Rows that were missing `state` and now have it. Zero once converged.
	fixed: number;
	// The frontier this tick left behind, for logging/assertion.
	cursor: number;
}

export async function runStateBackfill(now: number, deps: BackfillDeps): Promise<BackfillResult> {
	const checkpoint = await deps.checkpoints.get(BACKFILL_CHECKPOINT_ID);
	const raw = Number((checkpoint as { cursor?: unknown } | undefined)?.cursor);
	const cursor = Number.isFinite(raw) ? raw : 0;

	const rows: Array<Record<string, unknown>> = [];
	for await (const row of deps.projections.search({
		conditions: [{ attribute: 'lastEventAt', value: cursor, comparator: 'greater_than_equal' }],
		operator: 'and',
		sort: { attribute: 'lastEventAt' },
		limit: BACKFILL_BATCH,
	})) {
		rows.push(row);
	}
	if (rows.length === 0) return { scanned: 0, fixed: 0, cursor };

	let fixed = 0;
	for (const row of rows) {
		if (row.state !== undefined && row.state !== null) continue;
		const id = String(row.id);
		// Re-read immediately before writing, and derive from THAT: an event landing
		// mid-sweep rebuilds the projection with a correct `state`, and patching from
		// a stale snapshot would overwrite it with the pre-event lane. Re-reading
		// narrows that window to the patch itself and uses the freshest latches.
		const fresh = (await deps.projections.get(id)) as OrderProjection | undefined;
		if (!fresh || (fresh.state !== undefined && fresh.state !== null)) continue;
		await deps.projections.patch(id, { state: deriveOrderLane(fresh) });
		fixed++;
	}

	// Advance the frontier. A FULL batch may have cut off rows tied at its highest
	// lastEventAt, so the frontier stops there and re-reads that tie group next
	// tick (idempotent — those rows now have `state` and are skipped). A partial
	// batch means we reached the present, so the frontier moves past it.
	const maxSeen = Math.max(...rows.map((r) => Number(r.lastEventAt)));
	const full = rows.length >= BACKFILL_BATCH;
	let next = full && maxSeen > cursor ? maxSeen : maxSeen + 1;
	if (full && maxSeen <= cursor) {
		// A whole batch sharing one millisecond. Advancing is the only way to make
		// progress, and more than BACKFILL_BATCH projections with an identical
		// lastEventAt would leave a residue — loud rather than silent, because the
		// symptom (a lane count that still disagrees with its list) is otherwise
		// indistinguishable from the defect this sweep exists to close.
		log('warn', 'state.backfill.tied_batch', { cursor, batch: rows.length, action: 'advancing past the tie' });
		next = maxSeen + 1;
	}
	await deps.checkpoints.put({ id: BACKFILL_CHECKPOINT_ID, cursor: String(next), updatedAt: now });
	return { scanned: rows.length, fixed, cursor: next };
}
