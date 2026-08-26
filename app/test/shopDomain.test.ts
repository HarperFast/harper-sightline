import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isShopDomain } from '../src/auth/shopDomain.ts';

test('accepts real shop domains', () => {
	for (const value of ['demo-shop.myshopify.com', 'a.myshopify.com', 'store123.myshopify.com', 'sightline-smoke-1a2b3c.myshopify.com']) {
		assert.ok(isShopDomain(value), `${value} is a shop domain`);
	}
});

test('rejects anything that is not exactly a myshopify host', () => {
	for (const value of [
		'',
		'myshopify.com',
		'.myshopify.com',
		'-shop.myshopify.com',
		'shop.myshopify.com.attacker.example',
		'attacker.example',
		'shop.MYSHOPIFY.com',
		'sub.shop.myshopify.com',
		'https://shop.myshopify.com',
		'shop.myshopify.com/admin',
		undefined,
		null,
		42,
	]) {
		assert.equal(isShopDomain(value), false, `${String(value)} must be refused`);
	}
});

// The finding behind the validator: `?shop=` reached a CSP header unfiltered, so a
// value carrying CSP syntax could append its own directives (or a second
// frame-ancestors source) to the policy.
test('rejects the CSP-injection primitives', () => {
	for (const value of [
		'shop.myshopify.com https://evil.example',
		'shop.myshopify.com; script-src *',
		'shop.myshopify.com;',
		'shop.myshopify.com\nx-frame-options: allow',
		'*.myshopify.com',
		"shop'.myshopify.com",
	]) {
		assert.equal(isShopDomain(value), false, `${JSON.stringify(value)} must be refused`);
	}
});

test('the length bound is checked before the pattern', () => {
	assert.equal(isShopDomain(`${'a'.repeat(300)}.myshopify.com`), false);
});
