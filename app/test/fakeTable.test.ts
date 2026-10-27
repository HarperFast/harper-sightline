import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTable } from './fakeTable.ts';

test('put upserts by key field and stores a copy', async () => {
	const table = new FakeTable('id');
	const record = { id: 'a', n: 1 };
	await table.put(record);
	record.n = 99; // mutating the caller's object must not affect the stored row
	assert.deepEqual(await table.get('a'), { id: 'a', n: 1 });

	await table.put({ id: 'a', n: 2 });
	assert.deepEqual(await table.get('a'), { id: 'a', n: 2 });
	assert.equal(table.rows.size, 1);
});

test('patch shallow-merges an existing row and ignores a missing one', async () => {
	const table = new FakeTable('id', [{ id: 'a', n: 1, keep: true }]);
	await table.patch('a', { n: 5 });
	assert.deepEqual(await table.get('a'), { id: 'a', n: 5, keep: true });

	await table.patch('missing', { n: 1 });
	assert.equal(await table.get('missing'), undefined);
});

// The fake stands in for Harper in every read-layer test, so it must refuse the
// queries Harper refuses, such as a one-condition `or`.
test('search refuses an "or" over fewer than two conditions, like Harper', async () => {
	const table = new FakeTable('id', [{ id: 'a', shopId: 's1' }]);
	await assert.rejects(async () => {
		for await (const _row of table.search({ conditions: [{ attribute: 'shopId', value: 's1' }], operator: 'or' })) {
			// consuming the iterator is what runs the query
		}
	}, /"or" operator requires at least two conditions/);
});

test('search refuses an "and" with no conditions, and an unknown operator', async () => {
	const table = new FakeTable('id', [{ id: 'a' }]);
	const run = async (query: Parameters<FakeTable['search']>[0]) => {
		for await (const _row of table.search(query)) {
			// drain
		}
	};
	await assert.rejects(() => run({ conditions: [], operator: 'and' }), /"and" operator requires at least one condition/);
	await assert.rejects(() => run({ conditions: [] }), /"and" operator requires at least one condition/);
	await assert.rejects(
		() => run({ conditions: [{ attribute: 'id', value: 'a' }], operator: 'nor' as unknown as 'or' }),
		/Invalid operator nor/,
	);
});

test('an "or" over two conditions still matches either', async () => {
	const table = new FakeTable('id', [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
	const seen: string[] = [];
	for await (const row of table.search({
		conditions: [
			{ attribute: 'id', value: 'a' },
			{ attribute: 'id', value: 'c' },
		],
		operator: 'or',
	})) {
		seen.push(String(row.id));
	}
	assert.deepEqual(seen.sort(), ['a', 'c']);
});
