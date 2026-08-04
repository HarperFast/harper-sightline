import { Resource } from 'harper';
import { verifySessionToken } from './src/verifySessionToken.ts';
import { AuthError } from './src/AuthError.ts';

const API_KEY = 'e446bda5edb3ee3bae6e0ba280ef8b12';

// Read the Shopify app secret lazily from Harper native secrets. Dynamic import
// + optional access so any difference in the secrets API cannot break module
// load / route registration. Falls back to env for local runs.
async function readShopifySecret(): Promise<string> {
	try {
		const mod = (await import('harper')) as { secrets?: Record<string, string | undefined> };
		const value = mod.secrets?.SHOPIFY_API_SECRET;
		if (value) return value;
	} catch {
		// ignore; fall through to env
	}
	return process.env.SHOPIFY_API_SECRET ?? '';
}

// Public diagnostic — confirms routing and which secret names the accessor sees
// (names only, never values).
export class Ping extends Resource {
	allowRead() {
		return true;
	}
	async get() {
		let secretNames: string[] = [];
		try {
			const mod = (await import('harper')) as { secrets?: Record<string, string> };
			secretNames = Object.keys(mod.secrets ?? {});
		} catch {
			// ignore
		}
		return { ok: true, spike: 'auth', secretNames };
	}
}

// Public route; performs its OWN Shopify session-token verification. The token
// is read from a custom header because Harper's HTTP auth layer intercepts and
// rejects unknown Authorization: Bearer values before the resource runs.
export class Session extends Resource {
	allowRead() {
		return true;
	}
	async get() {
		const headers = this.getContext().headers;
		const custom = headers.get('x-shopify-session-token') ?? '';
		const authz = headers.get('authorization') ?? '';
		const token = custom || (authz.startsWith('Bearer ') ? authz.slice(7) : '');
		if (!token) throw new AuthError('missing session token');
		const secret = await readShopifySecret();
		if (!secret) {
			const e = new Error('server secret unavailable') as Error & { statusCode: number };
			e.statusCode = 500;
			throw e;
		}
		const principal = verifySessionToken(token, { apiKey: API_KEY, secret });
		return { principal };
	}
}
