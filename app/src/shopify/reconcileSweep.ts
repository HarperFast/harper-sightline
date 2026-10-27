import type { ReconcileOrder } from './adminApi.ts';

// The order-pagination half of the reconcile sweep, kept out of jobs.ts so it is
// unit-testable without the Harper runtime.

export interface ReconcileSweepDeps {
	fetchPage(sinceMs: number, cursor?: string): Promise<{ orders: ReconcileOrder[]; nextCursor?: string }>;
	applyOrder(order: ReconcileOrder): Promise<void>;
	// The cursor always advances with reconciled progress, but only a finished pass may
	// refresh the completion stamp computeOpsHealth reads, or a shop that never finishes
	// would look fresh.
	saveCheckpoint(cursorMs: number, complete: boolean): Promise<void>;
}

export interface SweepResult {
	orders: number;
	latest: number;
	complete: boolean;
}

// Pages the shop's orders updated at/after `sinceMs`, applying each and advancing a
// durable cursor. The checkpoint is also written on the failure path: otherwise a
// throttle on page 3 of a backfill would discard the pages already done and the shop
// would never converge.
//
// Advancing to the newest `updatedAt` applied is safe because the caller queries
// `updated_at:>=cursor` ascending: resuming re-reads the boundary order
// (idempotent, event ids are deterministic) instead of skipping one that shares its timestamp.
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
		// A pass that failed before reconciling anything has no progress to persist.
		if (latest > sinceMs) await deps.saveCheckpoint(latest, false);
		throw err;
	}
	await deps.saveCheckpoint(latest, true);
	return { orders, latest, complete: true };
}

export interface ReconcileShopsDeps {
	reconcile(shopId: string): Promise<{ orders: number } | null>;
	onFailure(shopId: string, err: unknown): void;
}

export interface ReconcileShopsResult {
	shops: number;
	orders: number;
	failed: number;
}

// Isolates failures: one shop that keeps throwing must not starve the shops after it.
export async function reconcileShops(shopRows: AsyncIterable<{ shopId: string }>, deps: ReconcileShopsDeps): Promise<ReconcileShopsResult> {
	const result: ReconcileShopsResult = { shops: 0, orders: 0, failed: 0 };
	for await (const { shopId } of shopRows) {
		try {
			const r = await deps.reconcile(shopId);
			if (r) {
				result.shops += 1;
				result.orders += r.orders;
			}
		} catch (err) {
			result.failed += 1;
			deps.onFailure(shopId, err);
		}
	}
	return result;
}
