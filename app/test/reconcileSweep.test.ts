import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReconcileOrder } from '../src/shopify/adminApi.ts';
import {
	sweepOrdersSince,
	reconcileShops,
	RECONCILE_INDEX_LAG_MS,
	type ReconcileSweepDeps,
	type ReconcileShopsDeps,
} from '../src/shopify/reconcileSweep.ts';
import { synthesizeEvents } from '../src/shopify/reconcile.ts';
import { writeEventWithSkus } from '../src/ingest/eventSkus.ts';
import { refreshOrder, type OrderTables } from '../src/ingest/orderRefresh.ts';
import { FakeTable } from './fakeTable.ts';

// The reconcile sweep fills gaps so the detector does not report an absence Sightline
// caused. These cover the convergence guarantee: progress already made is always
// persisted, even when a page fails mid-pass.

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

// One shop that keeps failing (402 frozen, 423 locked, 404, a throttle during
// backfill, a failed rotation) must not stop the shops after it from reconciling.
function shopDeps(outcomes: Record<string, { orders: number } | null | Error>) {
	const attempted: string[] = [];
	const failures: Array<{ shopId: string; message: string }> = [];
	const deps: ReconcileShopsDeps = {
		reconcile: async (shopId) => {
			attempted.push(shopId);
			const outcome = outcomes[shopId];
			if (outcome === undefined) throw new Error(`unscripted shop ${shopId}`);
			if (outcome instanceof Error) throw outcome;
			return outcome;
		},
		onFailure: (shopId, err) => failures.push({ shopId, message: (err as Error).message }),
	};
	return { deps, attempted, failures };
}

async function* shops(...ids: string[]) {
	for (const shopId of ids) yield { shopId };
}

test('a shop that throws does not stop later shops from reconciling', async () => {
	const { deps, attempted, failures } = shopDeps({
		a: { orders: 2 },
		b: new Error('admin graphql 402'),
		c: { orders: 3 },
		d: null,
	});

	const result = await reconcileShops(shops('a', 'b', 'c', 'd'), deps);

	assert.deepEqual(attempted, ['a', 'b', 'c', 'd']);
	assert.deepEqual(failures, [{ shopId: 'b', message: 'admin graphql 402' }]);
	assert.deepEqual(result, { shops: 2, orders: 5, failed: 1 });
});

test('every shop failing still visits every shop and reports each failure', async () => {
	const { deps, failures } = shopDeps({ a: new Error('423'), b: new Error('404') });

	const result = await reconcileShops(shops('a', 'b'), deps);

	assert.equal(failures.length, 2);
	assert.deepEqual(result, { shops: 0, orders: 0, failed: 2 });
});

test('orders with no updatedAt cannot drag the cursor backwards', async () => {
	const { deps, checkpoints } = memDeps([[order('1', 5000), { orderId: '2', fulfillableUnits: 1 }], new Error('boom')]);

	await assert.rejects(() => sweepOrdersSince(deps, 500));

	assert.deepEqual(checkpoints, [5000], 'the timestamp-less order does not reset progress to sinceMs');
});

// Harper expires a read snapshot after maxTransactionOpenTime (30 s): a shop iterator still open
// while one shop's network work runs throws ReadSnapshotExpiredError mid-loop, which aborted the
// sweep with every later shop unattempted. This iterator behaves the same: once a shop has been
// reconciled, advancing it again throws.
function expiringShops(...ids: string[]) {
	const state = { reconciledAny: false };
	async function* rows() {
		for (const shopId of ids) {
			if (state.reconciledAny) throw new Error('ReadSnapshotExpiredError: read snapshot expired');
			yield { shopId };
		}
	}
	return { state, rows: rows() };
}

