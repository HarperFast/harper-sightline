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

// A shop's time budget. Admin calls are individually bounded (ADMIN_TIMEOUT_MS), so the pass checks
// the deadline between orders and pages: a pass can overrun by one call, never by the whole backlog.
export const RECONCILE_SHOP_BUDGET_MS = 60_000;

export interface SweepOptions {
	deadlineMs?: number;
	now?: () => number;
}

// Pages the shop's orders updated at/after `sinceMs`, applying each and advancing a
// durable cursor. The checkpoint is also written on the failure path: otherwise a
// throttle on page 3 of a backfill would discard the pages already done and the shop
// would never converge.
//
// Advancing to the newest `updatedAt` applied is safe because the caller queries
// `updated_at:>=cursor` ascending: resuming re-reads the boundary order
// (idempotent, event ids are deterministic) instead of skipping one that shares its timestamp.
//
// Past `deadlineMs` the pass stops where it is and checkpoints the progress as partial, so one
// large backlog cannot hold up the shops after it; the next sweep resumes from the cursor.
export async function sweepOrdersSince(deps: ReconcileSweepDeps, sinceMs: number, options: SweepOptions = {}): Promise<SweepResult> {
	const now = options.now ?? Date.now;
	const expired = () => options.deadlineMs !== undefined && now() >= options.deadlineMs;
	let cursor: string | undefined;
	let latest = sinceMs;
	let orders = 0;
	try {
		do {
			const page = await deps.fetchPage(sinceMs, cursor);
			cursor = page.nextCursor;
			for (let i = 0; i < page.orders.length; i++) {
				const order = page.orders[i];
				await deps.applyOrder(order);
				if (order.updatedAt !== undefined && order.updatedAt > latest) latest = order.updatedAt;
				orders += 1;
				// Out of time with orders or pages left: stop here, partial.
				if (expired() && (i < page.orders.length - 1 || cursor)) {
					await deps.saveCheckpoint(latest, false);
					return { orders, latest, complete: false };
				}
			}
			if (cursor && expired()) {
				await deps.saveCheckpoint(latest, false);
				return { orders, latest, complete: false };
			}
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
	// `deadlineMs` is this shop's own budget, started when the shop starts.
	reconcile(shopId: string, deadlineMs: number): Promise<{ orders: number } | null>;
	onFailure(shopId: string, err: unknown): void;
	shopBudgetMs?: number;
	now?: () => number;
}

export interface ReconcileShopsResult {
	shops: number;
	orders: number;
	failed: number;
}

// Isolates failures: one shop that keeps throwing must not starve the shops after it.
//
// The shop ids are read out before any network work. A live iterator holds a Harper read snapshot,
// which expires after maxTransactionOpenTime (30 s): one slow shop made the next advance throw
// ReadSnapshotExpiredError and the sweep never reached the shops after it.
export async function reconcileShops(shopRows: AsyncIterable<{ shopId: string }>, deps: ReconcileShopsDeps): Promise<ReconcileShopsResult> {
	const result: ReconcileShopsResult = { shops: 0, orders: 0, failed: 0 };
	const now = deps.now ?? Date.now;
	const budgetMs = deps.shopBudgetMs ?? RECONCILE_SHOP_BUDGET_MS;
	const shopIds: string[] = [];
	for await (const { shopId } of shopRows) shopIds.push(shopId);
	for (const shopId of shopIds) {
		try {
			const r = await deps.reconcile(shopId, now() + budgetMs);
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
