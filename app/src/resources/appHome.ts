import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { Resource } from 'harper';
import { ensureShopRecord, ensureCredential } from '../shopify/lifecycle.ts';
import { readShopifySecret } from '../secrets/readSecret.ts';
import { verifySessionToken } from '../auth/verifySessionToken.ts';
import { resolveAssetUrl } from './assetPath.ts';
import { frameAncestors } from './frameAncestors.ts';
import { API_KEY, sessionPayload } from './auth.ts';

// Two levels up from src/resources/; paths below are relative to the build output.
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

// Serves the embedded SPA and assets from the site root; a resource matches as a
// prefix before the static handler, so this catches all non-/api/v1 GETs. The HTML
// entry carries a frame-ancestors CSP so Shopify Admin can iframe it, decided by
// frameAncestors from the verified principal, never by `?shop=` alone.
export class AppHome extends Resource {
	static path = '/';
	allowRead() {
		return true;
	}
	async get() {
		const ctx = this.getContext();
		let pathname = '/';
		let shopParam = '';
		let idToken: string | null = null;
		try {
			const u = new URL(ctx.url ?? '/', 'https://placeholder');
			pathname = u.pathname;
			shopParam = u.searchParams.get('shop') ?? '';
			idToken = u.searchParams.get('id_token');
		} catch {
			// defaults
		}

		// resolveAssetUrl (assetPath.ts) is the containment boundary: this reads a file for
		// an unauthenticated caller and must never resolve outside web/dist/assets/.
		const assetUrl = resolveAssetUrl(pathname, WEB_DIST);
		if (assetUrl) {
			try {
				const file = readFileSync(assetUrl);
				return new Response(file, { status: 200, headers: { 'content-type': MIME[extname(pathname)] ?? 'application/octet-stream' } });
			} catch {
				// fall through to the SPA
			}
		}

		// Embedded load: Shopify passes the session token as `?id_token=`. Verify it and
		// inject the session into the HTML, since App Bridge forces Authorization: Bearer,
		// which Harper's auth layer rejects (ADR-001). Client-side navigation keeps the
		// session in memory, so only the initial load needs it.
		let sessionScript = '';
		// The shop as Shopify signed it; `?shop=` is only a caller hint, so the CSP prefers this.
		let verifiedShop: string | undefined;
		if (idToken) {
			try {
				const secret = await readShopifySecret();
				const principal = verifySessionToken(idToken, { apiKey: API_KEY, secret });
				// Set as soon as the signature checks out so a later storage failure cannot downgrade
				// the CSP to the wildcard for a shop we know.
				verifiedShop = principal.shopId;
				await ensureShopRecord(principal.shopId);
				// Exchange this id_token for an offline Admin API token. Best-effort: a failure
				// never blocks the embed.
				await ensureCredential({ shop: principal.shopId, sessionToken: idToken, apiKey: API_KEY, secret });
				const session = await sessionPayload(principal.shopId, principal.userId);
				const json = JSON.stringify(session).replace(/</g, '\\u003c');
				sessionScript = `<script>window.__SIGHTLINE_SESSION__=${json}</script>`;
			} catch {
				// invalid/expired id_token — the SPA shows "not connected"
			}
		}

		const ancestors = frameAncestors(verifiedShop, shopParam);
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
