import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rotateCredential, type RotateDeps } from '../src/shopify/rotateCredential.ts';
import type { OfflineToken } from '../src/shopify/exchangeToken.ts';

const ARGS = { shopId: 'demo.myshopify.com', shop: 'demo.myshopify.com', apiKey: 'k', secret: 's' };

const TOKEN: OfflineToken = {
	accessToken: 'a2',
	scope: 'read_orders',
	expiresIn: 3600,
	refreshToken: 'r2',
	refreshTokenExpiresIn: 7200,
	obtainedAt: 1,
};

function httpError(statusCode: number): Error & { statusCode: number } {
	return Object.assign(new Error(`shopify token refresh failed: ${statusCode}`), { statusCode });
}

// `versions` scripts successive readVersion() answers (the last one repeats); an
// unscripted call fails the test instead of silently succeeding.
function fakeDeps(over: Partial<RotateDeps> & { versions?: number[] } = {}) {
	const { versions: scripted, ...overrides } = over;
	const calls: string[] = [];
	const versions = [...(scripted ?? [1, 1])];
	const deps: RotateDeps = {
		async readVersion() {
			calls.push('readVersion');
			const v = versions.length > 1 ? versions.shift() : versions[0];
			if (v === undefined) throw new Error('no version scripted');
			return v;
		},
		async loadRefreshToken() {
			calls.push('loadRefreshToken');
			return 'r1';
		},
		async refresh() {
			calls.push('refresh');
			return TOKEN;
		},
		async save() {
			calls.push('save');
		},
		async recordOutcome() {
			calls.push('recordOutcome');
		},
		async markReauth() {
			calls.push('markReauth');
		},
		...overrides,
	};
	return { deps, calls };
}

test('a successful refresh saves the token and does not park the shop', async () => {
	const { deps, calls } = fakeDeps();
	assert.equal(await rotateCredential(ARGS, deps), true);
	assert.ok(calls.includes('save'));
	assert.ok(!calls.includes('markReauth'));
});

test('Shopify rejecting the refresh token (401) parks the shop', async () => {
	const { deps, calls } = fakeDeps({
		async refresh() {
			throw httpError(401);
		},
	});
	assert.equal(await rotateCredential(ARGS, deps), false);
	assert.ok(calls.includes('markReauth'));
});

test('a transient Shopify failure (502) propagates without parking the shop', async () => {
	const { deps, calls } = fakeDeps({
		async refresh() {
			throw httpError(502);
		},
	});
	await assert.rejects(() => rotateCredential(ARGS, deps), /502/);
	assert.ok(!calls.includes('markReauth'));
});

test('a network error or timeout propagates without parking the shop', async () => {
	for (const err of [new TypeError('fetch failed'), new DOMException('The operation was aborted due to timeout', 'TimeoutError')]) {
		const { deps, calls } = fakeDeps({
			async refresh() {
				throw err;
			},
		});
		await assert.rejects(() => rotateCredential(ARGS, deps));
		assert.ok(!calls.includes('markReauth'));
	}
});

test('the loser of a concurrent rotation counts as success, even when Shopify answered 401', async () => {
	// The winner already spent our refresh token and stored a newer credential.
	const { deps, calls } = fakeDeps({
		versions: [1, 2],
		async refresh() {
			throw httpError(401);
		},
	});
	assert.equal(await rotateCredential(ARGS, deps), true);
	assert.ok(!calls.includes('markReauth'));
});

test('the loser of a concurrent rotation does not surface a transient failure either', async () => {
	const { deps } = fakeDeps({
		versions: [3, 4],
		async refresh() {
			throw httpError(502);
		},
	});
	assert.equal(await rotateCredential(ARGS, deps), true);
});

test('an unchanged version after a failure is not mistaken for a concurrent win', async () => {
	const { deps, calls } = fakeDeps({
		versions: [5, 5],
		async refresh() {
			throw httpError(401);
		},
	});
	assert.equal(await rotateCredential(ARGS, deps), false);
	assert.ok(calls.includes('markReauth'));
});

test('a shop with no refresh token is parked', async () => {
	const { deps, calls } = fakeDeps({
		async loadRefreshToken() {
			return null;
		},
	});
	assert.equal(await rotateCredential(ARGS, deps), false);
	assert.ok(calls.includes('markReauth'));
	assert.ok(!calls.includes('refresh'));
});
