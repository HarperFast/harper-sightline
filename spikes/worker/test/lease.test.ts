import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canTake, leaseFor } from '../src/lease.ts';

test('a free lease can be taken', () => {
	assert.equal(canTake(null, 100), true);
});

test('an unexpired lease blocks others', () => {
	assert.equal(canTake(leaseFor('a', 100, 50), 120), false);
});

test('an expired lease can be taken', () => {
	assert.equal(canTake(leaseFor('a', 100, 50), 151), true);
});

test('exactly one of two contenders wins a free lease (atomic apply)', () => {
	let rec: ReturnType<typeof leaseFor> | null = null;
	const claim = (h: string, now: number, ttl: number) => {
		if (canTake(rec, now)) {
			rec = leaseFor(h, now, ttl);
			return true;
		}
		return false;
	};
	const a = claim('a', 100, 50);
	const b = claim('b', 100, 50);
	assert.equal([a, b].filter(Boolean).length, 1);
	assert.equal(rec?.holder, 'a');
});
