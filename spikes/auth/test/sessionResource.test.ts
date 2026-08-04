import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintToken, validClaims } from './mintToken.ts';

// Live integration test against the deployed Fabric component.
// Skips when env is unset so the offline unit suite stays hermetic.
// SPIKE_BASE           = deployed component base URL (e.g. https://host)
// SPIKE_SHOPIFY_SECRET = the real app secret, so the minted token verifies
//                        against the secret the deployed resource reads.
//
// NOTE: the session token rides in X-Shopify-Session-Token, NOT Authorization —
// Harper's HTTP auth layer intercepts and rejects unknown Authorization: Bearer
// values before the resource runs (proven in Spike A). See RUNTIME-NOTES.md.
const BASE = process.env.SPIKE_BASE;
const SECRET = process.env.SPIKE_SHOPIFY_SECRET;

test('GET /Session returns 401 without a token', { skip: !BASE }, async () => {
	const res = await fetch(`${BASE}/Session`);
	assert.equal(res.status, 401);
});

test('GET /Session returns the principal for a valid token', { skip: !BASE || !SECRET }, async () => {
	const token = mintToken(validClaims(), { secret: SECRET as string });
	const res = await fetch(`${BASE}/Session`, { headers: { 'X-Shopify-Session-Token': token } });
	assert.equal(res.status, 200);
	const body = (await res.json()) as { principal: { shopId: string; userId: string; source: string } };
	assert.equal(body.principal.shopId, 'demo-shop.myshopify.com');
	assert.equal(body.principal.source, 'shopify-session');
});

test('GET /Session rejects a tampered token', { skip: !BASE || !SECRET }, async () => {
	const bad = mintToken(validClaims(), { secret: 'not-the-real-secret' });
	const res = await fetch(`${BASE}/Session`, { headers: { 'X-Shopify-Session-Token': bad } });
	assert.equal(res.status, 401);
});
