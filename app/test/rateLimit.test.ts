import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { API_REQUESTS_PER_MINUTE, createRateLimiter, EXPORTS_PER_MINUTE, RATE_WINDOW_MS, RateLimitError } from '../src/auth/rateLimit.ts';
import { createShopifyIdentityAdapter } from '../src/auth/identity.ts';
import { MAX_TOKEN_CHARS } from '../src/auth/verifySessionToken.ts';
import { mintToken, validClaims } from './mintToken.ts';
import { setLogSink, type LogLevel } from '../src/observability/observe.ts';

const NOW = 1_760_000_000_000;

let logLines: string[] = [];

beforeEach(() => {
	logLines = [];
	setLogSink((_level: LogLevel, line: string) => logLines.push(line));
});

afterEach(() => setLogSink(null));

test('a limiter admits exactly `limit` calls per window, then refuses', () => {
	const limiter = createRateLimiter({ limit: 3, windowMs: 1000 });
	for (let i = 0; i < 3; i++) {
		assert.equal(limiter.check('shop-a', NOW).allowed, true, `call ${i + 1} is within the limit`);
	}
	const refused = limiter.check('shop-a', NOW);
	assert.equal(refused.allowed, false);
	assert.equal(refused.retryAfterSeconds, 1, 'and says how long to wait');
});

test('the window rolls: refused now, allowed once it has elapsed', () => {
	const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
	assert.equal(limiter.check('shop-a', NOW).allowed, true);
	assert.equal(limiter.check('shop-a', NOW + 59_999).allowed, false);
	assert.equal(limiter.check('shop-a', NOW + 60_000).allowed, true, 'a full window later the budget is fresh');
});

// The retry hint has to be usable: a caller told "retry in Ns" must actually be
// admitted N seconds later, never a moment too early.
test('retryAfterSeconds rounds up to the window boundary', () => {
	const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
	limiter.check('shop-a', NOW);
	const refused = limiter.check('shop-a', NOW + 30_500);
	assert.equal(refused.retryAfterSeconds, 30);
	assert.equal(limiter.check('shop-a', NOW + 30_500 + 30_000).allowed, true);
	// Never zero — "retry in 0s" is not an instruction.
	const limiter2 = createRateLimiter({ limit: 1, windowMs: 1000 });
	limiter2.check('shop-b', NOW);
	assert.equal(limiter2.check('shop-b', NOW + 999).retryAfterSeconds, 1);
});

// The load-bearing property: one shop exhausting its budget must not throttle
// another. A limiter that shares one counter would be a cross-tenant defect wearing
// a rate-limit hat.
test('budgets are per key, so one shop cannot exhaust another shop', () => {
	const limiter = createRateLimiter({ limit: 2, windowMs: 60_000 });
	limiter.check('victim.myshopify.com', NOW);
	for (let i = 0; i < 5; i++) limiter.check('noisy.myshopify.com', NOW);
	assert.equal(limiter.check('noisy.myshopify.com', NOW).allowed, false, 'the noisy shop is throttled');
	assert.equal(limiter.check('victim.myshopify.com', NOW).allowed, true, 'the quiet shop still has budget');
});

test('the key map is bounded — expired keys are reclaimed rather than accumulating', () => {
	const limiter = createRateLimiter({ limit: 5, windowMs: 1000, maxKeys: 4 });
	for (let i = 0; i < 4; i++) limiter.check(`shop-${i}`, NOW);
	assert.equal(limiter.size(), 4);
	// A window later every held key is stale, so a new key reclaims rather than grows.
	limiter.check('shop-new', NOW + 2000);
	assert.equal(limiter.size(), 1, 'expired keys were dropped');
	assert.ok(limiter.size() <= 5);
});

// The limiter must not become the memory-exhaustion bug it prevents: unbounded
// DISTINCT keys inside a single window collapse into one shared bucket, which
// throttles sooner than the per-key limit, never later.
test('unbounded distinct keys within one window degrade into a shared bucket, not unbounded memory', () => {
	const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, maxKeys: 3 });
	for (let i = 0; i < 500; i++) limiter.check(`shop-${i}`, NOW);
	assert.ok(limiter.size() <= 4, `held ${limiter.size()} keys, expected the cap plus the overflow bucket`);
	assert.equal(limiter.check('another-new-key', NOW).allowed, false, 'the overflow bucket is exhausted, so new keys are refused');
	// A key admitted before the cap was reached keeps its own budget.
	assert.equal(limiter.check('shop-0', NOW).allowed, true);
});

