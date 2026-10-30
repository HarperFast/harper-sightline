import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drainProgress } from '../scripts/loadtestDrain.mjs';

// /ops caps the backlog count at 10,000 and flags it. A capped count is a floor, so a
// rate measured from a capped sample would under-read the drain.
const sample = (atSec: number, accepted: number, capped = false) => ({ atSec, accepted, capped });

test('an uncapped run measures the drain between the first and last samples', () => {
	assert.deepEqual(drainProgress([sample(0, 5000), sample(10, 1000)], 0), { rate: 400, reason: 'measured', cappedSamples: 0 });
});

test('capped samples are left out, and the rate comes from the exact tail', () => {
	const r = drainProgress([sample(0, 10_000, true), sample(10, 10_000, true), sample(20, 6000), sample(30, 2000)], 0);
	assert.deepEqual(r, { rate: 400, reason: 'measured', cappedSamples: 2 });
});

test('a run capped at every sample is not measurable, and says why', () => {
	assert.deepEqual(drainProgress([sample(0, 10_000, true), sample(10, 10_000, true)], 0), {
		rate: null,
		reason: 'capped',
		cappedSamples: 2,
	});
});

test('a capped first sample is not mistaken for nothing queued', () => {
	assert.equal(drainProgress([sample(0, 10_000, true)], 10_000).reason, 'capped');
});

test('nothing queued and no progress keep their meaning', () => {
	assert.equal(drainProgress([sample(0, 0)], 0).reason, 'nothing-queued');
	assert.deepEqual(drainProgress([sample(0, 500), sample(10, 500)], 0), { rate: 0, reason: 'no-progress', cappedSamples: 0 });
});
