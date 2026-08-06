import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processAcceptedBatch, type ProcessDeps, type DeliveryRow } from '../src/processor.ts';
import { purgeExpired, cutoffMs, DAY_MS, type RetentionTarget } from '../src/retention.ts';
import { FakeTable } from './fakeTable.ts';
import { listEvents, getSummary } from '../src/queries.ts';
import { MAX_LIMIT } from '../src/apiContract.ts';

// Reliability & capacity tests (#24). These prove the correctness invariants at
// volume locally; the true production-like gates (10-min 100 rps burst, encrypted
// backup/restore) run against the staged environment (#25) — see
// docs/reliability-report.md. Timing assertions are deliberately generous: they
// catch pathological (e.g. O(n^2)) regressions without flaking in CI; the report
// records the actual measured numbers.

// A durable inbox that persists across simulated worker restarts. `handle`
// records an idempotent downstream effect keyed by delivery id, so a redelivered
// row (handled again after a crash between handle and markProcessed) is a no-op —
// exactly the real pipeline's at-least-once + deterministic-write guarantee.
function durableWorld(n: number) {
	const inbox = new Map<string, DeliveryRow>();
	for (let i = 0; i < n; i++) inbox.set(`d${i}`, { id: `d${i}`, shopId: 's', status: 'accepted' });
	// `writes` models the ledger: handle does a DETERMINISTIC keyed write (like
	// Events.put with a deterministic eventId), so a redelivered row overwrites the
	// same key and never produces a duplicate. `handleCalls` counts invocations, so
	// at-least-once delivery (handled >1×) and exactly-once effect (one key) are
	// measured separately.
	const writes = new Map<string, string>();
	let handleCalls = 0;
	const failOnceMarks = new Set<string>();

	const deps: ProcessDeps = {
		async listAccepted(limit) {
			return [...inbox.values()].filter((r) => r.status === 'accepted').slice(0, limit);
		},
		async markProcessed(id) {
			// Simulate a crash *between* handle and the durable status write: the
			// effect already happened, but the row stays 'accepted' and is redelivered.
			if (failOnceMarks.has(id)) {
				failOnceMarks.delete(id);
				throw new Error('simulated crash before markProcessed');
			}
			inbox.get(id)!.status = 'processed';
		},
		async markFailed(id, attempts, dead) {
			const r = inbox.get(id)!;
			r.attempts = attempts;
			r.status = dead ? 'dead_letter' : 'accepted';
		},
		async handle(row) {
			handleCalls += 1;
			writes.set(`ev:${row.id}`, row.id); // deterministic, idempotent
		},
	};
	return { inbox, writes, deps, failOnceMarks, handleCalls: () => handleCalls };
}

test('no accepted delivery is lost and processing catches up across a restart', async () => {
	const N = 500;
	const w = durableWorld(N);
	// First worker drains a few batches, then "crashes" (we simply stop looping —
	// the durable inbox keeps the remaining 'accepted' rows).
	for (let batch = 0; batch < 3; batch++) await processAcceptedBatch(w.deps, 50);
	const drainedByFirst = [...w.inbox.values()].filter((r) => r.status === 'processed').length;
	assert.ok(drainedByFirst > 0 && drainedByFirst < N, 'first worker made partial progress');

	// A fresh worker (restart) resumes from the durable inbox until it is empty.
	for (let guard = 0; guard < 100; guard++) {
		const r = await processAcceptedBatch(w.deps, 50);
		if (r.processed === 0) break;
	}

	const processed = [...w.inbox.values()].filter((r) => r.status === 'processed').length;
	assert.equal(processed, N, 'every delivery is eventually processed — none lost');
	assert.equal(w.writes.size, N, 'each delivery produced exactly one ledger write');
});

test('a crash between handle and the status write is recovered idempotently (at-least-once, exactly-once effect)', async () => {
	const w = durableWorld(10);
	w.failOnceMarks.add('d3'); // d3's markProcessed throws once → stays accepted → redelivered
	for (let guard = 0; guard < 20; guard++) {
		const r = await processAcceptedBatch(w.deps, 50);
		if (r.processed === 0 && [...w.inbox.values()].every((x) => x.status !== 'accepted')) break;
	}
	assert.equal([...w.inbox.values()].filter((r) => r.status === 'processed').length, 10, 'all recovered');
	assert.equal(w.writes.get('ev:d3'), 'd3', 'redelivered row applied its ledger write');
	assert.equal(w.writes.size, 10, 'exactly one write per delivery despite the redelivery (idempotent effect)');
	assert.ok(w.handleCalls() >= 11, 'the redelivered row was handled more than once (at-least-once delivery)');
});

test('high-volume 7-day query stays bounded and fast (single page never materializes the whole ledger)', async () => {
	const NOW = 1_700_000_000_000;
	const rows = Array.from({ length: 20_000 }, (_, i) => ({
		eventId: `s:e${i}`,
		shopId: 's',
		domain: 'order',
		topic: 'orders/paid',
		resourceId: `o${i}`,
		occurredAt: NOW - (i % 6) * DAY_MS - 1000, // all within the 7-day window
		receivedAt: NOW,
	}));
	const events = new FakeTable('eventId', rows);
	const started = Date.now();
	const page = await listEvents(events, 's', NOW, { limit: 9999 });
	const elapsed = Date.now() - started;
	assert.equal(page.items.length, MAX_LIMIT, 'a page is clamped — never returns all 20k rows');
	assert.ok(page.nextCursor, 'more pages available via cursor');
	assert.ok(elapsed < 3000, `single-page query should be fast (was ${elapsed}ms)`);
});

test('high-volume summary counts correctly over a large ledger', async () => {
	const NOW = 1_700_000_000_000;
	const events = new FakeTable(
		'eventId',
		Array.from({ length: 10_000 }, (_, i) => ({
			eventId: `s:e${i}`,
			shopId: 's',
			domain: 'order',
			occurredAt: NOW - 1000,
			receivedAt: NOW,
		})),
	);
	const projections = new FakeTable('id', []);
	const findings = new FakeTable('id', []);
	const deliveries = new FakeTable('id', []);
	const shops = new FakeTable('shopId', [{ shopId: 's', status: 'active', lastReconciledAt: NOW, reconciliationState: 'ready' }]);
	const started = Date.now();
	const summary = await getSummary({ events, projections, findings, deliveries, shops }, 's', NOW);
	assert.equal((summary.events as Record<string, number>).total, 10_000);
	assert.ok(Date.now() - started < 3000);
});

test('seven-day purge removes only expired rows at volume', async () => {
	const NOW = 1000 * DAY_MS;
	const cutoff = cutoffMs(NOW);
	// 8k expired stays under MAX_DELETES_PER_RUN (10k), so a single run fully drains.
	const expired = Array.from({ length: 8_000 }, (_, i) => ({ eventId: `x${i}`, shopId: 's', receivedAt: cutoff - DAY_MS }));
	const fresh = Array.from({ length: 5_000 }, (_, i) => ({ eventId: `f${i}`, shopId: 's', receivedAt: NOW - 1000 }));
	const events = new FakeTable('eventId', [...expired, ...fresh]);
	const targets: RetentionTarget[] = [{ name: 'OperationalEvent', keyField: 'eventId', tsField: 'receivedAt', table: events }];
	const result = await purgeExpired(targets, NOW);
	assert.equal(result.deleted, 8_000, 'all expired rows purged');
	assert.equal(result.residue, 0, 'no expired row left behind');
	assert.equal(events.rows.size, 5_000, 'exactly the fresh rows remain');
});
