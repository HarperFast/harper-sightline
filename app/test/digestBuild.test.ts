import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTable } from './fakeTable.ts';
import { runDigestBuild, type DigestBuildDeps } from '../src/digestBuild.ts';
import { periodStartFor } from '../src/digest.ts';

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
