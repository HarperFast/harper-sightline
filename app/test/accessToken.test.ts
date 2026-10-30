import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getUsableAccessToken, isAuthError, REFRESH_MARGIN_MS, type TokenDeps, type CredentialFacts } from '../src/shopify/accessToken.ts';
import { installHarperLogSink } from '../src/observability/harperLogSink.ts';
import { setLogSink, log } from '../src/observability/observe.ts';

// These cover the exact failure that killed reconciliation on the live dev store
// for ~21 hours on 2026-08-06/07: an expired offline token handed straight to the
// Admin API, a 401 that escaped before the lastReconciledAt write, and a refresh
// token that was never used because rotateCredential had no call site.

const NOW = 1_786_000_000_000;

function deps(credential: CredentialFacts | undefined, rotateResult = true) {
	const calls: string[] = [];
	const d: TokenDeps = {
		getCredential: async (shopId) => {
			calls.push(`get:${shopId}`);
			return credential;
		},
		loadAccessToken: async (shopId) => {
			calls.push(`load:${shopId}`);
			return 'tok-live';
		},
		rotate: async (shopId) => {
			calls.push(`rotate:${shopId}`);
			return rotateResult;
		},
	};
	return { d, calls };
}

test('a comfortably valid token is used as-is, with no rotation', async () => {
	const { d, calls } = deps({ accessTokenEnc: '{}', status: 'active', expiresAt: NOW + 24 * 60 * 60 * 1000 });
	assert.equal(await getUsableAccessToken(d, 's1', NOW), 'tok-live');
	assert.ok(!calls.some((c) => c.startsWith('rotate')), 'must not burn a refresh on every tick');
});

test('a token inside the refresh margin is rotated BEFORE it can 401', async () => {
	// The whole point: renew a cycle early rather than discover expiry via a 401.
	const { d, calls } = deps({ accessTokenEnc: '{}', status: 'active', expiresAt: NOW + REFRESH_MARGIN_MS - 1 });
	assert.equal(await getUsableAccessToken(d, 's1', NOW), 'tok-live');
	assert.deepEqual(calls, ['get:s1', 'rotate:s1', 'load:s1'], 'rotate, then load the fresh token');
});

test('an already-expired token is rotated rather than handed to Shopify', async () => {
	// An expired token must be rotated, not sent to Shopify to 401.
	const { d, calls } = deps({ accessTokenEnc: '{}', status: 'active', expiresAt: NOW - 60_000 });
	assert.equal(await getUsableAccessToken(d, 's1', NOW), 'tok-live');
	assert.ok(calls.includes('rotate:s1'));
});

test('the margin boundary rotates rather than gambles', async () => {
	const at = { accessTokenEnc: '{}', status: 'active', expiresAt: NOW + REFRESH_MARGIN_MS };
	const { d, calls } = deps(at);
	await getUsableAccessToken(d, 's1', NOW);
	assert.ok(calls.includes('rotate:s1'), 'exactly at the margin counts as needing refresh');
});

test('an unknown expiry refreshes instead of assuming validity', async () => {
	// A missing expiresAt is precisely the state that produced a silent outage, so
	// it must not be treated as "probably fine".
	const { d, calls } = deps({ accessTokenEnc: '{}', status: 'active' });
	assert.equal(await getUsableAccessToken(d, 's1', NOW), 'tok-live');
	assert.ok(calls.includes('rotate:s1'));
});

test('a failed rotation yields no token, and does not pretend otherwise', async () => {
	const { d } = deps({ accessTokenEnc: '{}', status: 'active', expiresAt: NOW - 1 }, false);
	assert.equal(await getUsableAccessToken(d, 's1', NOW), null);
});

test('a shop needing re-consent is not retried every tick', async () => {
	// rotateCredential already parked it; hammering Shopify's refresh endpoint on a
	// 10-minute loop would achieve nothing and looks like abuse.
	const { d, calls } = deps({ accessTokenEnc: '{}', status: 'reauthorization_required', expiresAt: NOW - 1 });
	assert.equal(await getUsableAccessToken(d, 's1', NOW), null);
	assert.deepEqual(calls, ['get:s1'], 'no rotate, no load');
});

test('a shop with no credential is simply capture-only', async () => {
	const { d, calls } = deps(undefined);
	assert.equal(await getUsableAccessToken(d, 's1', NOW), null);
	assert.deepEqual(calls, ['get:s1']);
	// A credential row with no token material counts as no credential.
	const empty = deps({ status: 'active', expiresAt: NOW + 1e9 });
	assert.equal(await getUsableAccessToken(empty.d, 's1', NOW), null);
});

test('isAuthError identifies exactly the rotate-and-retry case', () => {
	assert.equal(isAuthError({ statusCode: 401 }), true);
	assert.equal(isAuthError({ statusCode: 502 }), false, 'upstream failures must not burn a rotation');
	assert.equal(isAuthError({ statusCode: 429 }), false, 'throttling is not an auth problem');
	assert.equal(isAuthError(new Error('boom')), false);
	assert.equal(isAuthError(null), false);
	assert.equal(isAuthError(undefined), false);
});

// ── log sink ─────────────────────────────────────────────────────────────────

test('the Harper log sink is a no-op when no Harper logger exists', () => {
	// Unit tests and local vite dev have no `logger` global; the console default
	// must stay in place rather than the app crashing or silently losing lines.
	assert.equal(installHarperLogSink(), false);
});

test('the Harper log sink routes lines to the logger, by level', () => {
	const seen: Array<[string, string]> = [];
	const fake = {
		error: (m: string) => seen.push(['error', m]),
		warn: (m: string) => seen.push(['warn', m]),
		info: (m: string) => seen.push(['info', m]),
		trace: (m: string) => seen.push(['trace', m]),
	};
	(globalThis as { logger?: unknown }).logger = fake;
	try {
		assert.equal(installHarperLogSink(), true);
		log('warn', 'ops.snapshot', { healthy: false });
		log('error', 'reconcile.error', { message: 'x' });
		log('trace', 'process.tick', {});
		assert.deepEqual(
			seen.map(([lvl]) => lvl),
			['warn', 'error', 'trace'],
		);
		assert.match(seen[0][1], /\[sightline\].*ops\.snapshot/, 'the structured envelope survives');
	} finally {
		setLogSink(null);
		delete (globalThis as { logger?: unknown }).logger;
	}
});

test('a missing logger method falls back rather than dropping the line', () => {
	// Only `info` exists — a warn must still land somewhere.
	const seen: string[] = [];
	(globalThis as { logger?: unknown }).logger = { info: (m: string) => seen.push(m) };
	try {
		installHarperLogSink();
		log('warn', 'ops.snapshot', {});
		assert.equal(seen.length, 1, 'warn fell back to info instead of vanishing');
	} finally {
		setLogSink(null);
		delete (globalThis as { logger?: unknown }).logger;
	}
});

test('a throwing logger method does not take the caller down', () => {
	const seen: string[] = [];
	(globalThis as { logger?: unknown }).logger = {
		warn: () => {
			throw new Error('logger exploded');
		},
		info: (m: string) => seen.push(m),
	};
	try {
		installHarperLogSink();
		assert.doesNotThrow(() => log('warn', 'ops.snapshot', {}));
		assert.equal(seen.length, 1, 'and the line still lands via the next candidate');
	} finally {
		setLogSink(null);
		delete (globalThis as { logger?: unknown }).logger;
	}
});
