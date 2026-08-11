import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPurgeCycle, type PurgeCycleDeps } from '../src/retention/purgeCycle.ts';
import { M, type LogLevel } from '../src/observability/observe.ts';
import type { PurgeResult } from '../src/retention/retention.ts';

// The ledger purge (7-day, ADR-003) and the outbox purge (30-day digest
// retention, publicly disclosed in the privacy policy/data inventory/
// Notifications screen) run in separate try/catch blocks so a persistent
// failure in one can never silently disable the other. This is a pure wiring
// test: fake purge/outboxPurge functions plus recording log/metrics doubles,
// asserting on exactly what each sweep reported — not just the return value.

const NOW = 1_800_000_000_000;

function purgeResult(overrides: Partial<PurgeResult> = {}): PurgeResult {
	return { cutoff: NOW, deleted: 0, residue: 0, byTable: {}, failures: [], ...overrides };
}

function fakeLog() {
	const calls: Array<{ level: LogLevel; event: string; fields?: Record<string, unknown> }> = [];
	return {
		calls,
		log(level: LogLevel, event: string, fields?: Record<string, unknown>) {
			calls.push({ level, event, fields });
		},
	};
}

function fakeMetrics() {
	const calls: Array<{ name: string; by: number }> = [];
	return {
		calls,
		inc(name: string, by = 1) {
			calls.push({ name, by });
		},
	};
}

test('both sweeps succeed: each reports its own deleted count, in ledger-then-outbox order', async () => {
	const log = fakeLog();
	const metrics = fakeMetrics();
	const ledgerResult = purgeResult({ deleted: 3, byTable: { events: { deleted: 3, residue: 0, capped: false } } });
	const outboxResult = purgeResult({ deleted: 5 });
	const deps: PurgeCycleDeps = {
		purge: async (now) => {
			assert.equal(now, NOW, 'the ledger purge gets the injected `now`');
			return ledgerResult;
		},
		outboxPurge: async (now) => {
			assert.equal(now, NOW, 'the outbox purge gets the same injected `now`');
			return outboxResult;
		},
		log: log.log,
		metrics,
	};

	const result = await runPurgeCycle(deps, NOW);

	assert.equal(result.ledger, ledgerResult);
	assert.equal(result.outbox, outboxResult);
	assert.deepEqual(metrics.calls, [
		{ name: M.purgeDeleted, by: 3 },
		{ name: M.purgeDeleted, by: 5 },
	]);
	assert.deepEqual(
		log.calls.map((c) => c.event),
		['purge.tick', 'purge.outbox'],
		'ledger sweep logs and metrics land before the outbox sweep starts',
	);
});

test('a thrown ledger purge is logged, not propagated, and the outbox sweep still runs', async () => {
	const log = fakeLog();
	const metrics = fakeMetrics();
	const outboxResult = purgeResult({ deleted: 7 });
	let outboxCalled = false;
	const deps: PurgeCycleDeps = {
		purge: async () => {
			throw new Error('ledger table unavailable');
		},
		outboxPurge: async () => {
			outboxCalled = true;
			return outboxResult;
		},
		log: log.log,
		metrics,
	};

	// Must not throw: the error is caught and logged inside runPurgeCycle.
	const result = await runPurgeCycle(deps, NOW);

	assert.equal(outboxCalled, true, 'the outbox sweep ran despite the ledger purge throwing');
	assert.equal(result.ledger, undefined, 'no result from a sweep that threw');
	assert.equal(result.outbox, outboxResult, 'the outbox result is unaffected');

	const errorLog = log.calls.find((c) => c.event === 'purge.error');
	assert.ok(errorLog, 'the thrown error is logged');
	assert.equal(errorLog?.level, 'error');
	assert.equal(errorLog?.fields?.message, 'ledger table unavailable');

	assert.deepEqual(
		metrics.calls.filter((c) => c.name === M.purgeError),
		[{ name: M.purgeError, by: 1 }],
		'the ledger failure increments purge.error exactly once',
	);
	assert.deepEqual(
		metrics.calls.filter((c) => c.name === M.purgeDeleted),
		[{ name: M.purgeDeleted, by: 7 }],
		'the outbox sweep still reports its own deleted count',
	);
	assert.ok(
		log.calls.some((c) => c.event === 'purge.outbox' && c.fields?.deleted === 7),
		'the outbox sweep still logs its own tick',
	);
});

