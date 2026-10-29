import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTable } from './fakeTable.ts';
import { runDigestBuild, scrubEmailShaped, scrubKnownAddress, type DigestBuildDeps } from '../src/digest/digestBuild.ts';
import { periodStartFor } from '../src/digest/digest.ts';
import { setLogSink } from '../src/observability/observe.ts';
import type { DigestOutbox } from '../src/domain/model.ts';

// The digest build loop's orchestration, deps-injected exactly like
// src/ingest/inventoryEnrich.ts / src/jobs/stateBackfill.ts — no Harper runtime needed. The
// pure decisions (shouldBuild, hasSomethingToSay, outboxRow) already have their
// own coverage in test/digest.test.ts; these tests pin the LOOP that wires them
// together against a table.

const DAY = 86_400_000;
// Wednesday 2026-08-05T14:30:00Z, matching test/digest.test.ts's NOW so the
// period arithmetic here is exercised the same way.
const NOW = Date.parse('2026-08-05T14:30:00Z');
const PERIOD_START = periodStartFor('daily', NOW);

function buildDeps(
	overrides: Partial<{ subscriptions: FakeTable; outboxes: FakeTable; findings: FakeTable; projections: FakeTable }> = {},
) {
	const subscriptions = overrides.subscriptions ?? new FakeTable('shopId', []);
	const outboxes = overrides.outboxes ?? new FakeTable('id', []);
	const findings = overrides.findings ?? new FakeTable('id', []);
	const projections = overrides.projections ?? new FakeTable('id', []);
	const deps: DigestBuildDeps = {
		subscriptions: subscriptions as unknown as DigestBuildDeps['subscriptions'],
		outboxes: outboxes as unknown as DigestBuildDeps['outboxes'],
		projections: projections as unknown as DigestBuildDeps['projections'],
		findings: findings as unknown as DigestBuildDeps['findings'],
		events: new FakeTable('eventId', []) as unknown as DigestBuildDeps['events'],
		deliveries: new FakeTable('id', []) as unknown as DigestBuildDeps['deliveries'],
	};
	return { deps, subscriptions, outboxes, findings, projections };
}

// An unconfirmed finding detected inside the period, and the awaiting order it is
// ABOUT. The two go together: a `fulfillment_confirmation` finding for an order
// with no projection is a self-contradictory fixture, and it stopped being an
// invisible one when the digest's headline count moved off findings and onto
// isAwaitingConfirmation (src/domain/orders.ts) — which is the population these tests
// need non-empty for hasSomethingToSay to be true.
function unconfirmedFinding(shopId: string, orderId: string): Record<string, unknown> {
	return {
		id: `fulfillment_confirmation:${shopId}:${orderId}:1`,
		shopId,
		orderId,
		status: 'unconfirmed',
		detectedAt: PERIOD_START + DAY / 2,
	};
}

// Paid, needs shipping, no fulfillment observed, not called off — awaiting, by
// src/domain/orders.ts's single definition. Paid four days before NOW, so it is past the
// 72-hour deadline the finding above represents.
function awaitingOrder(shopId: string, orderId: string): Record<string, unknown> {
	return {
		id: `${shopId}:${orderId}`,
		shopId,
		orderId,
		orderName: `#${orderId}`,
		paidAt: NOW - 4 * DAY,
		requiresFulfillment: true,
		lastEventAt: NOW - 4 * DAY,
	};
}

test('a subscription that should build, with something to report, does', async () => {
	const { deps, subscriptions, outboxes } = buildDeps({
		subscriptions: new FakeTable('shopId', [{ shopId: 's1', email: 'a@b.example', status: 'active' }]),
		findings: new FakeTable('id', [unconfirmedFinding('s1', 'o1')]),
		projections: new FakeTable('id', [awaitingOrder('s1', 'o1')]),
	});
	const result = await runDigestBuild(NOW, deps);
	assert.equal(result.built, 1);
	assert.equal(result.skippedNotDue, 0);
	assert.equal(result.skippedQuiet, 0);
	const row = await outboxes.get(`s1:${PERIOD_START}`);
	assert.equal(row?.status, 'pending');
	assert.equal(row?.ordersAwaiting, 1);
	assert.equal((await subscriptions.get('s1'))?.lastBuiltAt, PERIOD_START);
});

