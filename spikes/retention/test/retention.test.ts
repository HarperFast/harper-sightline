import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutoffMs, purgeSql, isExpired } from '../src/retention.ts';

test('cutoff is now minus retention window', () => {
	assert.equal(cutoffMs(604_800_000 * 2, 7), 604_800_000);
});

test('isExpired at the boundary', () => {
	const now = 1_000_000_000_000;
	assert.equal(isExpired(now - 7 * 86_400_000 - 1, now, 7), true);
	assert.equal(isExpired(now - 1, now, 7), false);
});

test('purgeSql targets rows older than cutoff', () => {
	assert.equal(purgeSql('data', 't', 'receivedAt', 42), 'DELETE FROM data.t WHERE receivedAt < 42');
});
