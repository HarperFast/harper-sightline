import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { Resource, contentTypes } from 'harper';
import './jobs.ts'; // starts the background processing loop on component load
import { createShopifyIdentityAdapter } from './src/identity.ts';
import { capabilitiesFor } from './src/capabilities.ts';
import { ensureShopRecord, ensureCredential } from './src/lifecycle.ts';
import { verifyWebhookHmac } from './src/webhookHmac.ts';
import { acceptDelivery } from './src/webhookIngress.ts';
import { stripPii } from './src/pii.ts';
import {
	Events as EventsTable,
	Findings as FindingsTable,
	Projections as ProjectionsTable,
	Expectations as ExpectationsTable,
	Deliveries as DeliveriesTable,
	Shops as ShopsTable,
	Credentials as CredentialsTable,
} from './src/db.ts';
import {
	listEvents,
	getEventDetail,
	listFindings,
	getFindingDetail,
	getSummary,
	computeFlows,
	getPrivacy,
	getSetup,
	type QueryTable,
} from './src/queries.ts';
import { supportContact } from './src/support.ts';
import { privacyPolicyHtml } from './src/privacyPolicy.ts';
import { redactShop, redactOrders } from './src/redaction.ts';
import { REDACT_TARGETS } from './src/ledgerTargets.ts';
import { writeAudit } from './src/audit.ts';
import { handleCompliance, type ComplianceDeps } from './src/compliance.ts';

// db.ts types tables as Table<T>; the read layer needs only the search/get subset.
const EventsQ = EventsTable as unknown as QueryTable;
const FindingsQ = FindingsTable as unknown as QueryTable;
const ProjectionsQ = ProjectionsTable as unknown as QueryTable;
const ExpectationsQ = ExpectationsTable as unknown as QueryTable;
const DeliveriesQ = DeliveriesTable as unknown as QueryTable;
const ShopsQ = ShopsTable as unknown as QueryTable;
// Read ONLY for the credential's `status` (reauthorization state) in /setup —
// never for token material, which stays inside credentialStore.ts.
const CredentialsQ = CredentialsTable as unknown as QueryTable;
import { readShopifySecret, SHOPIFY_API_KEY } from './src/readSecret.ts';
import { verifySessionToken } from './src/verifySessionToken.ts';
import { log, metrics, M } from './src/observe.ts';
import { installHarperLogSink } from './src/harperLogSink.ts';

// Route logs into Harper's logger before anything else logs, so the ops.snapshot
// heartbeat and every error line are reachable via the operations API's read_log
// rather than going to stdout where nothing can query them.
const logSinkInstalled = installHarperLogSink();
log('info', 'boot.logsink', { sink: logSinkInstalled ? 'harper' : 'console' });

// Preserve the RAW request body so webhook HMAC can be verified before parsing
// (Harper otherwise parses application/json and consumes the bytes). We keep the
// raw Buffer as the deserialized value; the webhook is the only JSON-body
// consumer and parses it itself after verifying (ADR-001, plan §12).
contentTypes.set('application/json', {
	serialize: (data) => Buffer.from(JSON.stringify(data)),
	deserialize: (raw) => raw,
	q: 1,
});

// Public app API key (client_id) — not a secret. Sourced from readSecret.ts so the
// literal cannot drift between here and background token rotation.
const API_KEY = SHOPIFY_API_KEY;
const VERSION = '0.1.0';

const identity = createShopifyIdentityAdapter({ apiKey: API_KEY });

// The public privacy policy (#26). Deliberately UNAUTHENTICATED: the App Store
// listing links to it and a reviewer must be able to read it without installing
// the app. Contains no shop data — it is the same static document for everyone —
// so there is nothing here to scope to a tenant. No frame-ancestors CSP: unlike
// the app itself this is meant to open in a normal browser tab, not an iframe.
export class PrivacyPolicy extends Resource {
	static path = '/privacy-policy';
	allowRead() {
		return true;
	}
	get() {
		return new Response(privacyPolicyHtml(supportContact(), process.env.SIGHTLINE_POLICY_UPDATED ?? 'Not yet published'), {
			status: 200,
			headers: { 'content-type': 'text/html; charset=utf-8' },
		});
	}
}

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
// The session payload the SPA boots from. `timezone` is the store's configured
// IANA zone, cached by the reconcile sweep — it is absent until the first sweep
// completes, and the SPA falls back to the viewer's zone (labelling whichever it
// used) so a timestamp is never shown against an unstated zone.
async function sessionPayload(shopId: string, userId: string): Promise<Record<string, unknown>> {
	const shop = await ShopsTable.get(shopId);
	return {
		shop: shopId,
		user: userId,
		capabilities: capabilitiesFor(shopId),
		...(shop?.ianaTimezone ? { timezone: shop.ianaTimezone } : {}),
		// Merchant-facing support contact, so the UI can offer help on the screens
		// where a merchant is actually stuck. Absent when unconfigured — never a
		// fabricated address (src/support.ts).
		support: supportContact(),
	};
}