// Edit that breaks this: dropping the `shouldBuild` gate (build unconditionally)
// in src/digest/digestBuild.ts.
test('a subscription already built for this period is not rebuilt', async () => {
	const { deps, subscriptions, outboxes } = buildDeps({
		subscriptions: new FakeTable('shopId', [{ shopId: 's1', email: 'a@b.example', status: 'active', lastBuiltAt: PERIOD_START }]),
		findings: new FakeTable('id', [unconfirmedFinding('s1', 'o1')]),
		projections: new FakeTable('id', [awaitingOrder('s1', 'o1')]),
	});
	const result = await runDigestBuild(NOW, deps);
	assert.equal(result.built, 0);
	assert.equal(result.skippedNotDue, 1);
	assert.equal(result.skippedQuiet, 0);
	assert.equal(await outboxes.get(`s1:${PERIOD_START}`), null);
	// Untouched — the loop never re-gathered this period, so there is nothing new
	// to stamp.
	assert.equal((await subscriptions.get('s1'))?.lastBuiltAt, PERIOD_START);
});

// Edit that breaks this: removing the `subscriptions.patch(...lastBuiltAt...)`
// call from the non-build (skippedQuiet) branch in src/digest/digestBuild.ts — the
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
	assert.equal(await outboxes.get(`s1:${PERIOD_START}`), null);
	assert.equal((await subscriptions.get('s1'))?.lastBuiltAt, PERIOD_START);
});

// Edit that breaks this: dropping the `subscription.email` check from the build
// condition (or dropping it from `shouldBuild`) in src/digest/digestBuild.ts / src/digest/digest.ts.
test('a subscription with no address never builds', async () => {
	const { deps, subscriptions, outboxes } = buildDeps({
		subscriptions: new FakeTable('shopId', [{ shopId: 's1', status: 'active' }]),
		findings: new FakeTable('id', [unconfirmedFinding('s1', 'o1')]),
		projections: new FakeTable('id', [awaitingOrder('s1', 'o1')]),
	});
	const result = await runDigestBuild(NOW, deps);
	assert.equal(result.built, 0);
	assert.equal(result.skippedNotDue, 1);
	assert.equal(await outboxes.get(`s1:${PERIOD_START}`), null);
	assert.equal((await subscriptions.get('s1'))?.lastBuiltAt, undefined);
});

// Edit that breaks this: changing outboxRow's id in src/digest/digest.ts to include a
// non-deterministic component (e.g. `now`) instead of just shop+period — the
// second put would then land at a different key and the table would hold two
// rows for the same shop and period instead of one.
test('a rebuild of the same period upserts rather than duplicating', async () => {
	const { deps, subscriptions, outboxes, findings, projections } = buildDeps({
		subscriptions: new FakeTable('shopId', [{ shopId: 's1', email: 'a@b.example', status: 'active' }]),
		findings: new FakeTable('id', [unconfirmedFinding('s1', 'o1')]),
		projections: new FakeTable('id', [awaitingOrder('s1', 'o1')]),
	});
	const first = await runDigestBuild(NOW, deps);
	assert.equal(first.built, 1);
	assert.equal(outboxes.rows.size, 1);
	assert.equal((await outboxes.get(`s1:${PERIOD_START}`))?.ordersAwaiting, 1);

	// Simulate a second worker thread (or a manual rebuild) that reads the
	// subscription before the first tick's patch lands — the realistic race the
	// deterministic outbox id exists to make safe. A second awaiting order (with its
	// own finding) changes what this period has to report, so the overwrite is
	// observable: ordersAwaiting counts ORDERS awaiting, so a second finding on its own
	// would leave the number at 1 and prove nothing about the upsert.
	await subscriptions.patch('s1', { lastBuiltAt: PERIOD_START - DAY });
	await findings.put(unconfirmedFinding('s1', 'o2'));
	await projections.put(awaitingOrder('s1', 'o2'));

	const second = await runDigestBuild(NOW, deps);
	assert.equal(second.built, 1);
	// Still exactly one row for this shop and period — overwritten, not appended.
	assert.equal(outboxes.rows.size, 1);
	assert.equal((await outboxes.get(`s1:${PERIOD_START}`))?.ordersAwaiting, 2);
});

