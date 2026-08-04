import { Resource, contentTypes } from 'harper';
import { createShopifyIdentityAdapter } from './src/identity.ts';
import { capabilitiesFor } from './src/capabilities.ts';
import { ensureShopRecord } from './src/lifecycle.ts';
import { verifyWebhookHmac } from './src/webhookHmac.ts';
import { acceptDelivery } from './src/webhookIngress.ts';
import { readShopifySecret } from './src/readSecret.ts';

// Preserve the RAW request body so webhook HMAC can be verified before parsing
// (Harper otherwise parses application/json and consumes the bytes). We keep the
// raw Buffer as the deserialized value; the webhook is the only JSON-body
// consumer and parses it itself after verifying (ADR-001, plan §12).
contentTypes.set('application/json', {
	serialize: (data) => Buffer.from(JSON.stringify(data)),
	deserialize: (raw) => raw,
	q: 1,
});

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

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
	const e = new Error(message) as Error & { statusCode: number };
	e.statusCode = statusCode;
	return e;
}

// Shopify webhook ingress. Authenticated by HMAC over the RAW body (NOT the
// merchant JWT), verified before any parsing (ADR-001, plan §12). Durably
// accepts once per (shop, webhookId) and acks fast — no normalization or Admin
// API calls here (ADR-002). A worker processes accepted rows later.
export class ShopifyWebhook extends Resource {
	static path = '/webhooks/shopify/events';
	allowRead() {
		return true;
	}
	allowCreate() {
		return true;
	}
	allowUpdate() {
		return true;
	}
	async post() {
		const ctx = this.getContext();
		// With the raw content-type handler above, ctx.data resolves to the raw
		// Buffer of the request body (not parsed).
		const resolved = await ctx.data;
		const rawBody = Buffer.isBuffer(resolved) ? resolved : Buffer.from(typeof resolved === 'string' ? resolved : '', 'utf8');

		const secret = await readShopifySecret();
		if (!verifyWebhookHmac(rawBody, ctx.headers.get('x-shopify-hmac-sha256'), secret)) {
			throw httpError('invalid webhook hmac', 401);
		}

		const shopId = ctx.headers.get('x-shopify-shop-domain') ?? '';
		const webhookId = ctx.headers.get('x-shopify-webhook-id') ?? '';
		const topic = ctx.headers.get('x-shopify-topic') ?? '';
		if (!shopId || !webhookId) throw httpError('missing webhook headers', 400);

		const result = await acceptDelivery({ shopId, webhookId, topic });
		return { ok: true, result };
	}
}