export class Session extends Resource {
	static path = '/api/v1/session';
	allowRead() {
		return true;
	}
	async get() {
		const principal = await identity.authenticate(this.getContext());
		// Bootstrap the shop record on first authenticated call (no token exchange).
		await ensureShopRecord(principal.shopId);
		return sessionPayload(principal.shopId, principal.userId);
	}
}

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
	const e = new Error(message) as Error & { statusCode: number };
	e.statusCode = statusCode;
	return e;
}

// ── Read API (#15) ────────────────────────────────────────────────────────────
// Every resource derives shopId from the verified principal and passes it to the
// query layer, which constrains every search by it (tenant isolation). Responses
// are field-allowlisted in queries.ts. Standard 7-day bounded windows + cursor
// pagination. Classes are *Resource-suffixed to avoid colliding with the table
// imports; routing comes from `static path`.

// Parse a URL, returning its pathname and search params (defensive).
function parseUrl(url: string | undefined): URL {
	try {
		return new URL(url ?? '/', 'https://sightline.local');
	} catch {
		return new URL('https://sightline.local/');
	}
}

// The single path segment after `base`, decoded, or undefined for the collection.
function trailingId(pathname: string, base: string): string | undefined {
	if (!pathname.startsWith(base + '/')) return undefined;
	const rest = pathname.slice(base.length + 1);
	if (!rest || rest.includes('/')) return undefined;
	try {
		return decodeURIComponent(rest);
	} catch {
		return rest;
	}
}

function numParam(params: URLSearchParams, name: string): number | undefined {
	const raw = params.get(name);
	if (raw === null) return undefined;
	const n = Number(raw);
	return Number.isFinite(n) ? n : undefined;
}

export class SummaryResource extends Resource {
	static path = '/api/v1/summary';
	allowRead() {
		return true;
	}
	async get() {
		const shopId = (await identity.authenticate(this.getContext())).shopId;
		return getSummary(
			{ events: EventsQ, projections: ProjectionsQ, findings: FindingsQ, deliveries: DeliveriesQ, shops: ShopsQ },
			shopId,
			Date.now(),
		);
	}
}

// First-open/setup progress (screen spec §1), derived from durable state only.
export class SetupResource extends Resource {
	static path = '/api/v1/setup';
	allowRead() {
		return true;
	}
	async get() {
		const shopId = (await identity.authenticate(this.getContext())).shopId;
		return getSetup({ shops: ShopsQ, deliveries: DeliveriesQ, credentials: CredentialsQ }, shopId, Date.now());
	}
}

export class EventsResource extends Resource {
	static path = '/api/v1/events';
	allowRead() {
		return true;
	}
	async get() {
		const ctx = this.getContext();
		const shopId = (await identity.authenticate(ctx)).shopId;
		const url = parseUrl(ctx.url);
		const id = trailingId(url.pathname, '/api/v1/events');
		if (id) {
			const detail = await getEventDetail(EventsQ, ProjectionsQ, FindingsQ, shopId, id);
			if (!detail) throw httpError('event not found', 404);
			return detail;
		}
		const p = url.searchParams;
		return listEvents(EventsQ, shopId, Date.now(), {
			domain: p.get('domain') ?? undefined,
			topic: p.get('topic') ?? undefined,
			resourceId: p.get('resourceId') ?? undefined,
			sku: p.get('sku') ?? undefined,
			source: p.get('source') ?? undefined,
			since: numParam(p, 'since'),
			until: numParam(p, 'until'),
			cursor: p.get('cursor') ?? undefined,
			limit: p.get('limit') ?? undefined,
		});
	}
}

export class FlowsResource extends Resource {
	static path = '/api/v1/flows';
	allowRead() {
		return true;
	}
	async get() {
		const shopId = (await identity.authenticate(this.getContext())).shopId;
		return computeFlows(ProjectionsQ, shopId, Date.now());
	}
}

