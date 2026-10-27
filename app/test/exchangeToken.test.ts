import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { exchangeOfflineToken, refreshOfflineToken } from '../src/shopify/exchangeToken.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

test('exchange posts the token-exchange grant and parses an expiring offline token', async () => {
	let body = '';
	globalThis.fetch = (async (url: string, init: { body: URLSearchParams }) => {
		body = init.body.toString();
		void url;
		return new Response(
			JSON.stringify({
				access_token: 'shpat_x',
				scope: 'read_orders',
				expires_in: 86399,
				refresh_token: 'rt',
				refresh_token_expires_in: 86399,
			}),
			{ status: 200 },
		);
	}) as typeof fetch;
	const t = await exchangeOfflineToken({ shop: 'demo.myshopify.com', sessionToken: 's', apiKey: 'k', secret: 'sec' });
	assert.match(body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange/);
	assert.match(body, /requested_token_type=urn%3Ashopify%3Aparams%3Aoauth%3Atoken-type%3Aoffline-access-token/);
	assert.match(body, /expiring=1/);
	assert.equal(t.accessToken, 'shpat_x');
	assert.equal(t.refreshToken, 'rt');
});

test('exchange maps a 400 to a 401 (reauthorize)', async () => {
	globalThis.fetch = (async () => new Response('bad', { status: 400 })) as typeof fetch;
	await assert.rejects(() => exchangeOfflineToken({ shop: 's', sessionToken: 't', apiKey: 'k', secret: 'x' }), /token exchange failed/i);
});

test('refresh posts the refresh_token grant', async () => {
	let body = '';
	globalThis.fetch = (async (_url: string, init: { body: URLSearchParams }) => {
		body = init.body.toString();
		return new Response(JSON.stringify({ access_token: 'a2', expires_in: 100, refresh_token: 'r2', refresh_token_expires_in: 100 }), {
			status: 200,
		});
	}) as typeof fetch;
	const t = await refreshOfflineToken({ shop: 's', refreshToken: 'r', apiKey: 'k', secret: 'x' });
	assert.match(body, /grant_type=refresh_token/);
	assert.match(body, /refresh_token=r/);
	assert.equal(t.accessToken, 'a2');
});

const calls = [
	['exchange', () => exchangeOfflineToken({ shop: 's', sessionToken: 't', apiKey: 'k', secret: 'x' })],
	['refresh', () => refreshOfflineToken({ shop: 's', refreshToken: 'r', apiKey: 'k', secret: 'x' })],
] as const;

for (const [name, call] of calls) {
	test(`${name} passes an abort signal so a hung connection cannot block forever`, async () => {
		let signal: AbortSignal | undefined;
		globalThis.fetch = (async (_url: string, init: { signal?: AbortSignal }) => {
			signal = init.signal;
			return new Response(JSON.stringify({ access_token: 'a' }), { status: 200 });
		}) as typeof fetch;
		await call();
		assert.ok(signal instanceof AbortSignal);
	});

	test(`${name} timing out rejects as a transient error, not an auth error`, async () => {
		// A fetch that never answers and only ends when its signal aborts, as real
		// fetch does; the timeout is shortened so the test does not wait 30s.
		globalThis.fetch = (async (_url: string, init: { signal: AbortSignal }) =>
			new Promise((_resolve, reject) => {
				init.signal.addEventListener('abort', () => reject(init.signal.reason));
			})) as typeof fetch;
		const realTimeout = AbortSignal.timeout;
		AbortSignal.timeout = () => realTimeout.call(AbortSignal, 5);
		try {
			await assert.rejects(call, (e: Error & { statusCode?: number }) => e.name === 'TimeoutError' && e.statusCode !== 401);
		} finally {
			AbortSignal.timeout = realTimeout;
		}
	});
}
