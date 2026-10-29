import { test } from 'node:test';
import assert from 'node:assert/strict';
import { purgeExpired, cutoffMs, DAY_MS, PURGE_BATCH, RETENTION_DAYS, type RetentionTarget } from '../src/retention/retention.ts';
import { FakeTable } from './fakeTable.ts';

const NOW = 1000 * DAY_MS; // fixed, arbitrary "now"
const CUTOFF = cutoffMs(NOW); // NOW - 7 days

// receivedAt values relative to the 7-day boundary.
const OLD = CUTOFF - DAY_MS; // 8 days old → purge
const EDGE = CUTOFF; // exactly at cutoff → kept (strict less-than)
const FRESH = NOW - DAY_MS; // 1 day old → keep

function buildTargets() {
	const deliveries = new FakeTable('id', [
		{ id: 'd-old1', shopId: 's', receivedAt: OLD },
		{ id: 'd-old2', shopId: 's', receivedAt: OLD },
		{ id: 'd-edge', shopId: 's', receivedAt: EDGE },
		{ id: 'd-fresh', shopId: 's', receivedAt: FRESH },
	]);
	const events = new FakeTable('eventId', [
		{ eventId: 'e-old', shopId: 's', receivedAt: OLD },
		{ eventId: 'e-fresh', shopId: 's', receivedAt: FRESH },
	]);
	const targets: RetentionTarget[] = [
		{ name: 'WebhookDelivery', keyField: 'id', tsField: 'receivedAt', table: deliveries },
		{ name: 'OperationalEvent', keyField: 'eventId', tsField: 'receivedAt', table: events },
	];
	return { targets, deliveries, events };
}

test('purges rows older than the window, keeps the boundary and fresh rows', async () => {
	const { targets, deliveries, events } = buildTargets();
	const result = await purgeExpired(targets, NOW);

	assert.equal(result.cutoff, CUTOFF);
	assert.equal(result.deleted, 3); // d-old1, d-old2, e-old
	assert.equal(result.residue, 0);
	assert.deepEqual(result.failures, []);
	assert.equal(result.byTable.WebhookDelivery.deleted, 2);
	assert.equal(result.byTable.OperationalEvent.deleted, 1);

	// Boundary (== cutoff) and fresh rows survive; expired ones are gone.
	assert.deepEqual([...deliveries.rows.keys()].sort(), ['d-edge', 'd-fresh']);
	assert.deepEqual([...events.rows.keys()], ['e-fresh']);
});

test('is idempotent — a second run deletes nothing', async () => {
	const { targets } = buildTargets();
	await purgeExpired(targets, NOW);
	const second = await purgeExpired(targets, NOW);
	assert.equal(second.deleted, 0);
	assert.equal(second.residue, 0);
	assert.deepEqual(second.failures, []);
});

test('respects a custom retention window', async () => {
	const { targets, deliveries } = buildTargets();
	// With a 0-day window, everything strictly before NOW is expired.
	const result = await purgeExpired(targets, NOW, 0);
	assert.equal(result.cutoff, NOW);
	// All four deliveries have receivedAt < NOW → all purged.
	assert.equal(deliveries.rows.size, 0);
	assert.ok(result.deleted >= 4);
});

test('a failing table is captured, others still purge', async () => {
	const good = new FakeTable('id', [{ id: 'g-old', shopId: 's', receivedAt: OLD }]);
	const bad = {
		// eslint-disable-next-line require-yield
		async *search(): AsyncIterable<Record<string, unknown>> {
			throw new Error('table offline');
		},
		async delete() {},
	};
	const targets: RetentionTarget[] = [
		{ name: 'Bad', keyField: 'id', tsField: 'receivedAt', table: bad },
		{ name: 'Good', keyField: 'id', tsField: 'receivedAt', table: good },
	];
	const result = await purgeExpired(targets, NOW);
	assert.equal(result.deleted, 1); // Good still purged
	assert.equal(good.rows.size, 0);
	assert.equal(result.failures.length, 1);
	assert.match(result.failures[0], /Bad: table offline/);
});

// Residue was a limit-1 re-query, so it read 1 per table whatever remained and the
// summed `purge.residue` counted tables. It counts the expired rows left.
test('residue counts the expired rows left behind, not the tables with any', async () => {
	const events = new FakeTable(
		'eventId',
		Array.from({ length: 5 }, (_, i) => ({ eventId: `e${i}`, shopId: 's', receivedAt: OLD })),
	);
	const stuck = new Set(['e0', 'e1', 'e2']);
	const table = {
		search: (q: Parameters<FakeTable['search']>[0]) => events.search(q),
		async delete(id: string) {
			if (stuck.has(id)) throw new Error('delete rejected');
			await events.delete(id);
		},
	};
	const result = await purgeExpired([{ name: 'OperationalEvent', keyField: 'eventId', tsField: 'receivedAt', table }], NOW);
	assert.equal(result.deleted, 2);
	assert.equal(result.byTable.OperationalEvent.residue, 3);
	assert.equal(result.residue, 3);
	assert.match(result.failures[0], /OperationalEvent: 3 expired rows remain/);
});