// Edit that breaks this: removing the try/catch around one subscription's work
// in src/digest/digestBuild.ts — s1's thrown error would then propagate out of
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
	// layer's write-conflict error quoting the offending row). The address is
	// written literally rather than read off `row`, because a DigestOutbox row no
	// longer HAS an email column; the live leak path is now a layer that quotes
	// the subscription row (which does hold the address) or any other
	// address-bearing message thrown inside the per-subscription try block. Either
	// way the catch must scrub it, which is what the log assertions below prove.
	const outboxes = {
		async put(row: DigestOutbox) {
			if (row.shopId === 's1') throw new Error('write conflict for bad@b.example');
			outboxRows.set(row.id, row);
		},
		async get(id: string) {
			return outboxRows.get(id) ?? null;
		},
	};
	const { deps, subscriptions } = buildDeps({
		subscriptions: new FakeTable('shopId', [
			{ shopId: 's1', email: 'bad@b.example', status: 'active' },
			{ shopId: 's2', email: 'good@b.example', status: 'active' },
		]),
		findings: new FakeTable('id', [unconfirmedFinding('s1', 'o1'), unconfirmedFinding('s2', 'o2')]),
		projections: new FakeTable('id', [awaitingOrder('s1', 'o1'), awaitingOrder('s2', 'o2')]),
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

// Edit that breaks this: dropping the 'i' flag (or reverting to the plain
// split/join) in scrubKnownAddress. Not exploitable today — normalizeEmail
// lowercases on write — but the scrubber must not depend on an invariant
// enforced three modules away in src/digest/digestSubscription.ts.
test('scrubKnownAddress matches the address regardless of case', () => {
	assert.equal(scrubKnownAddress('write conflict for Ops@Merchant.Example', 'ops@merchant.example'), 'write conflict for [address]');
});

// Edit that breaks this: escapeRegExp's replace stripping the backslash-escape
// (e.g. reverting to new RegExp(address, 'gi') with no escaping) — a `+` or
// `.` in the address would then be interpreted as a regex quantifier/wildcard
// rather than a literal character, silently under- or over-matching.
test('scrubKnownAddress treats a `+`-tagged address as a literal string, not a regex pattern', () => {
	const address = 'ops+billing@merchant.example';
	assert.equal(scrubKnownAddress(`write conflict for ${address}`, address), 'write conflict for [address]');
	// If '+' were a live regex quantifier, 'opsbilling@merchant.example' (no
	// '+') would ALSO match (one-or-more of the preceding char, here zero 's'
	// characters) — it must not.
	assert.equal(
		scrubKnownAddress('write conflict for opsbilling@merchant.example', address),
		'write conflict for opsbilling@merchant.example',
	);
});

// scrubEmailShaped: used where the catch has no specific address in scope
// (jobs.ts's outer tick catch) and must scan for anything email-shaped instead.
test('scrubEmailShaped removes any email-shaped substring, and leaves an ordinary error unchanged', () => {
	assert.equal(scrubEmailShaped('write failed for ops@merchant.example during put'), 'write failed for [address] during put');
	assert.equal(scrubEmailShaped('ECONNRESET: socket hang up'), 'ECONNRESET: socket hang up');
});

// Edit that breaks this: dropping the `/` exclusion from EMAIL_SHAPED (back to
// /[^\s@]+@[^\s@]+\.[^\s@]+/g) — a module path containing an `@scope` segment
// would then be mistaken for an address and mangled. This is not hypothetical:
// this app hits ERR_MODULE_NOT_FOUND constantly, since `harper` has no file on
// disk outside the deployed runtime, and that error text is exactly this shape.
test('scrubEmailShaped leaves a module path with an @scope segment unchanged, but still scrubs a genuine address in a similar sentence', () => {
	assert.equal(
		scrubEmailShaped('Cannot find module node_modules/@scope/pkg/index.js'),
		'Cannot find module node_modules/@scope/pkg/index.js',
	);
	// Same shape of sentence ("Cannot find module ..."), but a real address this
	// time — reducing false positives on paths must not turn into a blanket
	// exemption that also misses genuine addresses.
	assert.equal(scrubEmailShaped('Cannot find module for ops@merchant.example'), 'Cannot find module for [address]');
});
