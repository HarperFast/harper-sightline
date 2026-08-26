import { verifySessionToken } from './verifySessionToken.ts';
import { readShopifySecret } from '../secrets/readSecret.ts';
import { AuthError } from './AuthError.ts';
import { API_REQUESTS_PER_MINUTE, createRateLimiter, RateLimitError, type RateLimiter } from './rateLimit.ts';
import { log, M, metrics } from '../observability/observe.ts';
import type { Principal } from './principal.ts';

export interface RequestLike {
	headers: { get(name: string): string | null };
}

// A future Harper OAuth adapter can implement the same contract (ctx -> Principal)
// for standalone/agency identity without changing resource business logic (ADR-001).
export interface IdentityAdapter {
	authenticate(ctx: RequestLike): Promise<Principal>;
}

// Shopify embedded identity: session token in X-Shopify-Session-Token (Harper
// intercepts Authorization — ADR-001), verified against the app secret.
// `readSecret` is injectable for tests, and so are the clock and the limiter — the
// rate-limit policy is only testable if the window can be moved without waiting
// for it.
//
// This is where the per-shop request limit lives (security review F7) because it
// is the one line every authenticated read already shares: every resource calls
// `identity.authenticate(ctx)` before it touches a table, so a limit here cannot be
// forgotten by a new resource the way a per-resource check could.
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
			// Counted AFTER verification, and keyed by the verified shop: a key taken
			// from unverified input would let a caller both pick their own bucket and
			// mint unlimited new ones. The cost of that ordering is that an invalid
			// token is not itself rate limited here — verifySessionToken bounds the
			// work an invalid token can cause instead (it refuses an oversized token
			// before hashing it), and a signature cannot be brute-forced through this
			// endpoint at any rate.
			const decision = limiter.check(principal.shopId, now());
			if (!decision.allowed) {
				// No shop label on the metric (plan §13: metrics are never keyed by
				// shop) and none in the log line either — the count is what ops needs to
				// know a limit is being hit.
				metrics.inc(M.rateLimitedRequests);
				log('warn', 'api.rate_limited', { retryAfterSeconds: decision.retryAfterSeconds });
				throw new RateLimitError('requests', decision.retryAfterSeconds);
			}
			return principal;
		},
	};
}
