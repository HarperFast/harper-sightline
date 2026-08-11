import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { Resource } from 'harper';
import { ensureShopRecord, ensureCredential } from '../lifecycle.ts';
import { readShopifySecret } from '../readSecret.ts';
import { verifySessionToken } from '../verifySessionToken.ts';
import { API_KEY, sessionPayload } from './auth.ts';

// The built SPA lives at the component root, two levels up from src/resources/.
// Resolved once here so every path below is relative to the build output rather
// than to this module's own location.
const WEB_DIST = new URL('../../web/dist/', import.meta.url);

// The built SPA, loaded once at component start.
let INDEX_HTML = '<!doctype html><meta charset="utf-8"><title>Sightline</title>';
try {
	INDEX_HTML = readFileSync(new URL('index.html', WEB_DIST), 'utf8');
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
				const file = readFileSync(new URL(`.${pathname}`, WEB_DIST));
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
				// One-time (per install, until expiry): exchange this real id_token for
				// an offline Admin API token so reconciliation (#13) can run. Best-effort
				// — a failure never blocks the embed (webhook capture works regardless).
				await ensureCredential({ shop: principal.shopId, sessionToken: idToken, apiKey: API_KEY, secret });
				const session = await sessionPayload(principal.shopId, principal.userId);
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
