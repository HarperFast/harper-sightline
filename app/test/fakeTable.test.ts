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
