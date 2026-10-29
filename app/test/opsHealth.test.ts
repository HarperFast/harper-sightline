import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTable } from './fakeTable.ts';
import { computeOpsHealth, BACKLOG_STALE_MS, RECONCILE_STALE_MS, type OpsHealthDeps } from '../src/observability/opsHealth.ts';
import type { QueryTable } from '../src/api/queries.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { indexedColumns } from '../scripts/schemaColumns.mjs';

const NOW = 10_000_000_000;
const MIN = 60_000;

function deps(args: {
	deliveries?: Record<string, unknown>[];
	checkpoints?: Record<string, unknown>[];
	credentials?: Record<string, unknown>[];
}): OpsHealthDeps {
	return {
		deliveries: new FakeTable('id', args.deliveries ?? []) as unknown as QueryTable,
		checkpoints: new FakeTable('id', args.checkpoints ?? []) as unknown as QueryTable,
		credentials: new FakeTable('shopId', args.credentials ?? []) as unknown as QueryTable,
	};
}

test('healthy system: fresh backlog, fresh reconcile, no dead letters', async () => {
	const health = await computeOpsHealth(
		deps({
			deliveries: [
				{ id: 's:1', status: 'accepted', receivedAt: NOW - 1000 },
				{ id: 's:0', status: 'processed', receivedAt: NOW - 999_999 }, // ignored
			],
			checkpoints: [
				{ id: 'reconcile:s', updatedAt: NOW - MIN },
				{ id: 'other:worker', updatedAt: NOW - 100 * MIN }, // non-reconcile, ignored
			],
			credentials: [{ shopId: 's', status: 'active' }],
		}),
		NOW,
	);
	assert.equal(health.healthy, true);
	assert.equal(health.backlog.accepted, 1);
	assert.equal(health.backlog.oldestAgeMs, 1000);
	assert.equal(health.deadLetter.count, 0);
	assert.equal(health.reconciliation.shopsTracked, 1);
	assert.equal(health.reconciliation.staleShops, 0);
	assert.equal(health.reauthorization.shops, 0);
});

test('dead letters make the system unhealthy', async () => {
	const health = await computeOpsHealth(deps({ deliveries: [{ id: 's:d', status: 'dead_letter', receivedAt: NOW - MIN }] }), NOW);
	assert.equal(health.deadLetter.count, 1);
	assert.equal(health.healthy, false);
});

test('a stale backlog (oldest accepted beyond threshold) is unhealthy', async () => {
	const oldest = NOW - (BACKLOG_STALE_MS + MIN);
	const health = await computeOpsHealth(
		deps({
			deliveries: [
				{ id: 's:a', status: 'accepted', receivedAt: oldest },
				{ id: 's:b', status: 'accepted', receivedAt: NOW - 1000 },
			],
		}),
		NOW,
	);
	assert.equal(health.backlog.accepted, 2);
	assert.equal(health.backlog.oldestAgeMs, NOW - oldest); // age of the OLDEST
	assert.equal(health.healthy, false);
});

test('stale reconciliation checkpoint is unhealthy', async () => {
	const health = await computeOpsHealth(deps({ checkpoints: [{ id: 'reconcile:s', updatedAt: NOW - (RECONCILE_STALE_MS + MIN) }] }), NOW);
	assert.equal(health.reconciliation.staleShops, 1);
	assert.equal(health.healthy, false);
});

test('a reconcile checkpoint missing updatedAt counts as stale', async () => {
	const health = await computeOpsHealth(deps({ checkpoints: [{ id: 'reconcile:s' }] }), NOW);
	assert.equal(health.reconciliation.shopsTracked, 1);
	assert.equal(health.reconciliation.staleShops, 1);
	assert.equal(health.reconciliation.stalestAgeMs, null);
	assert.equal(health.healthy, false);
});

test('reauthorization is surfaced but does not by itself mark unhealthy', async () => {
	const health = await computeOpsHealth(
		deps({
			deliveries: [{ id: 's:1', status: 'accepted', receivedAt: NOW - 1000 }],
			checkpoints: [{ id: 'reconcile:s', updatedAt: NOW - MIN }],
			credentials: [
				{ shopId: 's', status: 'reauthorization_required' },
				{ shopId: 't', status: 'active' },
			],
		}),
		NOW,
	);
	assert.equal(health.reauthorization.shops, 1);
	assert.equal(health.healthy, true);
});

test('empty system is healthy with null ages', async () => {
	const health = await computeOpsHealth(deps({}), NOW);
	assert.equal(health.healthy, true);
	assert.equal(health.backlog.oldestAgeMs, null);
	assert.equal(health.reconciliation.stalestAgeMs, null);
});

// computeOpsHealth collected every accepted delivery whole, payload included, into
// one array: 60k rows of ~5 KB in the live check. Every search selects only the
// fields it reads.
test('ops health selects only the fields it reads, never a delivery payload', async () => {
	const specs: Array<{ table: string; select?: string[] }> = [];
	const spy = (name: string, table: FakeTable): QueryTable => ({
		search(spec) {
			specs.push({ table: name, select: spec.select });
			return table.search(spec as never);
		},
		get: (id) => table.get(id),
	});
	const health = await computeOpsHealth(
		{
			deliveries: spy(
				'deliveries',
				new FakeTable('id', [
					{ id: 's:1', status: 'accepted', receivedAt: NOW - 2000, payload: 'x'.repeat(5000) },
					{ id: 's:2', status: 'accepted', receivedAt: NOW - 1000, payload: 'x'.repeat(5000) },
					{ id: 's:3', status: 'dead_letter', receivedAt: NOW - 1000, payload: 'x'.repeat(5000) },
				]),
			),
			checkpoints: spy('checkpoints', new FakeTable('id', [{ id: 'reconcile:s', cursor: '1', updatedAt: NOW - MIN }])),
			credentials: spy(
				'credentials',
				new FakeTable('shopId', [{ shopId: 's', status: 'reauthorization_required', accessTokenEnc: 'enc' }]),
			),
		},
		NOW,
	);
	assert.equal(health.backlog.accepted, 2);
	assert.equal(health.backlog.oldestAgeMs, 2000);
	assert.equal(health.deadLetter.count, 1);
	assert.equal(health.reconciliation.staleShops, 0);
	assert.equal(health.reauthorization.shops, 1);
	assert.ok(specs.length >= 4);
	for (const s of specs) {
		assert.ok(s.select?.length, `a ${s.table} search loads whole rows`);
		assert.ok(!s.select.includes('payload') && !s.select.includes('accessTokenEnc'), `a ${s.table} search selects ${s.select.join(',')}`);
	}
});

// /ops and the minute heartbeat filter on these; unindexed, ShopCredential.status
// took 158 ms at 10k credential rows.
test('every attribute ops health filters on is @indexed', () => {
	const sdl = readFileSync(fileURLToPath(new URL('../schema.graphql', import.meta.url)), 'utf8');
	const indexed = new Set(indexedColumns(sdl).map(([, table, attribute]) => `${table}.${attribute}`));
	for (const column of ['WebhookDelivery.status', 'ShopCredential.status']) assert.ok(indexed.has(column), `${column} is not @indexed`);
});
