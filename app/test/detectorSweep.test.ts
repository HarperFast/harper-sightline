import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTable } from './fakeTable.ts';
import { runDetectorSweep, DETECTOR_SWEEP_PAGE, type DetectorSweepDeps } from '../src/jobs/detectorSweep.ts';

const NOW = 1_000_000_000_000;

function expectation(n: number, deadline: number | undefined, state = 'pending'): Record<string, unknown> {
	return { id: `d:o${n}:1`, shopId: 's1', orderId: `o${n}`, detector: 'd', state, deadline };
}

// Counts the rows the table actually hands out and records every query, so the
// bound is asserted on what was read rather than on what was returned.
function instrument(table: FakeTable) {
	const queries: Array<Record<string, unknown>> = [];
	let materialised = 0;
	const expectations: DetectorSweepDeps['expectations'] = {
		async *search(query) {
			queries.push(query as unknown as Record<string, unknown>);
			for await (const row of table.search(query as never)) {
				materialised += 1;
				yield row;
			}
		},
		get: (id) => table.get(id),
	};
	return { expectations, queries, materialised: () => materialised };
}

test('only due pending expectations are read, and unexpired rows are never materialised', async () => {
	const rows: Array<Record<string, unknown>> = [];
	for (let i = 0; i < 1000; i++) rows.push(expectation(i, NOW + 60_000 + i));
	rows.push(expectation(2000, NOW - 5), expectation(2001, NOW - 1), expectation(2002, undefined), expectation(2003, NOW - 9, 'resolved'));
	const table = new FakeTable('id', rows);
	const probe = instrument(table);
	const evaluated: string[] = [];
	const due = await runDetectorSweep(
		{
			expectations: probe.expectations,
			async evaluate(shopId, orderId) {
				evaluated.push(`${shopId}:${orderId}`);
				await table.patch(`d:${orderId}:1`, { state: 'expired' });
			},
		},
		NOW,
	);
	assert.equal(due, 2);
	assert.deepEqual(evaluated, ['s1:o2000', 's1:o2001'], 'oldest deadline first');
	assert.equal(probe.materialised(), 2, 'the 1000 future-dated rows were never read');
	for (const q of probe.queries) {
		assert.equal(q.limit, DETECTOR_SWEEP_PAGE, 'every read is bounded');
		const comparators = (q.conditions as Array<{ attribute: string; comparator?: string }>).map(
			(c) => `${c.attribute}:${c.comparator ?? 'equals'}`,
		);
		assert.deepEqual(comparators, ['state:equals', 'deadline:less_than_equal']);
	}
});

test('a large due backlog is processed in bounded pages without buffering it', async () => {
	const total = DETECTOR_SWEEP_PAGE * 2 + 17;
	const table = new FakeTable(
		'id',
		Array.from({ length: total }, (_unused, i) => expectation(i, NOW - 1000 + i)),
	);
	const probe = instrument(table);
	const due = await runDetectorSweep(
		{
			expectations: probe.expectations,
			evaluate: (_shop, orderId) => table.patch(`d:${orderId}:1`, { state: 'expired' }),
		},
		NOW,
	);
	assert.equal(due, total);
	assert.ok(probe.queries.length >= 3);
	for (const q of probe.queries) assert.ok((q.limit as number) <= DETECTOR_SWEEP_PAGE);
});

test('expectations that stay pending are skipped on later pages, so the sweep terminates and reaches the rest', async () => {
	const total = DETECTOR_SWEEP_PAGE + 50;
	const table = new FakeTable(
		'id',
		Array.from({ length: total }, (_unused, i) => expectation(i, NOW - 1000 + i)),
	);
	const stuck = new Set(['o0', 'o1', 'o2']);
	const seen: string[] = [];
	await runDetectorSweep(
		{
			expectations: table as unknown as DetectorSweepDeps['expectations'],
			async evaluate(_shop, orderId) {
				seen.push(orderId);
				if (!stuck.has(orderId)) await table.patch(`d:${orderId}:1`, { state: 'expired' });
			},
		},
		NOW,
	);
	assert.equal(new Set(seen).size, total, 'every due expectation was evaluated');
	assert.equal(seen.length, total, 'each exactly once');
});
