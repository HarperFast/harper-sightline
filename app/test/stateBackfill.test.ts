import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTable } from './fakeTable.ts';
import { runStateBackfill, BACKFILL_BATCH, BACKFILL_CHECKPOINT_ID, type BackfillDeps } from '../src/jobs/stateBackfill.ts';
import { listOrders, getSummary, computeFlows } from '../src/api/queries.ts';
import { deriveOrderLane } from '../src/domain/orders.ts';
import type { OrderProjection } from '../src/domain/model.ts';
import { tombstoneId } from '../src/privacy/tombstone.ts';

// The one-time backfill of the derived `state` column on projections written
// before that column existed. Deps-injected, so this runs in plain node with
// FakeTables — no Harper runtime.

const NOW = 1_000_000_000_000;
const HOUR = 3_600_000;

function deps(projections: FakeTable, checkpoints = new FakeTable('id', [])): BackfillDeps & { checkpoints: FakeTable } {
	return {
		projections: projections as unknown as BackfillDeps['projections'],
		checkpoints: checkpoints as unknown as BackfillDeps['checkpoints'] & FakeTable,
		tombstones: new FakeTable('id', []),
	} as BackfillDeps & { checkpoints: FakeTable };
}

// A quiet, paid, unfulfilled order with no stored state: the production shape on
// deploy day, and the population the worklist exists for.
function legacyRow(id: string, ageHours: number): Record<string, unknown> {
	return {
		id: `s1:${id}`,
		shopId: 's1',
		orderId: id,
		paidAt: NOW - ageHours * HOUR,
		requiresFulfillment: true,
		lastEventAt: NOW - ageHours * HOUR,
	};
}

test('the backfill gives a legacy projection the lane its own latches imply', async () => {
	const projections = new FakeTable('id', [
		legacyRow('await', 30),
		{
			id: 's1:ful',
			shopId: 's1',
			orderId: 'ful',
			paidAt: NOW - 30 * HOUR,
			requiresFulfillment: true,
			fulfilledAt: NOW - 20 * HOUR,
			lastEventAt: NOW - 20 * HOUR,
		},
		{ id: 's1:digital', shopId: 's1', orderId: 'digital', paidAt: NOW - 3 * HOUR, lastEventAt: NOW - 3 * HOUR },
		{ id: 's1:unpaid', shopId: 's1', orderId: 'unpaid', lastEventAt: NOW - 4 * HOUR },
		{
			id: 's1:cancelled',
			shopId: 's1',
			orderId: 'cancelled',
			paidAt: NOW - 9 * HOUR,
			requiresFulfillment: true,
			fulfilledAt: NOW - 8 * HOUR,
			cancelledAt: NOW - 7 * HOUR,
			lastEventAt: NOW - 7 * HOUR,
		},
	]);
	const result = await runStateBackfill(NOW, deps(projections));
	assert.equal(result.fixed, 5);
	// Exactly what the reducer would have written: `state` is a pure function of the
	// row's own latches, which is why re-deriving it from the stored row (rather than
	// rebuilding from the ledger) is correct — and why it still works for a row whose
	// events have already aged out of the seven-day window.
	for (const row of projections.rows.values()) {
		assert.equal(row.state, deriveOrderLane(row as unknown as OrderProjection), `${row.id} got the lane its latches imply`);
	}
	assert.equal((await projections.get('s1:await'))?.state, 'awaiting');
	assert.equal((await projections.get('s1:ful'))?.state, 'fulfilled');
	assert.equal((await projections.get('s1:digital'))?.state, 'no_fulfillment_expected');
	assert.equal((await projections.get('s1:unpaid'))?.state, 'unpaid');
	assert.equal((await projections.get('s1:cancelled'))?.state, 'cancelled');
});

test('the backfill closes the count/list divergence it exists for', async () => {
	// The end-to-end statement of C1: before the sweep the Overview counts an
	// awaiting order the worklist cannot list; after it, they agree.
	const projections = new FakeTable('id', [legacyRow('quiet', 30), legacyRow('quieter', 50)]);
	const tables = {
		events: new FakeTable('eventId', []),
		projections,
		findings: new FakeTable('id', []),
		deliveries: new FakeTable('id', []),
		shops: new FakeTable('shopId', []),
	};

	const before = await getSummary(tables, 's1', NOW);
	assert.equal((before.orders as { awaitingConfirmation: number }).awaitingConfirmation, 2);
	assert.equal((await listOrders(projections, 's1', NOW, { state: 'awaiting' })).items.length, 0, 'the divergence');

	await runStateBackfill(NOW, deps(projections));

	const after = await getSummary(tables, 's1', NOW);
	const lanes = (await computeFlows(projections, 's1', NOW)).lanes as Record<string, number>;
	const listed = await listOrders(projections, 's1', NOW, { state: 'awaiting' });
	assert.equal((after.orders as { awaitingConfirmation: number }).awaitingConfirmation, listed.items.length);
	assert.equal(lanes.awaitingConfirmation, listed.items.length);
	assert.equal(listed.items.length, 2);
});

