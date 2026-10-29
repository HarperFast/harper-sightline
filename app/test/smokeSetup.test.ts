import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installedFromSetup } from '../scripts/smokeSetup.mjs';

// /setup has no `installed` field; the install state is the `installed` step.
const setup = (state: string) =>
	JSON.stringify({
		shop: 's',
		steps: [
			{ key: 'installed', state },
			{ key: 'capture', state: 'waiting' },
		],
	});

test('installed step done reads as installed', () => {
	assert.equal(installedFromSetup(setup('done')), true);
});

test('installed step pending reads as not installed', () => {
	assert.equal(installedFromSetup(setup('pending')), false);
});

test('an unparseable or step-less body is unknown, never "uninstalled"', () => {
	assert.equal(installedFromSetup('not json'), undefined);
	assert.equal(installedFromSetup('{}'), undefined);
	assert.equal(installedFromSetup(JSON.stringify({ installed: false })), undefined);
});
