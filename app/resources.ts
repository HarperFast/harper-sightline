import { Resource } from 'harper';
import { createShopifyIdentityAdapter } from './src/identity.ts';
import { capabilitiesFor } from './src/capabilities.ts';
import { ensureShopRecord } from './src/lifecycle.ts';

// Public app API key (client_id) — not a secret.
const API_KEY = process.env.SHOPIFY_API_KEY ?? 'e446bda5edb3ee3bae6e0ba280ef8b12';
const VERSION = '0.1.0';

const identity = createShopifyIdentityAdapter({ apiKey: API_KEY });

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

// Verifies the Shopify session token via the identity adapter and returns the
// tenant identity + capability profile. shopId is derived from the verified
// principal, never from caller input (threat model §4).
export class Session extends Resource {
	static path = '/api/v1/session';
	allowRead() {
		return true;
	}
	async get() {
		const principal = await identity.authenticate(this.getContext());
		// Bootstrap the shop record on first authenticated call (no token exchange).
		await ensureShopRecord(principal.shopId);
		return {
			shop: principal.shopId,
			user: principal.userId,
			capabilities: capabilitiesFor(principal.shopId),
		};
	}
}