test('the backfill is idempotent and never rewrites a row that already has a lane', async () => {
	const projections = new FakeTable('id', [
		legacyRow('legacy', 30),
		// Already carries a state — and a DELIBERATELY WRONG one. The sweep must not
		// touch it: correcting stored state is the reducer's job (the next event for
		// that order rewrites it), and a sweep that also "corrected" rows would race
		// the reducer for every order in the table rather than only the stateless ones.
		{
			id: 's1:mine',
			shopId: 's1',
			orderId: 'mine',
			paidAt: NOW - 5 * HOUR,
			requiresFulfillment: true,
			lastEventAt: NOW - 5 * HOUR,
			state: 'refunded',
		},
	]);
	const patched: string[] = [];
	const watched = {
		search: (spec: unknown) => projections.search(spec as never),
		get: (id: string) => projections.get(id),
		patch: async (id: string, partial: Record<string, unknown>) => {
			patched.push(id);
			await projections.patch(id, partial);
		},
	};
	const checkpoints = new FakeTable('id', []);
	const first = await runStateBackfill(NOW, {
		projections: watched as unknown as BackfillDeps['projections'],
		checkpoints: checkpoints as unknown as BackfillDeps['checkpoints'],
		tombstones: new FakeTable('id', []),
	});
	assert.deepEqual(patched, ['s1:legacy']);
	assert.equal(first.fixed, 1);
	assert.equal((await projections.get('s1:mine'))?.state, 'refunded', 'an existing lane is left to the reducer');

	// Re-running is a no-op: the frontier has moved past these rows, and even a
	// frontier reset would find nothing left to fix.
	const second = await runStateBackfill(NOW, {
		projections: watched as unknown as BackfillDeps['projections'],
		checkpoints: checkpoints as unknown as BackfillDeps['checkpoints'],
		tombstones: new FakeTable('id', []),
	});
	assert.equal(second.fixed, 0);
	await checkpoints.delete(BACKFILL_CHECKPOINT_ID);
	const rescan = await runStateBackfill(NOW, {
		projections: watched as unknown as BackfillDeps['projections'],
		checkpoints: checkpoints as unknown as BackfillDeps['checkpoints'],
		tombstones: new FakeTable('id', []),
	});
	assert.equal(rescan.fixed, 0, 'idempotent from scratch');
	assert.deepEqual(patched, ['s1:legacy'], 'and it wrote exactly once, ever');
});

test('the backfill converges over several ticks and then goes quiet', async () => {
	// More legacy rows than one batch, so convergence has to come from the durable
	// checkpoint rather than from a single unbounded pass.
	const total = BACKFILL_BATCH + 25;
	const projections = new FakeTable(
		'id',
		Array.from({ length: total }, (_unused, i) => ({
			id: `s1:o${i}`,
			shopId: 's1',
			orderId: `o${i}`,
			paidAt: NOW - (i + 1) * 1000,
			requiresFulfillment: true,
			lastEventAt: NOW - (i + 1) * 1000,
		})),
	);
	const checkpoints = new FakeTable('id', []);
	const scanned: number[] = [];
	let fixed = 0;
	for (let tick = 0; tick < 6; tick++) {
		const r = await runStateBackfill(NOW, deps(projections, checkpoints));
		scanned.push(r.scanned);
		fixed += r.fixed;
	}
	assert.equal(fixed, total, 'every legacy row eventually got a lane');
	for (const row of projections.rows.values()) assert.ok(row.state, `${row.id} still has no lane`);
	// Bounded per tick — no pass may walk the whole table.
	for (const n of scanned) assert.ok(n <= BACKFILL_BATCH, `a tick scanned ${n} rows, past the batch bound`);
	// And quiet once converged: the last ticks read nothing at all, because the
	// frontier has passed every row and new rows arrive with `state` already set.
	assert.deepEqual(scanned.slice(-2), [0, 0], 'a converged sweep reads nothing and writes nothing');

	// A row written AFTER convergence carries its own state (the reducer wrote it),
	// so the sweep sees it and still writes nothing.
	await projections.put({
		id: 's1:new',
		shopId: 's1',
		orderId: 'new',
		paidAt: NOW,
		requiresFulfillment: true,
		lastEventAt: NOW + 5000,
		state: 'awaiting',
	});
	const afterNew = await runStateBackfill(NOW, deps(projections, checkpoints));
	assert.equal(afterNew.scanned, 1);
	assert.equal(afterNew.fixed, 0);
});

