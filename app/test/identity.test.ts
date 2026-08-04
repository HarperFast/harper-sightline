import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShopifyIdentityAdapter } from '../src/identity.ts';
import { mintToken, validClaims } from './mintToken.ts';

const API_KEY = 'e446bda5edb3ee3bae6e0ba280ef8b12';
const SECRET = 'test-secret';
const adapter = createShopifyIdentityAdapter({ apiKey: API_KEY, readSecret: async () => SECRET });

const ctx = (token?: string) => ({
	headers: { get: (n: string) => (n.toLowerCase() === 'x-shopify-session-token' && token ? token : null) },
});

test('authenticates a valid token to a principal', async () => {
	const p = await adapter.authenticate(ctx(mintToken(validClaims(), { secret: SECRET })));
	assert.equal(p.shopId, 'demo-shop.myshopify.com');
	assert.equal(p.userId, '42');
	assert.equal(p.source, 'shopify-session');
});

test('rejects a missing token', async () => {
	await assert.rejects(() => adapter.authenticate(ctx()), /missing session token/i);
});

test('rejects a tampered token', async () => {
	await assert.rejects(() => adapter.authenticate(ctx(mintToken(validClaims(), { secret: 'wrong' }))), /signature/i);
});

test('500 when the server secret is unavailable', async () => {
	const a = createShopifyIdentityAdapter({ apiKey: API_KEY, readSecret: async () => '' });
	await assert.rejects(() => a.authenticate(ctx(mintToken(validClaims(), { secret: SECRET }))), /server secret unavailable/i);
});