test('a slow shop cannot expire the shop read snapshot and abort the sweep', async () => {
	const { state, rows } = expiringShops('a', 'b', 'c');
	const attempted: string[] = [];
	const result = await reconcileShops(rows, {
		reconcile: async (shopId) => {
			attempted.push(shopId);
			state.reconciledAny = true;
			return { orders: 1 };
		},
		onFailure: () => assert.fail('no shop should fail'),
	});

	assert.deepEqual(attempted, ['a', 'b', 'c']);
	assert.deepEqual(result, { shops: 3, orders: 3, failed: 0 });
});

test('each shop is handed its own deadline, a fresh budget from when it starts', async () => {
	let clock = 1_000;
	const deadlines: Array<number | undefined> = [];
	await reconcileShops(shops('a', 'b'), {
		reconcile: async (_shopId, deadlineMs) => {
			deadlines.push(deadlineMs);
			clock += 500_000; // a slow shop must not eat the next shop's budget
			return { orders: 0 };
		},
		onFailure: () => {},
		shopBudgetMs: 60_000,
		now: () => clock,
	});

	assert.deepEqual(deadlines, [61_000, 561_000]);
});

test('a sweep past its deadline keeps its progress, checkpoints it as partial and stops', async () => {
	const { deps, applied, saved } = memDeps([[order('1', 1000), order('2', 2000)], [order('3', 3000)]]);
	// Long after the orders, so the index-lag fence is not what holds the cursor.
	let now = 10_000_000;

	const result = await sweepOrdersSince(
		{
			...deps,
			async applyOrder(o) {
				await deps.applyOrder(o);
				now += 10; // the second order lands past the deadline
			},
		},
		500,
		{ deadlineMs: 10_000_015, now: () => now },
	);

	assert.deepEqual(applied, ['1', '2'], 'stops before the next page');
	assert.equal(result.complete, false);
	assert.deepEqual(saved, [{ cursorMs: 2000, complete: false }], 'the cursor keeps the progress without refreshing the completion stamp');
});

// Shopify's order search is indexed asynchronously, so an order updated just
// before a pass can be missing from it while a later-updated order is already
// there. Advancing the cursor to that later order then puts the first one behind
// `updated_at:>=cursor` for good. This index serves only what is visible at the
// pass's clock, in the caller's query shape (>= since, ascending).
function laggingIndex(entries: Array<{ order: ReconcileOrder; visibleAt: number }>) {
	const applied: string[] = [];
	const saved: Array<{ cursorMs: number; complete: boolean }> = [];
	let clock = 0;
	const deps: ReconcileSweepDeps = {
		async fetchPage(since) {
			const orders = entries
				.filter((e) => e.visibleAt <= clock && (e.order.updatedAt ?? 0) >= since)
				.map((e) => e.order)
				.sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
			return { orders };
		},
		async applyOrder(o) {
			applied.push(o.orderId);
		},
		async saveCheckpoint(cursorMs, complete) {
			saved.push({ cursorMs, complete });
		},
	};
	const pass = async (at: number, since: number) => {
		clock = at;
		return sweepOrdersSince(deps, since, { now: () => clock });
	};
	return { pass, applied, saved };
}

const T = Date.parse('2026-10-30T12:00:00Z');

test('an order indexed after a later-updated one is still read by the next pass', async () => {
	const { pass, applied, saved } = laggingIndex([
		{ order: order('late', T - 45_000), visibleAt: T + 10_000 },
		{ order: order('prompt', T - 30_000), visibleAt: T - 29_000 },
	]);

	await pass(T, T - 3_600_000);
	assert.deepEqual(applied, ['prompt'], 'the first pass cannot see the late order yet');
	await pass(T + 30 * 60_000, saved[0].cursorMs);

	assert.ok(applied.includes('late'), `the second pass re-reads the lag window (cursor was ${saved[0].cursorMs - T} ms from T)`);
});

test('the checkpoint stays RECONCILE_INDEX_LAG_MS behind the pass start, and at the newest order when that is older', async () => {
	const { pass, saved } = laggingIndex([
		{ order: order('old', T - 10 * 60_000), visibleAt: 0 },
		{ order: order('recent', T - 5_000), visibleAt: 0 },
	]);

	await pass(T, T - 3_600_000);
	await pass(T + 30 * 60_000, T - 3_600_000);

	assert.equal(saved[0].cursorMs, T - RECONCILE_INDEX_LAG_MS, 'the newest order is inside the lag window: stop short of it');
	assert.equal(saved[1].cursorMs, T - 5_000, 'everything is long indexed: the newest order itself, as before');
});

