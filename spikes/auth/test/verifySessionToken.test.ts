import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifySessionToken } from '../src/verifySessionToken.ts';
import { mintToken, validClaims } from './mintToken.ts';

const SECRET = 'test-secret';
const API_KEY = 'e446bda5edb3ee3bae6e0ba280ef8b12';
const opts = { apiKey: API_KEY, secret: SECRET };

test('accepts a valid token and derives the principal', () => {
	const p = verifySessionToken(mintToken(validClaims(), { secret: SECRET }), opts);
	assert.equal(p.shopId, 'demo-shop.myshopify.com');
	assert.equal(p.userId, '42');
	assert.equal(p.source, 'shopify-session');
});

test('rejects a bad signature', () => {
	const t = mintToken(validClaims(), { secret: 'wrong-secret' });
	assert.throws(() => verifySessionToken(t, opts), /signature/i);
});

test('rejects alg none / non-HS256', () => {
	const t = mintToken(validClaims(), { secret: SECRET, alg: 'none' });
	assert.throws(() => verifySessionToken(t, opts), /alg/i);
});

test('rejects wrong audience', () => {
	const t = mintToken(validClaims({ aud: 'someone-else' }), { secret: SECRET });
	assert.throws(() => verifySessionToken(t, opts), /aud/i);
});

test('rejects iss/dest host mismatch', () => {
	const t = mintToken(validClaims({ iss: 'https://evil.myshopify.com/admin' }), { secret: SECRET });
	assert.throws(() => verifySessionToken(t, opts), /host/i);
});

test('rejects expired token', () => {
	const now = Math.floor(Date.now() / 1000);
	const t = mintToken(validClaims({ exp: now - 10 }), { secret: SECRET });
	assert.throws(() => verifySessionToken(t, opts), /expired/i);
});

test('rejects not-yet-valid token (nbf in future)', () => {
	const now = Math.floor(Date.now() / 1000);
	const t = mintToken(validClaims({ nbf: now + 120 }), { secret: SECRET });
	assert.throws(() => verifySessionToken(t, opts), /not yet valid/i);
});

test('rejects malformed token', () => {
	assert.throws(() => verifySessionToken('not.a.jwt', opts), /malformed|token/i);
});
