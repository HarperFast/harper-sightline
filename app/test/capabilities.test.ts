import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilitiesFor, requireCapability, type Capability } from '../src/capabilities.ts';

test('MVP grants record only, denies every recovery/write capability', () => {
	const c = capabilitiesFor('demo-shop.myshopify.com');
	assert.equal(c.record, true);
	const denied: Capability[] = ['replay', 'reannounce', 'repair', 'connectors', 'multi_store', 'long_retention'];
	for (const k of denied) assert.equal(c[k], false);
});

test('requireCapability allows record, denies recovery with a 403', () => {
	const c = capabilitiesFor('s');
	assert.doesNotThrow(() => requireCapability(c, 'record'));
	try {
		requireCapability(c, 'replay');
		assert.fail('should have thrown');
	} catch (e) {
		assert.equal((e as { statusCode: number }).statusCode, 403);
	}
});
