import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	drainAccepted,
	partitionOf,
	runProcessCycle,
	MAX_ATTEMPTS,
	type DrainResult,
	type ProcessDeps,
	type DeliveryRow,
} from '../src/ingest/processor.ts';
import { M, type LogLevel } from '../src/observability/observe.ts';

const BUDGET = 8_000;

function memDeps(rows: DeliveryRow[], failIds = new Set<string>()) {
	const state = new Map(rows.map((r) => [r.id, { ...r }]));
	const handled: string[] = [];
	const listLimits: number[] = [];
	const deps: ProcessDeps = {
		async listAccepted(limit) {
			listLimits.push(limit);
			return [...state.values()].filter((r) => r.status === 'accepted').slice(0, limit);
		},
		async markProcessed(id) {
			state.get(id)!.status = 'processed';
		},
		async markFailed(id, attempts, dead) {
			const r = state.get(id)!;
			r.attempts = attempts;
			r.status = dead ? 'dead_letter' : 'accepted';
		},
		async handle(row) {
			handled.push(row.id);
			if (failIds.has(row.id)) throw new Error('boom');
		},
	};
	return { deps, state, handled, listLimits };
}

function accepted(n: number, prefix = 'd'): DeliveryRow[] {
	return Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, shopId: 's', status: 'accepted' as const }));
}

function statuses(state: Map<string, DeliveryRow>, status: DeliveryRow['status']): number {
	return [...state.values()].filter((r) => r.status === status).length;
}

test('processes accepted rows exactly once, then re-run is a no-op', async () => {
	const { deps, state, handled } = memDeps([
		{ id: 'a', shopId: 's', status: 'accepted' },
		{ id: 'b', shopId: 's', status: 'accepted' },
	]);
	const r = await drainAccepted(deps, { budgetMs: BUDGET });
	assert.equal(r.processed, 2);
	assert.equal(state.get('a')!.status, 'processed');
	assert.deepEqual(handled.sort(), ['a', 'b']);
	assert.equal((await drainAccepted(deps, { budgetMs: BUDGET })).processed, 0);
});

test('retries then dead-letters after MAX_ATTEMPTS', async () => {
	const { deps, state } = memDeps([{ id: 'x', shopId: 's', status: 'accepted', attempts: MAX_ATTEMPTS - 1 }], new Set(['x']));
	const r = await drainAccepted(deps, { budgetMs: BUDGET });
	assert.equal(r.failed, 1);
	assert.equal(r.deadLettered, 1);
	assert.equal(state.get('x')!.status, 'dead_letter');
	assert.equal(state.get('x')!.attempts, MAX_ATTEMPTS);
});

test('a transient failure stays accepted, and is attempted once per drain rather than burned down in one', async () => {
	const { deps, state, handled } = memDeps([{ id: 'y', shopId: 's', status: 'accepted', attempts: 0 }], new Set(['y']));
	const r = await drainAccepted(deps, { budgetMs: BUDGET });
	assert.equal(r.deadLettered, 0);
	assert.equal(r.stoppedBy, 'empty');
	assert.equal(state.get('y')!.status, 'accepted');
	assert.equal(state.get('y')!.attempts, 1, 'retry spacing is one attempt per occurrence, as under the old 10s loop');
	assert.deepEqual(handled, ['y']);
});

test('a permanent failure dead-letters immediately, without retries', async () => {
	const { deps, state } = memDeps([{ id: 'z', shopId: 's', status: 'accepted', attempts: 0 }]);
	deps.handle = async () => {
		throw Object.assign(new Error('broken payload'), { permanent: true });
	};
	const r = await drainAccepted(deps, { budgetMs: BUDGET });
	assert.equal(r.deadLettered, 1);
	assert.equal(state.get('z')!.status, 'dead_letter');
	assert.equal(state.get('z')!.attempts, 1);
});

test('drains past one batch until the backlog is empty', async () => {
	const { deps, state, listLimits } = memDeps(accepted(120));
	const r = await drainAccepted(deps, { budgetMs: BUDGET, batch: 50 });
	assert.equal(r.processed, 120);
	assert.equal(r.stoppedBy, 'empty');
	assert.equal(statuses(state, 'processed'), 120);
	assert.deepEqual(listLimits, [50, 50, 50, 50], 'three productive reads, then one that finds the backlog empty');
});

