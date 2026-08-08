import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTable } from './fakeTable.ts';
import { runDigestBuild, scrubEmailShaped, scrubKnownAddress, type DigestBuildDeps } from '../src/digestBuild.ts';
import { periodStartFor } from '../src/digest.ts';
import { setLogSink } from '../src/observe.ts';
import type { DigestOutbox } from '../src/model.ts';

// The digest build loop's orchestration, deps-injected exactly like
// src/inventoryEnrich.ts / src/stateBackfill.ts — no Harper runtime needed. The
// pure decisions (shouldBuild, hasSomethingToSay, outboxRow) already have their
// own coverage in test/digest.test.ts; these tests pin the LOOP that wires them
// together against a table.

const DAY = 86_400_000;
// Wednesday 2026-08-05T14:30:00Z, matching test/digest.test.ts's NOW so the
// period arithmetic here is exercised the same way.
const NOW = Date.parse('2026-08-05T14:30:00Z');
const PERIOD_START = periodStartFor('daily', NOW);

function buildDeps(overrides: Partial<{ subscriptions: FakeTable; outboxes: FakeTable; findings: FakeTable }> = {}) {
	const subscriptions = overrides.subscriptions ?? new FakeTable('shopId', []);
	const outboxes = overrides.outboxes ?? new FakeTable('id', []);
	const findings = overrides.findings ?? new FakeTable('id', []);
	const deps: DigestBuildDeps = {
		subscriptions: subscriptions as unknown as DigestBuildDeps['subscriptions'],
		outboxes: outboxes as unknown as DigestBuildDeps['outboxes'],
		projections: new FakeTable('id', []) as unknown as DigestBuildDeps['projections'],
		findings: findings as unknown as DigestBuildDeps['findings'],
		events: new FakeTable('eventId', []) as unknown as DigestBuildDeps['events'],
		deliveries: new FakeTable('id', []) as unknown as DigestBuildDeps['deliveries'],
	};
	return { deps, subscriptions, outboxes, findings };
}

// An unconfirmed finding detected inside the period, so gatherDigestInput
// reports something actionable and hasSomethingToSay is true.
function unconfirmedFinding(shopId: string, orderId: string): Record<string, unknown> {
	return {
		id: `fulfillment_confirmation:${shopId}:${orderId}:1`,
		shopId,
		orderId,
		status: 'unconfirmed',
		detectedAt: PERIOD_START + DAY / 2,
	};
}

test('a subscription that should build, with something to report, does', async () => {
	const { deps, subscriptions, outboxes } = buildDeps({
		subscriptions: new FakeTable('shopId', [{ shopId: 's1', email: 'a@b.example', status: 'active' }]),
		findings: new FakeTable('id', [unconfirmedFinding('s1', 'o1')]),
	});
	const result = await runDigestBuild(NOW, deps);
	assert.equal(result.built, 1);
	assert.equal(result.skippedNotDue, 0);
	assert.equal(result.skippedQuiet, 0);
	const row = await outboxes.get(`s1:${PERIOD_START}`);
	assert.equal(row?.status, 'pending');
	assert.equal(row?.unconfirmed, 1);
	assert.equal((await subscriptions.get('s1'))?.lastBuiltAt, PERIOD_START);
});

// Edit that breaks this: dropping the `shouldBuild` gate (build unconditionally)
// in src/digestBuild.ts.
test('a subscription already built for this period is not rebuilt', async () => {
	const { deps, subscriptions, outboxes } = buildDeps({
		subscriptions: new FakeTable('shopId', [{ shopId: 's1', email: 'a@b.example', status: 'active', lastBuiltAt: PERIOD_START }]),
		findings: new FakeTable('id', [unconfirmedFinding('s1', 'o1')]),
	});
	const result = await runDigestBuild(NOW, deps);
	assert.equal(result.built, 0);
	assert.equal(result.skippedNotDue, 1);
	assert.equal(result.skippedQuiet, 0);
	assert.equal(await outboxes.get(`s1:${PERIOD_START}`), undefined);
	// Untouched — the loop never re-gathered this period, so there is nothing new
	// to stamp.
	assert.equal((await subscriptions.get('s1'))?.lastBuiltAt, PERIOD_START);
});

// Edit that breaks this: removing the `subscriptions.patch(...lastBuiltAt...)`
// call from the non-build (skippedQuiet) branch in src/digestBuild.ts — the
// period would then be re-gathered forever.
test('a quiet, healthy period writes no outbox row but still advances lastBuiltAt', async () => {
	const { deps, subscriptions, outboxes } = buildDeps({
		subscriptions: new FakeTable('shopId', [{ shopId: 's1', email: 'a@b.example', status: 'active' }]),
		// No findings, no delivery gaps, no dead letters: nothing to report.
	});
	const result = await runDigestBuild(NOW, deps);
	assert.equal(result.built, 0);
	assert.equal(result.skippedNotDue, 0);
	assert.equal(result.skippedQuiet, 1);
	assert.equal(await outboxes.get(`s1:${PERIOD_START}`), undefined);
	assert.equal((await subscriptions.get('s1'))?.lastBuiltAt, PERIOD_START);
});

// Edit that breaks this: dropping the `subscription.email` check from the build
// condition (or dropping it from `shouldBuild`) in src/digestBuild.ts / src/digest.ts.
test('a subscription with no address never builds', async () => {
	const { deps, subscriptions, outboxes } = buildDeps({
		subscriptions: new FakeTable('shopId', [{ shopId: 's1', status: 'active' }]),
		findings: new FakeTable('id', [unconfirmedFinding('s1', 'o1')]),
	});
	const result = await runDigestBuild(NOW, deps);
	assert.equal(result.built, 0);
	assert.equal(result.skippedNotDue, 1);
	assert.equal(await outboxes.get(`s1:${PERIOD_START}`), undefined);
	assert.equal((await subscriptions.get('s1'))?.lastBuiltAt, undefined);
});

