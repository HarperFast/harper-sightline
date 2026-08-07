import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTicker } from '../src/tick.ts';
import { ADMIN_TIMEOUT_MS, fetchOrdersUpdatedSince } from '../src/adminApi.ts';

// The failure this guards against: a background loop whose pass never settles
// leaves its "one at a time" flag set forever, so every later tick returns early
// and the loop is dead until the process restarts — silently, and looking exactly
// like "nothing to do".

const T0 = 1_786_000_000_000;
const STALL = 60_000;

function pending(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

test('only one pass runs at a time', async () => {
	const ticker = createTicker({ name: 'x', stallMs: STALL });
	const first = pending();
	let starts = 0;
	const work = () => {
		starts++;
		return first.promise;
	};

	assert.notEqual(ticker.run(work, T0), null, 'first pass starts');
	assert.equal(ticker.run(work, T0 + 1_000), null, 'second is skipped while the first is in flight');
	assert.equal(starts, 1);

	first.resolve();
	await Promise.resolve();
	await Promise.resolve();
	assert.notEqual(ticker.run(work, T0 + 2_000), null, 'and a new pass may start once it settles');
});

test('a hung pass does NOT wedge the loop forever', async () => {
	// The actual bug: without this, `reconciling` stayed true and reconciliation
	// was dead until restart.
	const stalls: Array<[string, number]> = [];
	const ticker = createTicker({ name: 'reconcile', stallMs: STALL, onStall: (n, age) => stalls.push([n, age]) });
	const hung = pending(); // never resolves

	assert.notEqual(
		ticker.run(() => hung.promise, T0),
		null,
	);
	assert.equal(
		ticker.run(() => hung.promise, T0 + STALL - 1),
		null,
		'still within budget — skip',
	);
	assert.notEqual(
		ticker.run(() => Promise.resolve(), T0 + STALL),
		null,
		'past the budget — run anyway',
	);
	assert.deepEqual(stalls, [['reconcile', STALL]], 'and the stall is reported, not silent');
});

test('a late-settling stalled pass cannot clear the flag of the pass that replaced it', async () => {
	// The subtle bug in any naive `finally { running = false }` retrofit: the old
	// promise finally-s AFTER the replacement started and clears its flag, letting
	// a third pass run concurrently.
	const ticker = createTicker({ name: 'x', stallMs: STALL });
	const stalled = pending();
	const replacement = pending();

	ticker.run(() => stalled.promise, T0);
	ticker.run(() => replacement.promise, T0 + STALL); // replaces the stalled one

	stalled.resolve(); // the old pass finally settles, late
	await Promise.resolve();
	await Promise.resolve();

	assert.equal(
		ticker.run(() => Promise.resolve(), T0 + STALL + 1),
		null,
		'the replacement still owns the slot',
	);
	assert.equal(ticker.isRunning(T0 + STALL + 1), true);
});

test('a rejected pass releases the slot', async () => {
	const ticker = createTicker({ name: 'x', stallMs: STALL });
	// Callers catch their own errors, but the guard must not leak if one escapes.
	const p = ticker.run(() => Promise.reject(new Error('boom')), T0);
	await assert.rejects(() => p as Promise<void>);
	assert.notEqual(
		ticker.run(() => Promise.resolve(), T0 + 1),
		null,
		'slot freed after a failure',
	);
});

test('isRunning reports a stalled pass as not running', async () => {
	const ticker = createTicker({ name: 'x', stallMs: STALL });
	ticker.run(() => pending().promise, T0);
	assert.equal(ticker.isRunning(T0 + STALL - 1), true);
	assert.equal(ticker.isRunning(T0 + STALL), false, 'past the budget it is presumed stuck, not running');
});

// ── the root cause: an unbounded external call ───────────────────────────────

test('every Admin API request carries an abort timeout', async () => {
	// Node's fetch has no default timeout; without this a hung connection is what
	// wedged the loop in the first place.
	let seenSignal: unknown;
	const fakeFetch = (async (_url: string, init: { signal?: unknown }) => {
		seenSignal = init?.signal;
		return new Response(JSON.stringify({ data: { orders: { edges: [], pageInfo: { hasNextPage: false } } } }), { status: 200 });
	}) as unknown as typeof fetch;

	await fetchOrdersUpdatedSince('s.myshopify.com', 'tok', 0, undefined, fakeFetch);
	assert.ok(seenSignal instanceof AbortSignal, 'an AbortSignal is passed to fetch');
	assert.ok(ADMIN_TIMEOUT_MS > 0 && ADMIN_TIMEOUT_MS <= 60_000, 'and the budget is bounded and sane');
});
