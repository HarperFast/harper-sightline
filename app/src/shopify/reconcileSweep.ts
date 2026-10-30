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

// Shopify indexes order search asynchronously: an order updated just before a pass
// can be missing from it while a later-updated one is already there. The cursor is
// held this far behind the pass start so the next pass re-reads that window.
export const RECONCILE_INDEX_LAG_MS = 60_000;

export interface SweepOptions {
	deadlineMs?: number;
	now?: () => number;
}

// Pages the shop's orders updated at/after `sinceMs`, applying each and advancing a
// durable cursor. The checkpoint is also written on the failure path: otherwise a
// throttle on page 3 of a backfill would discard the pages already done and the shop
// would never converge.
//
// The cursor advances to the newest `updatedAt` applied, but never past
// RECONCILE_INDEX_LAG_MS before the pass started, and never backwards. The caller
// queries `updated_at:>=cursor` ascending, so resuming re-reads the boundary order
// and the lag window rather than skipping an order that shares the timestamp or
// was not indexed yet. Re-reading is idempotent: event ids are deterministic and
// the projection is rebuilt from the whole ledger. The fence is on our clock and the
// orders on Shopify's: a clock running ahead of Shopify's shrinks the overlap by
// that skew, never below none, which is where this started.
// A backlog older than the margin still checkpoints at its newest order, so a burst
// larger than one pass's budget keeps advancing.
//
// Past `deadlineMs` the pass stops where it is and checkpoints the progress as partial, so one
// large backlog cannot hold up the shops after it; the next sweep resumes from the cursor.
export async function sweepOrdersSince(deps: ReconcileSweepDeps, sinceMs: number, options: SweepOptions = {}): Promise<SweepResult> {
	const now = options.now ?? Date.now;
	const expired = () => options.deadlineMs !== undefined && now() >= options.deadlineMs;
	const fenceMs = now() - RECONCILE_INDEX_LAG_MS;
	let cursor: string | undefined;
	let latest = sinceMs;
	const checkpointAt = () => Math.max(sinceMs, Math.min(latest, fenceMs));
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
					await deps.saveCheckpoint(checkpointAt(), false);
					return { orders, latest, complete: false };
				}
			}
			if (cursor && expired()) {
				await deps.saveCheckpoint(checkpointAt(), false);
				return { orders, latest, complete: false };
			}
		} while (cursor);
	} catch (err) {
		// A pass that failed before reconciling anything has no progress to persist.
		if (checkpointAt() > sinceMs) await deps.saveCheckpoint(checkpointAt(), false);
		throw err;
	}
	await deps.saveCheckpoint(checkpointAt(), true);
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