// Edit that breaks this: changing outboxRow's id in src/digest.ts to include a
// non-deterministic component (e.g. `now`) instead of just shop+period — the
// second put would then land at a different key and the table would hold two
// rows for the same shop and period instead of one.
test('a rebuild of the same period upserts rather than duplicating', async () => {
	const { deps, subscriptions, outboxes, findings } = buildDeps({
		subscriptions: new FakeTable('shopId', [{ shopId: 's1', email: 'a@b.example', status: 'active' }]),
		findings: new FakeTable('id', [unconfirmedFinding('s1', 'o1')]),
	});
	const first = await runDigestBuild(NOW, deps);
	assert.equal(first.built, 1);
	assert.equal(outboxes.rows.size, 1);
	assert.equal((await outboxes.get(`s1:${PERIOD_START}`))?.unconfirmed, 1);

	// Simulate a second worker thread (or a manual rebuild) that reads the
	// subscription before the first tick's patch lands — the realistic race the
	// deterministic outbox id exists to make safe. A second, distinct finding
	// changes what this period has to report.
	await subscriptions.patch('s1', { lastBuiltAt: PERIOD_START - DAY });
	await findings.put(unconfirmedFinding('s1', 'o2'));

	const second = await runDigestBuild(NOW, deps);
	assert.equal(second.built, 1);
	// Still exactly one row for this shop and period — overwritten, not appended.
	assert.equal(outboxes.rows.size, 1);
	assert.equal((await outboxes.get(`s1:${PERIOD_START}`))?.unconfirmed, 2);
});

// Edit that breaks this: removing the try/catch around one subscription's work
// in src/digestBuild.ts — s1's thrown error would then propagate out of
// runDigestBuild entirely, and s2 (which sorts after s1 in the table's
// iteration order) would never be reached, let alone built.
test('a failure building one subscription does not starve subscriptions after it, and is counted', async () => {
	const outboxRows = new Map<string, DigestOutbox>();
	// A table that fails specifically on s1's write — the realistic shape of a
	// per-item failure (one bad row), not a table-wide outage (already covered
	// by test/retention.test.ts's "a failing table is captured" case, which is a
	// different failure mode: there, EVERY row's target is down; here, only one
	// subscription's happens to fail).
	// The thrown message deliberately echoes the address at risk — the exact
	// shape of failure this loop must survive without leaking it (e.g. a data
	// layer's write-conflict error quoting the offending row).
	const outboxes = {
		async put(row: DigestOutbox) {
			if (row.shopId === 's1') throw new Error(`write conflict for ${row.email}`);
			outboxRows.set(row.id, row);
		},
		async get(id: string) {
			return outboxRows.get(id);
		},
	};
	const { deps, subscriptions } = buildDeps({
		subscriptions: new FakeTable('shopId', [
			{ shopId: 's1', email: 'bad@b.example', status: 'active' },
			{ shopId: 's2', email: 'good@b.example', status: 'active' },
		]),
		findings: new FakeTable('id', [unconfirmedFinding('s1', 'o1'), unconfirmedFinding('s2', 'o2')]),
	});
	deps.outboxes = outboxes as unknown as DigestBuildDeps['outboxes'];

	const lines: string[] = [];
	setLogSink((_level, line) => lines.push(line));
	let result;
	try {
		result = await runDigestBuild(NOW, deps);
	} finally {
		setLogSink(null);
	}

	assert.equal(result.failed, 1);
	// s2 still built, despite sorting after the failing s1.
	assert.equal(result.built, 1);
	assert.equal(outboxRows.size, 1);
	assert.ok(outboxRows.has(`s2:${PERIOD_START}`));
	// s1 never reached its patch (the throw happened before it), so its period
	// is NOT marked built — it is retried, not silently skipped forever.
	assert.equal((await subscriptions.get('s1'))?.lastBuiltAt, undefined);
	assert.equal((await subscriptions.get('s2'))?.lastBuiltAt, PERIOD_START);

	// The failure IS logged (with the shop, for someone to act on) but the
	// address that leaked into the thrown message never reaches the log line.
	assert.equal(lines.length, 1);
	assert.match(lines[0], /"shopId":"s1"/);
	assert.doesNotMatch(lines[0], /bad@b\.example/);
});

// scrubKnownAddress: used where the address at risk is already in hand (the
// per-subscription catch above).
test('scrubKnownAddress removes exactly the given address, and leaves an address-free message untouched', () => {
	assert.equal(scrubKnownAddress('write conflict for bad@b.example', 'bad@b.example'), 'write conflict for [address]');
	// No address argument, or an address that never occurs: pass through
	// byte-for-byte — a scrubber that mangles an ordinary error is its own bug.
	assert.equal(scrubKnownAddress('table offline', undefined), 'table offline');
	assert.equal(scrubKnownAddress('table offline', 'bad@b.example'), 'table offline');
});

// scrubEmailShaped: used where the catch has no specific address in scope
// (jobs.ts's outer tick catch) and must scan for anything email-shaped instead.
test('scrubEmailShaped removes any email-shaped substring, and leaves an ordinary error unchanged', () => {
	assert.equal(scrubEmailShaped('write failed for ops@merchant.example during put'), 'write failed for [address] during put');
	assert.equal(scrubEmailShaped('ECONNRESET: socket hang up'), 'ECONNRESET: socket hang up');
});
