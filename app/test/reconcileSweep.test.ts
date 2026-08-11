import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReconcileOrder } from '../src/shopify/adminApi.ts';
import { sweepOrdersSince, type ReconcileSweepDeps } from '../src/shopify/reconcileSweep.ts';

// The reconcile sweep is the gap-fill that stops the detector reporting an
// absence Sightline caused rather than the store. Before this module the paging
// loop lived in jobs.ts and wrote its checkpoint only after the WHOLE pass
// completed, so any mid-pass failure (a Shopify throttle on page 3 of an install
// backfill) discarded the pass and the next sweep replayed the same pages, threw
// at the same place, and never advanced. These cover the convergence guarantee:
// progress already made is always persisted.

function order(orderId: string, updatedAt: number): ReconcileOrder {
	return { orderId, updatedAt, fulfillableUnits: 1 };
}

// Pages resolved in order; an Error in the list is thrown instead of returned.
function memDeps(pages: Array<Array<ReconcileOrder> | Error>, failOnOrderId?: string) {
	const applied: string[] = [];
	const saved: Array<{ cursorMs: number; complete: boolean }> = [];
	const checkpoints: number[] = [];
	let page = 0;
	const deps: ReconcileSweepDeps = {
		async fetchPage() {
			const next = pages[page];
			page += 1;
			if (next instanceof Error) throw next;
			if (next === undefined) throw new Error('fetchPage called more times than the test has pages');
			return { orders: next, nextCursor: page < pages.length ? `cursor-${page}` : undefined };
		},
		async applyOrder(o) {
			if (o.orderId === failOnOrderId) throw new Error(`apply failed for ${o.orderId}`);
			applied.push(o.orderId);
		},
		async saveCheckpoint(cursorMs, complete) {
			saved.push({ cursorMs, complete });
			checkpoints.push(cursorMs);
		},
	};
	return { deps, applied, checkpoints, saved };
}

test('a completed sweep applies every order and checkpoints the newest updatedAt', async () => {
	const { deps, applied, checkpoints } = memDeps([[order('1', 1000), order('2', 2000)], [order('3', 3000)]]);

	const result = await sweepOrdersSince(deps, 500);

	assert.deepEqual(applied, ['1', '2', '3']);
	assert.equal(result.orders, 3);
	assert.equal(result.complete, true);
	assert.deepEqual(checkpoints, [3000], 'one checkpoint, at the newest updatedAt seen');
});

test('a page fetch that throws mid-pagination persists the progress already made', async () => {
	const { deps, applied, checkpoints } = memDeps([[order('1', 1000), order('2', 2000)], new Error('admin graphql 429')]);

	await assert.rejects(() => sweepOrdersSince(deps, 500), /429/);

	assert.deepEqual(applied, ['1', '2'], 'the orders from the successful page are applied');
	assert.deepEqual(checkpoints, [2000], 'and the cursor advances to them, so the next sweep resumes instead of replaying');
});

test('a failure before any order is applied leaves the checkpoint untouched', async () => {
	const { deps, applied, checkpoints } = memDeps([new Error('admin graphql 429')]);

	await assert.rejects(() => sweepOrdersSince(deps, 500), /429/);

	assert.deepEqual(applied, []);
	assert.deepEqual(checkpoints, [], 'nothing was reconciled, so there is no progress to record');
});

test('an applyOrder failure also persists the progress made before it', async () => {
	const { deps, applied, checkpoints } = memDeps([[order('1', 1000), order('2', 2000), order('3', 3000)]], '3');

	await assert.rejects(() => sweepOrdersSince(deps, 500), /apply failed for 3/);

	assert.deepEqual(applied, ['1', '2']);
	assert.deepEqual(checkpoints, [2000], 'the two applied orders are not re-read on the next sweep');
});

test('the checkpoint is the newest updatedAt itself, not one past it', async () => {
	// The caller queries `updated_at:>=cursor`, so checkpointing AT the boundary
	// re-reads the boundary order next sweep (idempotent — deterministic event
	// ids) rather than skipping an order that shares that timestamp but landed on
	// the page we never fetched.
	const { deps, checkpoints } = memDeps([[order('1', 7000)], new Error('boom')]);

	await assert.rejects(() => sweepOrdersSince(deps, 500));

	assert.deepEqual(checkpoints, [7000]);
});

// The checkpoint row carries two independent facts: `cursor` (how far we have
// reconciled) and the completion stamp that computeOpsHealth reads for reconcile
// staleness. Advancing the cursor on a partial pass must NOT refresh the
// completion stamp — otherwise a shop failing on page 3 of every sweep looks
// perfectly fresh in ops.snapshot while never finishing a pass, which would hide
// exactly the non-convergence this module exists to prevent.
test('a partial pass advances the cursor without marking the pass complete', async () => {
	const { deps, saved } = memDeps([[order('1', 1000)], new Error('admin graphql 429')]);

	await assert.rejects(() => sweepOrdersSince(deps, 500));

	assert.deepEqual(saved, [{ cursorMs: 1000, complete: false }]);
});

test('a finished pass marks the pass complete, so staleness clears', async () => {
	const { deps, saved } = memDeps([[order('1', 1000)]]);

	await sweepOrdersSince(deps, 500);

	assert.deepEqual(saved, [{ cursorMs: 1000, complete: true }]);
});

test('orders with no updatedAt cannot drag the cursor backwards', async () => {
	const { deps, checkpoints } = memDeps([[order('1', 5000), { orderId: '2', fulfillableUnits: 1 }], new Error('boom')]);

	await assert.rejects(() => sweepOrdersSince(deps, 500));

	assert.deepEqual(checkpoints, [5000], 'the timestamp-less order does not reset progress to sinceMs');
});