test('the backfill takes the freshest latches, so an event landing mid-sweep wins', async () => {
	// A projection that gains a fulfillment between the batch read and the write must
	// end up 'fulfilled', not 'awaiting' — otherwise this sweep would introduce the
	// same stale-lane defect it is fixing.
	const projections = new FakeTable('id', [legacyRow('racing', 30)]);
	const racing = {
		search: (spec: unknown) => projections.search(spec as never),
		get: async (id: string) => {
			// The reducer's rebuild lands here, but WITHOUT a state (the pathological
			// case: a concurrent writer that only updated latches).
			await projections.patch(id, { fulfilledAt: NOW - 1000, lastEventAt: NOW - 1000 });
			return projections.get(id);
		},
		patch: (id: string, partial: Record<string, unknown>) => projections.patch(id, partial),
	};
	await runStateBackfill(NOW, {
		projections: racing as unknown as BackfillDeps['projections'],
		checkpoints: new FakeTable('id', []) as unknown as BackfillDeps['checkpoints'],
		tombstones: new FakeTable('id', []),
	});
	assert.equal((await projections.get('s1:racing'))?.state, 'fulfilled', 'derived from the row as it is at write time');
});

test('the backfill checkpoint survives a corrupt cursor rather than skipping the table', async () => {
	const projections = new FakeTable('id', [legacyRow('legacy', 30)]);
	const checkpoints = new FakeTable('id', [{ id: BACKFILL_CHECKPOINT_ID, cursor: 'not-a-number' }]);
	const r = await runStateBackfill(NOW, deps(projections, checkpoints));
	assert.equal(r.fixed, 1, 'an unparseable cursor restarts from the beginning of time, never skips forward');
});

test('a group tied on one millisecond larger than the batch is examined in full, never skipped', async () => {
	const total = BACKFILL_BATCH * 2 + 37;
	const projections = new FakeTable(
		'id',
		Array.from({ length: total }, (_unused, i) => ({
			id: `s1:o${String(i).padStart(4, '0')}`,
			shopId: 's1',
			orderId: `o${i}`,
			paidAt: NOW - HOUR,
			requiresFulfillment: true,
			lastEventAt: NOW - HOUR,
		})),
	);
	await projections.put({ id: 's1:later', shopId: 's1', orderId: 'later', paidAt: NOW, lastEventAt: NOW });
	const checkpoints = new FakeTable('id', []);
	for (let tick = 0; tick < 8; tick++) await runStateBackfill(NOW, deps(projections, checkpoints));
	const unfixed = [...projections.rows.values()].filter((r) => r.state === undefined).map((r) => r.id);
	assert.deepEqual(unfixed, [], 'every row in the oversized tie group, and the row after it, got a lane');
	const quiet = await runStateBackfill(NOW, deps(projections, checkpoints));
	assert.equal(quiet.scanned, 0, 'converged');
});

test('a tie group that spans a batch boundary is resumed after the rows already examined', async () => {
	const rows = [
		...Array.from({ length: BACKFILL_BATCH - 3 }, (_unused, i) => ({ ...legacyRow(`a${i}`, 50), lastEventAt: NOW - 2 * HOUR })),
		...Array.from({ length: 10 }, (_unused, i) => ({ ...legacyRow(`b${i}`, 40), lastEventAt: NOW - HOUR })),
	];
	const projections = new FakeTable('id', rows);
	const checkpoints = new FakeTable('id', []);
	await runStateBackfill(NOW, deps(projections, checkpoints));
	await runStateBackfill(NOW, deps(projections, checkpoints));
	assert.equal([...projections.rows.values()].filter((r) => r.state === undefined).length, 0);
});

test('a projection deleted between the read and the patch is written back with its key, shop and lastEventAt', async () => {
	const projections = new FakeTable('id', [legacyRow('purged', 30)]);
	const purging = {
		search: (spec: unknown) => projections.search(spec as never),
		get: (id: string) => projections.get(id),
		patch: async (id: string, partial: Record<string, unknown>) => {
			await projections.delete(id);
			await projections.patch(id, partial);
		},
	};
	await runStateBackfill(NOW, {
		projections: purging as unknown as BackfillDeps['projections'],
		checkpoints: new FakeTable('id', []) as unknown as BackfillDeps['checkpoints'],
		tombstones: new FakeTable('id', []),
	});
	const row = await projections.get('s1:purged');
	assert.equal(row?.id, 's1:purged');
	assert.equal(row?.shopId, 's1');
	assert.equal(row?.lastEventAt, NOW - 30 * HOUR, 'the purge finds it by lastEventAt');
	assert.equal(row?.orderId, 'purged', 'a redaction finds it by orderId');
});

test('a projection customers/redact deletes between the read and the patch is not left written back', async () => {
	const projections = new FakeTable('id', [legacyRow('redacted', 30)]);
	const tombstones = new FakeTable('id', []);
	const redacting = {
		search: (spec: unknown) => projections.search(spec as never),
		get: (id: string) => projections.get(id),
		delete: (id: string) => projections.delete(id),
		patch: async (id: string, partial: Record<string, unknown>) => {
			await tombstones.put({ id: tombstoneId('s1', 'redacted'), shopId: 's1', orderId: 'redacted', redactedAt: NOW });
			await projections.delete(id);
			await projections.patch(id, partial);
		},
	};
	await runStateBackfill(NOW, {
		projections: redacting as unknown as BackfillDeps['projections'],
		checkpoints: new FakeTable('id', []) as unknown as BackfillDeps['checkpoints'],
		tombstones,
	});
	assert.equal(await projections.get('s1:redacted'), null);
});