test('cutoffMs default window is seven days', () => {
	assert.equal(cutoffMs(NOW), NOW - RETENTION_DAYS * DAY_MS);
});

// The digest outbox keeps 30 days (OUTBOX_RETENTION_TARGETS in
// src/retention/ledgerTargets.ts, OUTBOX_RETENTION_DAYS above in this same file), not the
// ledger's 7 — purgeExpired's third parameter (retentionDays) is what lets one
// shared purge function serve both windows.
test('digest outbox rows are purged after thirty days, not seven', async () => {
	const outbox = new FakeTable('id', [
		{ id: 's1:old', shopId: 's1', periodStart: 1, status: 'pending', createdAt: NOW - 40 * DAY_MS },
		{ id: 's1:recent', shopId: 's1', periodStart: 2, status: 'pending', createdAt: NOW - 10 * DAY_MS },
	]);
	const result = await purgeExpired([{ name: 'DigestOutbox', keyField: 'id', tsField: 'createdAt', table: outbox }], NOW, 30);
	assert.equal(result.deleted, 1);
	assert.equal(await outbox.get('s1:old'), null);
	// Ten days old survives a 30-day retention but would NOT survive the ledger's 7.
	assert.notEqual(await outbox.get('s1:recent'), null);
});

test('EventSku rows are purged with their events', async () => {
	const eventSkus = new FakeTable('id', [
		{ id: 'old:A', shopId: 's1', eventId: 'old', sku: 'A', receivedAt: NOW - 8 * DAY_MS, occurredAt: NOW - 8 * DAY_MS },
		{ id: 'new:A', shopId: 's1', eventId: 'new', sku: 'A', receivedAt: NOW - 1 * DAY_MS, occurredAt: NOW - 1 * DAY_MS },
	]);
	const result = await purgeExpired([{ name: 'EventSku', keyField: 'id', tsField: 'receivedAt', table: eventSkus }], NOW);
	assert.equal(result.deleted, 1);
	assert.equal(result.residue, 0);
	assert.equal(await eventSkus.get('old:A'), null);
	assert.notEqual(await eventSkus.get('new:A'), null);
});

// A run used to stop at 10,000 deletes per table: live, 85k expired rows stayed
// behind while ingest outpaced it. It now deletes in batches until the table is clear.
test('one run clears a table far past 10,000 expired rows', async () => {
	const events = new FakeTable('eventId', [
		...Array.from({ length: 25_000 }, (_, i) => ({ eventId: `x${i}`, shopId: 's', receivedAt: OLD - i })),
		{ eventId: 'fresh', shopId: 's', receivedAt: FRESH },
	]);
	const result = await purgeExpired([{ name: 'OperationalEvent', keyField: 'eventId', tsField: 'receivedAt', table: events }], NOW);
	assert.equal(result.deleted, 25_000);
	assert.equal(result.residue, 0);
	assert.equal(result.byTable.OperationalEvent.capped, false);
	assert.deepEqual([...events.rows.keys()], ['fresh']);
});

test('a run stops at its time budget, gives every table a batch, and reports what is left', async () => {
	let clock = 0;
	// Each delete costs 1 ms of fake time.
	const ticking = (rows: Record<string, unknown>[]) => {
		const t = new FakeTable('id', rows);
		return {
			search: (q: Parameters<FakeTable['search']>[0]) => t.search(q),
			async delete(id: string) {
				clock += 1;
				await t.delete(id);
			},
		};
	};
	const expired = (prefix: string) => Array.from({ length: 2 * PURGE_BATCH }, (_, i) => ({ id: `${prefix}${i}`, receivedAt: OLD }));
	const targets: RetentionTarget[] = [
		{ name: 'A', keyField: 'id', tsField: 'receivedAt', table: ticking(expired('a')) },
		{ name: 'B', keyField: 'id', tsField: 'receivedAt', table: ticking(expired('b')) },
	];
	// Enough time for one batch of A; the run still ends B's turn before stopping.
	const result = await purgeExpired(targets, NOW, RETENTION_DAYS, { budgetMs: PURGE_BATCH + 1, clock: () => clock });
	assert.equal(result.byTable.A.deleted, PURGE_BATCH);
	assert.equal(result.byTable.B.deleted, PURGE_BATCH, 'the table after a slow one still gets its turn');
	assert.equal(result.residue, 2 * PURGE_BATCH);
	assert.equal(result.byTable.A.capped, true);
	assert.deepEqual(result.failures, [], 'running out of time is purge lag, not a failure');
});
