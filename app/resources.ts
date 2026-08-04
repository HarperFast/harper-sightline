import { Resource } from 'harper';
import { verifySessionToken } from './src/verifySessionToken.ts';
import { AuthError } from './src/AuthError.ts';
import { readShopifySecret } from './src/readSecret.ts';

// Public app API key (client_id) — not a secret.
const API_KEY = process.env.SHOPIFY_API_KEY ?? 'e446bda5edb3ee3bae6e0ba280ef8b12';
const VERSION = '0.1.0';

// Public health probe. Also the standing guard used by scripts/smoke.mjs — a
// bad import silently 404s all routes while the component reports healthy
// (ADR-001), so a live route check runs after every deploy.
export class Health extends Resource {
	static path = '/api/v1/health';
	allowRead() {
		return true;
	}
	get() {
		return { ok: true, service: 'sightline', version: VERSION };
	}
}

// Verifies the Shopify session token and returns the tenant identity. Token
// rides in X-Shopify-Session-Token because Harper's HTTP auth intercepts the
// Authorization header (ADR-001). The full principal/capability boundary is #5.
export class Session extends Resource {
	static path = '/api/v1/session';
	allowRead() {
		return true;
	}
	async get() {
		const token = this.getContext().headers.get('x-shopify-session-token') ?? '';
		if (!token) throw new AuthError('missing session token');
		const secret = await readShopifySecret();
		if (!secret) {
			const e = new Error('server secret unavailable') as Error & { statusCode: number };
			e.statusCode = 500;
			throw e;
		}
		const principal = verifySessionToken(token, { apiKey: API_KEY, secret });
		return { shop: principal.shopId, user: principal.userId };
	}
}
