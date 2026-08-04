import { verifySessionToken } from './verifySessionToken.ts';
import { readShopifySecret } from './readSecret.ts';
import { AuthError } from './AuthError.ts';
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
// `readSecret` is injectable for tests.
export function createShopifyIdentityAdapter(opts: { apiKey: string; readSecret?: () => Promise<string> }): IdentityAdapter {
	const getSecret = opts.readSecret ?? readShopifySecret;
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
			return verifySessionToken(token, { apiKey: opts.apiKey, secret });
		},
	};
}
