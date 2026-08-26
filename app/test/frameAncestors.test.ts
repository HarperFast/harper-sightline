import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameAncestors } from '../src/resources/frameAncestors.ts';

const WILDCARD = 'https://*.myshopify.com https://admin.shopify.com';

test('the verified shop wins over the query parameter', () => {
	assert.equal(
		frameAncestors('real-shop.myshopify.com', 'attacker.myshopify.com'),
		'https://real-shop.myshopify.com https://admin.shopify.com',
	);
});

test('a valid ?shop= is used only when no session token was verified', () => {
	assert.equal(frameAncestors(undefined, 'demo-shop.myshopify.com'), 'https://demo-shop.myshopify.com https://admin.shopify.com');
});

// F6's actual severity: the param reached a response header uninspected, so it
// could carry CSP syntax and write its own policy. A refused value must fall back
// to the wildcard, never be interpolated.
test('a hostile ?shop= cannot reach the header, in any shape', () => {
	for (const hostile of [
		'evil.example',
		'shop.myshopify.com https://evil.example',
		'shop.myshopify.com; frame-ancestors *',
		'*',
		'*.myshopify.com',
		'',
	]) {
		assert.equal(frameAncestors(undefined, hostile), WILDCARD, `${JSON.stringify(hostile)} must not be interpolated`);
	}
});

test('an unverifiable load gets the myshopify wildcard, never an empty or open policy', () => {
	assert.equal(frameAncestors(undefined, undefined), WILDCARD);
	// A `dest` host that is not shop-shaped is not trusted into the header either.
	assert.equal(frameAncestors('not-a-shop.example', undefined), WILDCARD);
	assert.ok(!frameAncestors(undefined, undefined).includes('https://*;'));
});
