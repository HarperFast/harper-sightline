import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { exchangeOfflineToken } from '../src/exchangeToken.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('posts the token-exchange request and parses an expiring offline token', async () => {
	let captured: { url: string; body: string } | undefined;
	globalThis.fetch = (async (url: string, init: { body: URLSearchParams }) => {
		captured = { url: String(url), body: init.body.toString() };
		return new Response(JSON.stringify({
			access_token: 'shpat_x', scope: 'read_orders',
			expires_in: 86399, refresh_token: 'rt_x', refresh_token_expires_in: 86399,
		}), { status: 200 });
	}) as typeof fetch;

	const tok = await exchangeOfflineToken({
		shop: 'demo-shop.myshopify.com', sessionToken: 'sess', apiKey: 'k', secret: 's',
	});

	assert.equal(captured?.url, 'https://demo-shop.myshopify.com/admin/oauth/access_token');
	assert.match(captured?.body ?? '', /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange/);
	assert.match(captured?.body ?? '', /requested_token_type=urn%3Ashopify%3Aparams%3Aoauth%3Atoken-type%3Aoffline-access-token/);
	assert.match(captured?.body ?? '', /expiring=1/);
	assert.equal(tok.accessToken, 'shpat_x');
	assert.equal(tok.refreshToken, 'rt_x');
	assert.equal(tok.expiresIn, 86399);
});

test('throws with a mapped status on Shopify error', async () => {
	globalThis.fetch = (async () => new Response('bad', { status: 400 })) as typeof fetch;
	await assert.rejects(
		() => exchangeOfflineToken({ shop: 's.myshopify.com', sessionToken: 't', apiKey: 'k', secret: 's' }),
		/token exchange failed/i,
	);
});