test('the lag margin never moves the cursor backwards', async () => {
	const { pass, saved } = laggingIndex([{ order: order('within', T - 20_000), visibleAt: 0 }]);

	// A quiet shop (nothing new since the cursor), then a shop whose only new order
	// sits inside the margin: both keep the cursor where it was.
	await pass(T, T - 10_000);
	await pass(T, T - 50_000);

	assert.deepEqual(
		saved.map((s) => s.cursorMs),
		[T - 10_000, T - 50_000],
	);
});

// The margin's correctness rests on re-reading an order being a no-op. This folds
// the same orders twice through the writer jobs.ts's applyOrder uses (synthesize,
// writeEventWithSkus, refreshOrder; its redaction-tombstone skip is not part of
// the fold) and requires every table to come out unchanged. The detector's
// output legitimately moves with the clock, so both folds evaluate at one `now`:
// any difference left is drift from the re-read itself.
test('re-reading the overlap window adds no events and leaves every projection and finding as it was', async () => {
	const ledger = {
		events: new FakeTable('eventId'),
		eventSkus: new FakeTable('id'),
		projections: new FakeTable('id'),
		expectations: new FakeTable('id'),
		findings: new FakeTable('id'),
	};
	// A webhook already recorded one of them: the re-read must merge, not double up.
	await ledger.events.put({
		eventId: 'wh-1',
		shopId: 's',
		domain: 'order',
		topic: 'orders/paid',
		state: 'paid',
		resourceId: 'shipped',
		source: 'webhook',
		occurredAt: T - 3 * 3_600_000,
		receivedAt: T - 3 * 3_600_000,
		fulfillableItemCount: 1,
	});
	const orders: ReconcileOrder[] = [
		{ orderId: 'waiting', financialStatus: 'PAID', createdAt: T - 2 * 3_600_000, updatedAt: T - 40_000, fulfillableUnits: 2 },
		{
			orderId: 'shipped',
			financialStatus: 'PAID',
			fulfillmentStatus: 'FULFILLED',
			createdAt: T - 3 * 3_600_000,
			updatedAt: T - 20_000,
			fulfilledAt: T - 20_000,
			fulfillableUnits: 1,
		},
	];
	const deps: ReconcileSweepDeps = {
		async fetchPage(since) {
			return { orders: orders.filter((o) => (o.updatedAt ?? 0) >= since) };
		},
		async applyOrder(o) {
			for (const event of synthesizeEvents('s', o))
				await writeEventWithSkus(ledger as unknown as Parameters<typeof writeEventWithSkus>[0], event);
			await refreshOrder(ledger as unknown as OrderTables, 's', o.orderId, T);
		},
		async saveCheckpoint(cursorMs) {
			cursor = cursorMs;
		},
	};
	const snapshot = () => Object.fromEntries(Object.entries(ledger).map(([name, table]) => [name, structuredClone([...table.rows])]));
	let cursor = T - 3_600_000;

	const first = await sweepOrdersSince(deps, cursor, { now: () => T });
	const afterFirst = snapshot();
	const second = await sweepOrdersSince(deps, cursor, { now: () => T + 30 * 60_000 });

	assert.equal(first.orders, 2);
	assert.equal(second.orders, 2, 'both orders sit inside the margin, so the second pass re-reads both');
	assert.deepEqual(snapshot(), afterFirst);
	assert.equal(ledger.events.rows.size, 1 + 1 + 2, 'the webhook event, one recon event for "waiting", two for "shipped"');
	assert.ok(
		ledger.projections.rows.size === 2 && ledger.expectations.rows.size > 0,
		'the fold did write projections and expectations to compare',
	);
});
