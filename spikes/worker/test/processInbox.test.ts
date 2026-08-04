import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processInbox } from '../src/processInbox.ts';

function memStore(ids: string[]) {
	const results = new Map<string, string>();
	return {
		claimed: results,
		async listUnprocessed() {
			return ids.filter((i) => !results.has(i));
		},
		async claimResult(id: string, by: string) {
			if (results.has(id)) return false;
			results.set(id, by);
			return true;
		},
	};
}

test('processes every unprocessed item exactly once', async () => {
	const s = memStore(['a', 'b', 'c']);
	const r = await processInbox('w1', s);
	assert.deepEqual(r.processed.sort(), ['a', 'b', 'c']);
	assert.equal(s.claimed.size, 3);
});

test('is a no-op when everything is already processed (idempotent restart)', async () => {
	const s = memStore(['a']);
	await processInbox('w1', s);
	const again = await processInbox('w1', s);
	assert.deepEqual(again.processed, []);
});

test('two concurrent workers never double-process', async () => {
	const s = memStore(['a', 'b', 'c', 'd']);
	const [r1, r2] = await Promise.all([processInbox('w1', s), processInbox('w2', s)]);
	const all = [...r1.processed, ...r2.processed].sort();
	assert.deepEqual(all, ['a', 'b', 'c', 'd']);
	assert.equal(s.claimed.size, 4);
});
