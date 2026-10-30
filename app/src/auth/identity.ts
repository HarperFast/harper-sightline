import { verifySessionToken } from './verifySessionToken.ts';
import { readShopifySecret } from '../secrets/readSecret.ts';
import { AuthError } from './AuthError.ts';
import { API_REQUESTS_PER_MINUTE, createRateLimiter, RateLimitError, type RateLimiter } from './rateLimit.ts';
import { log, M, metrics } from '../observability/observe.ts';
import type { Principal } from './principal.ts';

export interface RequestLike {
	headers: { get(name: string): string | null };
	// Harper's response headers for this request; a thrown error's own headers are not sent.
	responseHeaders?: { set(name: string, value: string): unknown };
}

// A future Harper OAuth adapter can implement the same contract (ADR-001).
export interface IdentityAdapter {
	authenticate(ctx: RequestLike): Promise<Principal>;
}

// Shopify embedded identity: session token in X-Shopify-Session-Token (Harper
// intercepts Authorization, ADR-001), verified against the app secret. `readSecret`,
// the clock and the limiter are injectable for tests. The per-shop request limit
// lives here because every resource calls `identity.authenticate(ctx)` before
// touching a table, so a new resource cannot forget it.
export function createShopifyIdentityAdapter(opts: {
	apiKey: string;
	readSecret?: () => Promise<string>;
	now?: () => number;
	limiter?: RateLimiter;
}): IdentityAdapter {
	const getSecret = opts.readSecret ?? readShopifySecret;
	const now = opts.now ?? Date.now;
	const limiter = opts.limiter ?? createRateLimiter({ limit: API_REQUESTS_PER_MINUTE });
	return {
		async authenticate(ctx: RequestLike): Promise<Principal> {
			const token = ctx.headers.get('x-shopify-session-token') ?? '';
			if (!token) throw new AuthError('missing session token');
			const secret = await getSecret();
			if (!secret) {
				const e = new Error('server secret unavailable') as Error & { statusCode: number };
				e.statusCode = 500;
				throw e;
			}
			const principal = verifySessionToken(token, { apiKey: opts.apiKey, secret });
			// Counted after verification and keyed by the verified shop: a key from unverified
			// input would let a caller pick their own bucket and mint unlimited new ones. An
			// invalid token is therefore not rate limited here; verifySessionToken bounds its
			// work by refusing an oversized token before hashing.
			const decision = limiter.check(principal.shopId, now());
			if (!decision.allowed) {
				// No shop label on the metric or the log line; the count is what ops needs.
				metrics.inc(M.rateLimitedRequests);
				log('warn', 'api.rate_limited', { retryAfterSeconds: decision.retryAfterSeconds });
				ctx.responseHeaders?.set('Retry-After', String(decision.retryAfterSeconds));
				throw new RateLimitError('requests', decision.retryAfterSeconds);
			}
			return principal;
		},
	};
}