test('stops starting new rows once the time budget is spent, leaving the rest accepted for the next occurrence', async () => {
	const { deps, state } = memDeps(accepted(100));
	let clock = 0;
	const handle = deps.handle;
	deps.handle = async (row) => {
		clock += 1_000;
		await handle(row);
	};
	const r = await drainAccepted(deps, { budgetMs: 3_500, batch: 50, now: () => clock });
	assert.equal(r.stoppedBy, 'budget');
	assert.equal(r.processed, 4, 'rows start at t=0,1000,2000,3000; t=4000 is past the 3500ms budget');
	assert.equal(statuses(state, 'accepted'), 96);

	clock = 0;
	const next = await drainAccepted(deps, { budgetMs: BUDGET, batch: 50, now: () => clock });
	assert.equal(next.processed, 8);
	assert.equal(statuses(state, 'processed'), 12, 'the next occurrence resumes where the last stopped');
});

test('poison rows among healthy ones do not stop the healthy rows from draining', async () => {
	const rows = accepted(120);
	const poison = new Set(['d3', 'd40', 'd41', 'd77', 'd119']);
	const { deps, state, handled } = memDeps(rows, poison);
	const r = await drainAccepted(deps, { budgetMs: BUDGET, batch: 50 });
	assert.equal(r.stoppedBy, 'empty');
	assert.equal(r.processed, 115);
	assert.equal(r.failed, 5);
	assert.equal(handled.length, 120, 'every row is attempted exactly once in the occurrence');
	for (const id of poison) assert.equal(state.get(id)!.attempts, 1);
});

test('a drain stops after one batch of failures, so an outage burns no more attempts than the old one-batch tick', async () => {
	const failing = new Set(accepted(60, 'f').map((r) => r.id));
	const { deps, handled } = memDeps([...accepted(60, 'f'), ...accepted(30, 'ok')], failing);
	const r = await drainAccepted(deps, { budgetMs: BUDGET, batch: 50 });
	assert.equal(r.stoppedBy, 'failures');
	assert.equal(r.failed, 50);
	assert.equal(handled.length, 50);
});

test('a systemic outage dead-letters at most one batch over MAX_ATTEMPTS occurrences, with bounded reads', async () => {
	const rows = accepted(200);
	const { deps, state, listLimits } = memDeps(rows, new Set(rows.map((r) => r.id)));
	for (let occurrence = 0; occurrence < MAX_ATTEMPTS; occurrence++) await drainAccepted(deps, { budgetMs: BUDGET, batch: 50 });
	assert.ok(statuses(state, 'dead_letter') <= 50, `dead-lettered ${statuses(state, 'dead_letter')}`);
	assert.equal(statuses(state, 'accepted'), 150, 'the rest of the backlog survives to be processed once the outage ends');
	assert.ok(Math.max(...listLimits) <= 100, `read limits grew to ${Math.max(...listLimits)}`);
});

test('an error from the store propagates out of the drain', async () => {
	const { deps } = memDeps(accepted(3), new Set(['d1']));
	deps.markFailed = async () => {
		throw new Error('store down');
	};
	await assert.rejects(drainAccepted(deps, { budgetMs: BUDGET }), /store down/);
});

test('partitionOf matches the FNV-1a 32-bit reference vectors, so slot assignment is stable across releases', () => {
	assert.equal(partitionOf('a', 1000), 0xe40c292c % 1000);
	assert.equal(partitionOf('foobar', 1000), 0xbf9cf968 % 1000);
	assert.equal(partitionOf('', 1000), 0x811c9dc5 % 1000);
	assert.equal(partitionOf('shop.myshopify.com:wh-1', 7), partitionOf('shop.myshopify.com:wh-1', 7));
});

test('partitionOf assigns every id to exactly one slot, and every slot gets a share', () => {
	const slots = 4;
	const counts = Array.from({ length: slots }, () => 0);
	for (let i = 0; i < 4_000; i++) {
		const slot = partitionOf(`shop-${i % 13}.myshopify.com:${i}`, slots);
		assert.ok(Number.isInteger(slot) && slot >= 0 && slot < slots, `slot ${slot} out of range`);
		counts[slot] += 1;
	}
	for (const c of counts) assert.ok(c > 800, `skewed partition: ${counts.join(', ')}`);
});