export class FindingsResource extends Resource {
	static path = '/api/v1/findings';
	allowRead() {
		return true;
	}
	async get() {
		const ctx = this.getContext();
		const shopId = (await identity.authenticate(ctx)).shopId;
		const url = parseUrl(ctx.url);
		const id = trailingId(url.pathname, '/api/v1/findings');
		if (id) {
			const detail = await getFindingDetail(FindingsQ, ExpectationsQ, ProjectionsQ, shopId, id);
			if (!detail) throw httpError('finding not found', 404);
			return detail;
		}
		const p = url.searchParams;
		return listFindings(FindingsQ, ExpectationsQ, ProjectionsQ, shopId, {
			status: p.get('status') ?? undefined,
			cursor: p.get('cursor') ?? undefined,
			limit: p.get('limit') ?? undefined,
		});
	}
}

export class PrivacyResource extends Resource {
	static path = '/api/v1/privacy';
	allowRead() {
		return true;
	}
	async get() {
		const shopId = (await identity.authenticate(this.getContext())).shopId;
		return getPrivacy(
			{ events: EventsQ, findings: FindingsQ, projections: ProjectionsQ, deliveries: DeliveriesQ, shops: ShopsQ },
			shopId,
			Date.now(),
		);
	}
}

// Shopify mandatory privacy/compliance webhooks (#21). Separate URIs from the
// operational events endpoint (shopify.app.toml [webhooks.privacy_compliance]).
// Authenticated by HMAC over the RAW body — an invalid HMAC 401s and performs NO
// mutation (verification precedes any dispatch). Retry-safe: redaction is
// idempotent and audits are keyed by webhook id.
export class ComplianceWebhook extends Resource {
	static path = '/webhooks/shopify/compliance';
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
		const resolved = await ctx.data;
		const rawBody = Buffer.isBuffer(resolved) ? resolved : Buffer.from(typeof resolved === 'string' ? resolved : '', 'utf8');

		const secret = await readShopifySecret();
		if (!verifyWebhookHmac(rawBody, ctx.headers.get('x-shopify-hmac-sha256'), secret)) {
			throw httpError('invalid webhook hmac', 401);
		}

		const topic = ctx.headers.get('x-shopify-topic') ?? '';
		const webhookId = ctx.headers.get('x-shopify-webhook-id') ?? '';
		const shopId = ctx.headers.get('x-shopify-shop-domain') ?? '';
		let payload: Record<string, unknown> = {};
		try {
			const parsed = JSON.parse(rawBody.toString('utf8'));
			if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>;
		} catch {
			// tolerate an empty/invalid body — HMAC already proved authenticity
		}

		const deps: ComplianceDeps = {
			redactShop: (sid) => redactShop(REDACT_TARGETS, sid),
			redactOrders: (sid, ids) => redactOrders(REDACT_TARGETS, sid, ids),
			// Keyed by webhook id → a Shopify retry upserts the same audit row.
			audit: (action, sid, detail) => writeAudit(`${action}:${webhookId}`, sid, action, Date.now(), detail),
		};
		const result = await handleCompliance(topic, shopId, payload, deps);
		return { ok: true, result };
	}
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
		const startedAt = Date.now();
		metrics.inc(M.webhookReceived);
		// With the raw content-type handler above, ctx.data resolves to the raw
		// Buffer of the request body (not parsed).
		const resolved = await ctx.data;
		const rawBody = Buffer.isBuffer(resolved) ? resolved : Buffer.from(typeof resolved === 'string' ? resolved : '', 'utf8');

		const secret = await readShopifySecret();
		if (!verifyWebhookHmac(rawBody, ctx.headers.get('x-shopify-hmac-sha256'), secret)) {
			metrics.inc(M.webhookHmacFail);
			throw httpError('invalid webhook hmac', 401);
		}

		const shopId = ctx.headers.get('x-shopify-shop-domain') ?? '';
		const webhookId = ctx.headers.get('x-shopify-webhook-id') ?? '';
		const topic = ctx.headers.get('x-shopify-topic') ?? '';
		if (!shopId || !webhookId) {
			metrics.inc(M.webhookBadRequest);
			throw httpError('missing webhook headers', 400);
		}

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
		metrics.inc(result === 'duplicate' ? M.webhookDuplicate : M.webhookAccepted);
		metrics.observeMs(M.webhookAckMs, Date.now() - startedAt);
		// cid = webhookId ties this ack to the worker's later processing lines.
		log('trace', 'webhook.accepted', { cid: webhookId, topic, result });
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
