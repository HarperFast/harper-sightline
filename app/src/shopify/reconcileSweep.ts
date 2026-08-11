import type { ReconcileOrder } from './adminApi.ts';

// The order-pagination half of the reconcile sweep (#13), kept out of jobs.ts so
// it is unit-testable without the Harper runtime — the same split
// inventoryEnrich.ts and processor.ts already use. jobs.ts wires the real Admin
// API call, the projection/detector writes, and the durable checkpoint.

export interface ReconcileSweepDeps {
	fetchPage(sinceMs: number, cursor?: string): Promise<{ orders: ReconcileOrder[]; nextCursor?: string }>;
	applyOrder(order: ReconcileOrder): Promise<void>;
	// `complete` separates the two facts the checkpoint row carries: the cursor
	// always advances with reconciled progress, but only a finished pass may
	// refresh the completion stamp computeOpsHealth reads for reconcile staleness.
	// Refreshing it on a partial pass would make a shop that never finishes look
	// fresh in ops.snapshot — hiding the non-convergence this module prevents.
	saveCheckpoint(cursorMs: number, complete: boolean): Promise<void>;
}

export interface SweepResult {
	orders: number;
	latest: number;
	complete: boolean;
}

// Page through the shop's orders updated at/after `sinceMs`, applying each one and
// advancing a durable cursor.
//
// WHY the checkpoint is written on the failure path too: this loop previously
// checkpointed only after the whole pass finished, so a failure on page 3 of an
// install backfill (a Shopify throttle is the realistic cause — a 7-day backfill
// for a busy store is many pages) discarded every page already reconciled. The
// next sweep restarted from the same cursor, threw at the same page, and never
// advanced — reconciliation for that shop never converged. Since reconciliation is
// what fills gaps the webhooks missed, a shop stuck there keeps producing findings
// about absences Sightline caused rather than the store.
//
// Advancing to the newest `updatedAt` actually applied is safe because the caller
// queries `updated_at:>=cursor` and Shopify returns the page ascending by
// UPDATED_AT: resuming re-reads the boundary order (idempotent — reconciliation
// event ids are deterministic) instead of skipping an order that shares that
// timestamp but sat on the page we never fetched.
export async function sweepOrdersSince(deps: ReconcileSweepDeps, sinceMs: number): Promise<SweepResult> {
	let cursor: string | undefined;
	let latest = sinceMs;
	let orders = 0;
	try {
		do {
			const page = await deps.fetchPage(sinceMs, cursor);
			for (const order of page.orders) {
				await deps.applyOrder(order);
				if (order.updatedAt !== undefined && order.updatedAt > latest) latest = order.updatedAt;
				orders += 1;
			}
			cursor = page.nextCursor;
		} while (cursor);
	} catch (err) {
		// Only a cursor that actually moved is worth recording; a pass that failed
		// before reconciling anything has no progress to persist.
		if (latest > sinceMs) await deps.saveCheckpoint(latest, false);
		throw err;
	}
	await deps.saveCheckpoint(latest, true);
	return { orders, latest, complete: true };
}
