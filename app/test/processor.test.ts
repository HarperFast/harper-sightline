import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processAcceptedBatch, type ProcessDeps, type DeliveryRow } from '../src/processor.ts';

function memDeps(rows: DeliveryRow[], failIds = new Set<string>()) {
	const state = new Map(rows.map((r) => [r.id, { ...r }]));
	const handled: string[] = [];
	const deps: ProcessDeps = {
		async listAccepted(limit) {
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
	return { deps, state, handled };
}

test('processes accepted rows exactly once, then re-run is a no-op', async () => {
	const { deps, state, handled } = memDeps([
		{ id: 'a', shopId: 's', status: 'accepted' },
		{ id: 'b', shopId: 's', status: 'accepted' },
	]);
	const r = await processAcceptedBatch(deps);
	assert.equal(r.processed, 2);
	assert.equal(state.get('a')!.status, 'processed');
	assert.deepEqual(handled.sort(), ['a', 'b']);
	assert.equal((await processAcceptedBatch(deps)).processed, 0);
});

test('retries then dead-letters after MAX_ATTEMPTS', async () => {
	const { deps, state } = memDeps([{ id: 'x', shopId: 's', status: 'accepted', attempts: 4 }], new Set(['x']));
	const r = await processAcceptedBatch(deps);
	assert.equal(r.failed, 1);
	assert.equal(r.deadLettered, 1);
	assert.equal(state.get('x')!.status, 'dead_letter');
	assert.equal(state.get('x')!.attempts, 5);
});

test('a transient failure stays accepted for retry', async () => {
	const { deps, state } = memDeps([{ id: 'y', shopId: 's', status: 'accepted', attempts: 0 }], new Set(['y']));
	const r = await processAcceptedBatch(deps);
	assert.equal(r.deadLettered, 0);
	assert.equal(state.get('y')!.status, 'accepted');
	assert.equal(state.get('y')!.attempts, 1);
});