test('the shipped limits are the ones the review and the docs quote', () => {
	assert.equal(RATE_WINDOW_MS, 60_000);
	assert.equal(API_REQUESTS_PER_MINUTE, 200);
	assert.equal(EXPORTS_PER_MINUTE, 10);
	// 429, not 401: the SPA renders a 401 as "your session expired, reauthorize",
	// which would be a lie — and would send a throttled merchant into a
	// reauthorization loop that cannot fix anything.
	const err = new RateLimitError('exports', 42);
	assert.equal(err.statusCode, 429);
	assert.equal(err.retryAfterSeconds, 42);
	assert.match(err.message, /too many exports — retry in 42s/);
});

// ── the identity adapter's per-shop limit ────────────────────────────────────
const API_KEY = 'e446bda5edb3ee3bae6e0ba280ef8b12';
const SECRET = 'test-secret';
const ctx = (token: string) => ({
	headers: { get: (n: string) => (n.toLowerCase() === 'x-shopify-session-token' ? token : null) },
});

test('an authenticated caller is limited per shop, and the refusal is a 429', async () => {
	const adapter = createShopifyIdentityAdapter({
		apiKey: API_KEY,
		readSecret: async () => SECRET,
		now: () => NOW,
		limiter: createRateLimiter({ limit: 2, windowMs: 60_000 }),
	});
	const token = mintToken(validClaims(), { secret: SECRET });
	await adapter.authenticate(ctx(token));
	await adapter.authenticate(ctx(token));
	await assert.rejects(
		() => adapter.authenticate(ctx(token)),
		(err: Error & { statusCode?: number }) => {
			assert.equal(err.statusCode, 429, 'a throttled read is not reported as an expired session');
			assert.match(err.message, /too many requests/);
			return true;
		},
	);
	const limited = logLines.filter((l) => l.includes('api.rate_limited'));
	assert.equal(limited.length, 1);
	assert.equal(JSON.parse(limited[0].replace('[sightline] ', '')).level, 'warn');
});

// The limit keys on the VERIFIED shop, so a second shop's token is unaffected by
// the first shop's spend — and, just as important, a caller cannot choose their own
// bucket by editing an unverified claim.
test('the limit is keyed by the verified shop, not by the token', async () => {
	const adapter = createShopifyIdentityAdapter({
		apiKey: API_KEY,
		readSecret: async () => SECRET,
		now: () => NOW,
		limiter: createRateLimiter({ limit: 1, windowMs: 60_000 }),
	});
	const shopA = mintToken(validClaims(), { secret: SECRET });
	const shopB = mintToken(validClaims({ iss: 'https://other-shop.myshopify.com/admin', dest: 'https://other-shop.myshopify.com' }), {
		secret: SECRET,
	});
	await adapter.authenticate(ctx(shopA));
	await assert.rejects(() => adapter.authenticate(ctx(shopA)), /too many requests/);
	const other = await adapter.authenticate(ctx(shopB));
	assert.equal(other.shopId, 'other-shop.myshopify.com', 'a different shop has its own budget');
});

// An invalid token still costs a verification, so the work that verification does
// before it can reject must itself be bounded. A megabyte header would otherwise be
// split, base64-decoded and JSON-parsed on the way to being refused.
test('an oversized token is refused before any of it is decoded', async () => {
	const adapter = createShopifyIdentityAdapter({ apiKey: API_KEY, readSecret: async () => SECRET, now: () => NOW });
	const huge = `${'a'.repeat(MAX_TOKEN_CHARS + 1)}.b.c`;
	await assert.rejects(
		() => adapter.authenticate(ctx(huge)),
		(err: Error & { statusCode?: number }) => {
			assert.match(err.message, /token too large/);
			assert.equal(err.statusCode, 401);
			return true;
		},
	);
	// A real token is nowhere near the cap.
	assert.ok(mintToken(validClaims(), { secret: SECRET }).length < MAX_TOKEN_CHARS);
});