test('partitionOf with one slot owns everything', () => {
	for (const id of ['', 'a', 'shop.myshopify.com:wh-9']) assert.equal(partitionOf(id, 1), 0);
});

test('partitionOf rejects a slot count that cannot partition', () => {
	for (const bad of [0, -1, 1.5, Number.NaN]) assert.throws(() => partitionOf('a', bad), RangeError);
});

test('drains for different slots take disjoint rows whose union is the whole backlog', async () => {
	const slots = 4;
	const { deps, state, handled } = memDeps(accepted(200));
	const bySlot: string[][] = [];
	for (let slot = 0; slot < slots; slot++) {
		const before = handled.length;
		await drainAccepted(deps, { budgetMs: BUDGET, batch: 50, partition: { slot, slots } });
		bySlot.push(handled.slice(before));
	}
	assert.equal(handled.length, 200, 'no row handled twice');
	assert.equal(new Set(handled).size, 200);
	assert.equal(statuses(state, 'processed'), 200, 'no row left behind');
	for (let slot = 0; slot < slots; slot++) {
		for (const id of bySlot[slot]) assert.equal(partitionOf(id, slots), slot);
	}
});

test('a slot with no rows of its own at the head of the backlog does not spin', async () => {
	const rows = accepted(200);
	const slots = 2;
	const foreign = rows.filter((r) => partitionOf(r.id, slots) === 1);
	const { deps, handled, listLimits } = memDeps(foreign);
	const r = await drainAccepted(deps, { budgetMs: BUDGET, batch: 50, partition: { slot: 0, slots } });
	assert.equal(r.stoppedBy, 'empty');
	assert.equal(handled.length, 0);
	assert.ok(listLimits.length <= Math.ceil(foreign.length / 50) + 1, `listed ${listLimits.length} times`);
});

function recorder() {
	const logs: Array<{ level: LogLevel; event: string; fields?: Record<string, unknown> }> = [];
	const counters: Array<{ name: string; by: number }> = [];
	return {
		logs,
		counters,
		log(level: LogLevel, event: string, fields?: Record<string, unknown>) {
			logs.push({ level, event, fields });
		},
		metrics: {
			inc(name: string, by = 1) {
				counters.push({ name, by });
			},
		},
	};
}

test('runProcessCycle counts each outcome and traces a drain that did work', async () => {
	const rec = recorder();
	const r = await runProcessCycle({
		drain: async (into) => {
			Object.assign(into, { processed: 7, failed: 2, deadLettered: 1, stoppedBy: 'budget' });
		},
		log: rec.log,
		metrics: rec.metrics,
	});
	const drained: DrainResult = { processed: 7, failed: 2, deadLettered: 1, stoppedBy: 'budget' };
	assert.deepEqual(r, drained);
	assert.deepEqual(rec.counters, [
		{ name: M.processProcessed, by: 7 },
		{ name: M.processFailed, by: 2 },
		{ name: M.processDeadLettered, by: 1 },
	]);
	assert.deepEqual(rec.logs, [{ level: 'trace', event: 'process.tick', fields: drained }]);
});

test('runProcessCycle stays silent on an idle occurrence', async () => {
	const rec = recorder();
	await runProcessCycle({ drain: async () => {}, log: rec.log, metrics: rec.metrics });
	assert.deepEqual(rec.logs, []);
});

test('runProcessCycle never lets a drain failure escape to the scheduler, and keeps the work done before it', async () => {
	const rec = recorder();
	const { deps } = memDeps(accepted(5), new Set(['d2']));
	deps.markFailed = async () => {
		throw new Error('table unavailable');
	};
	const r = await runProcessCycle({
		drain: (into) => drainAccepted(deps, { budgetMs: BUDGET }, into),
		log: rec.log,
		metrics: rec.metrics,
	});
	assert.deepEqual(r, { processed: 2, failed: 0, deadLettered: 0, stoppedBy: 'error' });
	assert.deepEqual(rec.counters, [
		{ name: M.processError, by: 1 },
		{ name: M.processProcessed, by: 2 },
		{ name: M.processFailed, by: 0 },
		{ name: M.processDeadLettered, by: 0 },
	]);
	assert.deepEqual(rec.logs, [
		{ level: 'error', event: 'process.error', fields: { message: 'table unavailable' } },
		{ level: 'trace', event: 'process.tick', fields: r },
	]);
});