test("a thrown outbox purge is logged, not propagated, and the ledger sweep's result is unaffected", async () => {
	const log = fakeLog();
	const metrics = fakeMetrics();
	const ledgerResult = purgeResult({ deleted: 4 });
	const deps: PurgeCycleDeps = {
		purge: async () => ledgerResult,
		outboxPurge: async () => {
			throw new Error('outbox table unavailable');
		},
		log: log.log,
		metrics,
	};

	const result = await runPurgeCycle(deps, NOW);

	assert.equal(result.ledger, ledgerResult, 'the ledger result is exactly what its own purge returned');
	assert.equal(result.outbox, undefined, 'no result from the sweep that threw');

	const errorLog = log.calls.find((c) => c.event === 'purge.outbox.error');
	assert.ok(errorLog, 'the thrown error is logged under its own event name');
	assert.equal(errorLog?.level, 'error');
	assert.equal(errorLog?.fields?.message, 'outbox table unavailable');

	assert.deepEqual(
		metrics.calls.filter((c) => c.name === M.purgeError),
		[{ name: M.purgeError, by: 1 }],
		'the outbox failure increments purge.error exactly once',
	);
	assert.deepEqual(
		metrics.calls.filter((c) => c.name === M.purgeDeleted),
		[{ name: M.purgeDeleted, by: 4 }],
		"the ledger sweep's own metrics are untouched by the outbox sweep throwing",
	);
});

test('residue after either sweep is logged as a warning, under sweep-specific event names', async () => {
	const log = fakeLog();
	const metrics = fakeMetrics();
	const deps: PurgeCycleDeps = {
		purge: async () => purgeResult({ deleted: 1, residue: 2 }),
		outboxPurge: async () => purgeResult({ deleted: 1, residue: 9 }),
		log: log.log,
		metrics,
	};

	await runPurgeCycle(deps, NOW);

	const ledgerResidue = log.calls.find((c) => c.event === 'purge.residue');
	assert.ok(ledgerResidue, 'ledger residue is logged');
	assert.equal(ledgerResidue?.level, 'warn');
	assert.equal(ledgerResidue?.fields?.residue, 2);

	const outboxResidue = log.calls.find((c) => c.event === 'purge.outbox.residue');
	assert.ok(outboxResidue, 'outbox residue is logged under its own event name');
	assert.equal(outboxResidue?.level, 'warn');
	assert.equal(outboxResidue?.fields?.residue, 9);
});

test('per-table failures from either sweep increment purge.failure and are logged', async () => {
	const log = fakeLog();
	const metrics = fakeMetrics();
	const deps: PurgeCycleDeps = {
		purge: async () => purgeResult({ failures: ['events: 1 expired row remains'] }),
		outboxPurge: async () => purgeResult({ failures: ['outboxes: boom', 'more: boom'] }),
		log: log.log,
		metrics,
	};

	await runPurgeCycle(deps, NOW);

	assert.deepEqual(
		metrics.calls.filter((c) => c.name === M.purgeFailure),
		[
			{ name: M.purgeFailure, by: 1 },
			{ name: M.purgeFailure, by: 2 },
		],
		'each sweep increments purge.failure by its own failure count',
	);

	const ledgerFailures = log.calls.find((c) => c.event === 'purge.failures');
	assert.deepEqual(ledgerFailures?.fields?.failures, ['events: 1 expired row remains']);

	const outboxFailures = log.calls.find((c) => c.event === 'purge.outbox.failures');
	assert.deepEqual(outboxFailures?.fields?.failures, ['outboxes: boom', 'more: boom']);
});

test('a quiet run (nothing deleted, no residue, no failures) logs nothing for either sweep', async () => {
	const log = fakeLog();
	const metrics = fakeMetrics();
	const deps: PurgeCycleDeps = {
		purge: async () => purgeResult(),
		outboxPurge: async () => purgeResult(),
		log: log.log,
		metrics,
	};

	await runPurgeCycle(deps, NOW);

	assert.deepEqual(log.calls, [], 'nothing worth alerting on happened, so nothing was logged');
	assert.deepEqual(metrics.calls, [
		{ name: M.purgeDeleted, by: 0 },
		{ name: M.purgeDeleted, by: 0 },
	]);
});
