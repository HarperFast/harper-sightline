import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { Resource, contentTypes } from 'harper';
import './jobs.ts'; // starts the background processing loop on component load
import { createShopifyIdentityAdapter } from './src/identity.ts';
import { capabilitiesFor } from './src/capabilities.ts';
import { ensureShopRecord } from './src/lifecycle.ts';
import { verifyWebhookHmac } from './src/webhookHmac.ts';
import { acceptDelivery } from './src/webhookIngress.ts';
import { stripPii } from './src/pii.ts';
import { readShopifySecret } from './src/readSecret.ts';
import { verifySessionToken } from './src/verifySessionToken.ts';

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

		// Persist the PII-stripped body so the worker can normalize it later
		// (ADR-002: accept fast, process later). HMAC is already verified over the
		// raw bytes; storage keeps only the whitelisted, non-PII fields (#10).
		let payload: string | undefined;
		try {
			payload = JSON.stringify(stripPii(JSON.parse(rawBody.toString('utf8'))));
		} catch {
			// Non-JSON body — store nothing; an operational topic will dead-letter.
		}

		const result = await acceptDelivery({ shopId, webhookId, topic, payload });
		return { ok: true, result };
	}
}

// The built SPA, loaded once at component start.
let INDEX_HTML = '<!doctype html><meta charset="utf-8"><title>Sightline</title>';
try {
	INDEX_HTML = readFileSync(new URL('./web/dist/index.html', import.meta.url), 'utf8');
} catch {
	// dist not present (e.g. pre-build) — keep the placeholder
}

const MIME: Record<string, string> = {
	'.js': 'text/javascript',
	'.css': 'text/css',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.json': 'application/json',
	'.map': 'application/json',
	'.woff2': 'font/woff2',
};

// Serves the embedded SPA and its assets from the site root. A resource matches
// as a prefix before the static handler, so this catches all non-/api/v1 GETs.
// The HTML entry/fallback carries a frame-ancestors CSP so Shopify Admin can
// iframe the app (required for embedded apps); real asset files are served with
// their content-type and no CSP.
export class AppHome extends Resource {
	static path = '/';
	allowRead() {
		return true;
	}
	async get() {
		const ctx = this.getContext();
		let pathname = '/';
		let shop = '';
		let idToken: string | null = null;
		try {
			const u = new URL(ctx.url ?? '/', 'https://placeholder');
			pathname = u.pathname;
			shop = u.searchParams.get('shop') ?? '';
			idToken = u.searchParams.get('id_token');
		} catch {
			// defaults
		}

		// Real static asset (no path traversal; only under /assets/).
		if (pathname.startsWith('/assets/') && !pathname.includes('..')) {
			try {
				const file = readFileSync(new URL(`./web/dist${pathname}`, import.meta.url));
				return new Response(file, { status: 200, headers: { 'content-type': MIME[extname(pathname)] ?? 'application/octet-stream' } });
			} catch {
				// fall through to the SPA
			}
		}

		// Embedded load: Shopify passes the session token as `?id_token=<JWT>`.
		// Verify it server-side and inject the session into the HTML so the SPA
		// renders without an App Bridge fetch (App Bridge forces Authorization:
		// Bearer, which Harper's auth layer rejects — ADR-001). Client-side
		// navigation keeps the session in memory, so only the initial load needs it.
		let sessionScript = '';
		if (idToken) {
			try {
				const secret = await readShopifySecret();
				const principal = verifySessionToken(idToken, { apiKey: API_KEY, secret });
				await ensureShopRecord(principal.shopId);
				const session = { shop: principal.shopId, user: principal.userId, capabilities: capabilitiesFor(principal.shopId) };
				const json = JSON.stringify(session).replace(/</g, '\\u003c');
				sessionScript = `<script>window.__SIGHTLINE_SESSION__=${json}</script>`;
				if (!shop) shop = principal.shopId;
			} catch {
				// invalid/expired id_token — the SPA shows "not connected"
			}
		}

		const ancestors = shop ? `https://${shop} https://admin.shopify.com` : 'https://*.myshopify.com https://admin.shopify.com';
		const html = sessionScript ? INDEX_HTML.replace('</head>', `${sessionScript}</head>`) : INDEX_HTML;
		return new Response(html, {
			status: 200,
			headers: {
				'content-type': 'text/html; charset=utf-8',
				'content-security-policy': `frame-ancestors ${ancestors};`,
			},
		});
	}
}
