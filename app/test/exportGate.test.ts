import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createExportGate, EXPORT_BUSY_RETRY_SECONDS, exportBusyResponse, runExclusive } from '../src/api/exportGate.ts';

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

// Each worker thread loads the module once, so two gates stand in for two workers.
test('the limit is per worker thread: an export on one worker does not hold another', () => {
	const workerA = createExportGate();
	const workerB = createExportGate();
	const release = workerA.tryAcquire();
	assert.ok(release);
	assert.equal(workerA.tryAcquire(), undefined, 'a second export on the same worker is refused');
	const releaseB = workerB.tryAcquire();
	assert.ok(releaseB, 'another worker takes its own');
	release();
	releaseB();
});

test('the export resource keeps its gate in module state, not in a store buffer shared across threads', () => {
	const source = readFileSync(new URL('../src/resources/exportResource.ts', import.meta.url), 'utf8');
	assert.doesNotMatch(source, /getUserSharedBuffer|sharedExportSlot|primaryStore/);
	assert.match(source, /const exportGate = createExportGate\(\);/);
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
