import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExportGate, EXPORT_BUSY_RETRY_SECONDS, exportBusyResponse, runExclusive, sharedExportSlot } from '../src/api/exportGate.ts';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const busy = () => 'busy';
const fails = (message: string) => async (): Promise<string> => {
	throw new Error(message);
};

test('one export at a time: a second concurrent export is refused, not queued', async () => {
	const gate = createExportGate();
	const first = deferred<string>();
	const running = runExclusive(gate, () => first.promise, busy);
	assert.equal(await runExclusive(gate, async () => 'second', busy), 'busy');
	first.resolve('first');
	assert.equal(await running, 'first');
	assert.equal(await runExclusive(gate, async () => 'third', busy), 'third', 'free again once the first finished');
});

// The slot must come back however the export ends, or one failed export would refuse
// every export on the thread until a restart.
test('a failed export releases the slot', async () => {
	const gate = createExportGate();
	await assert.rejects(runExclusive(gate, fails('query failed'), busy), /query failed/);
	assert.equal(gate.busy(), false);
	const syncThrow = (): Promise<string> => {
		throw new Error('sync throw');
	};
	await assert.rejects(runExclusive(gate, syncThrow, busy), /sync throw/);
	assert.equal(gate.busy(), false);
	assert.equal(await runExclusive(gate, async () => 'next', busy), 'next');
});

test('a refused export does not release the slot it never held', async () => {
	const gate = createExportGate();
	const first = deferred<string>();
	const running = runExclusive(gate, () => first.promise, busy);
	await runExclusive(gate, async () => 'x', busy);
	assert.equal(gate.busy(), true, 'the running export still holds it');
	first.resolve('done');
	await running;
	assert.equal(gate.busy(), false);
});

test('release is idempotent: a stale release cannot free a later holder', () => {
	const gate = createExportGate();
	const release = gate.tryAcquire();
	assert.ok(release);
	release();
	const second = gate.tryAcquire();
	assert.ok(second);
	release();
	assert.equal(gate.busy(), true, 'the first holder released twice; the second still holds the slot');
	second();
	assert.equal(gate.busy(), false);
});

// Two gates over one shared slot stand in for two worker threads of a node.
test('the limit is per node: a gate on another thread sharing the slot is refused', () => {
	const slot = new BigInt64Array(new SharedArrayBuffer(8));
	const threadA = createExportGate({ slot });
	const threadB = createExportGate({ slot });
	const release = threadA.tryAcquire();
	assert.ok(release);
	assert.equal(threadB.tryAcquire(), undefined, 'thread B sees thread A’s export');
	assert.equal(threadB.busy(), true);
	release();
	const releaseB = threadB.tryAcquire();
	assert.ok(releaseB, 'free for any thread once released');
	releaseB();
});

// A thread that dies mid-export never runs its finally; the lease is what frees the slot.
test('a lease never released expires, and its late release cannot free the next holder', () => {
	const slot = new BigInt64Array(new SharedArrayBuffer(8));
	let clock = 1_760_000_000_000;
	const gate = createExportGate({ slot, now: () => clock, leaseMs: 120_000 });
	const abandoned = gate.tryAcquire();
	assert.ok(abandoned);
	clock += 119_999;
	assert.equal(gate.tryAcquire(), undefined, 'still held inside the lease');
	clock += 1;
	const next = gate.tryAcquire();
	assert.ok(next, 'taken over once the lease expired');
	abandoned();
	assert.equal(gate.busy(), true, 'the expired holder’s release left the new lease alone');
	next();
	assert.equal(gate.busy(), false);
});

test('sharedExportSlot uses the store’s cross-thread buffer, and falls back per thread without one', () => {
	const buffers = new Map<string, ArrayBuffer>();
	const store = {
		getUserSharedBuffer(key: string, defaultBuffer: ArrayBuffer) {
			if (!buffers.has(key)) buffers.set(key, defaultBuffer);
			return buffers.get(key)!;
		},
	};
	const a = sharedExportSlot(store);
	const b = sharedExportSlot(store);
	assert.equal(a.shared, true);
	assert.equal(a.slot.buffer, b.slot.buffer, 'every caller gets the one registered buffer');
	const release = createExportGate({ slot: a.slot }).tryAcquire();
	assert.equal(createExportGate({ slot: b.slot }).tryAcquire(), undefined);
	release?.();

	const fallback = sharedExportSlot(undefined);
	assert.equal(fallback.shared, false);
	assert.ok(createExportGate({ slot: fallback.slot }).tryAcquire(), 'a usable slot, not an error');
	assert.equal(sharedExportSlot({}).shared, false);
});

test('the busy refusal is a 429 with Retry-After and a detail the SPA can read', async () => {
	const res = exportBusyResponse();
	assert.equal(res.status, 429);
	assert.equal(res.headers.get('retry-after'), String(EXPORT_BUSY_RETRY_SECONDS));
	assert.ok(EXPORT_BUSY_RETRY_SECONDS >= 1 && EXPORT_BUSY_RETRY_SECONDS <= 10, 'a few seconds');
	const body = await res.json();
	assert.equal(typeof body, 'string', 'a bare JSON string, the shape errorDetail reads for our own errors');
	assert.match(body, /another export is in progress/);
	assert.match(body, new RegExp(`retry in ${EXPORT_BUSY_RETRY_SECONDS}s`));
});
