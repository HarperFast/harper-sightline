// Post-deploy staging smoke test (#24/#25). Guards the "component healthy but no
// routes registered" failure mode (ADR-001) and exercises the read/auth/webhook
// surfaces. Exits non-zero on any miss so it can gate a deploy.
//   SIGHTLINE_BASE=https://<host> \
//   SHOPIFY_API_SECRET=<app secret> SHOPIFY_API_KEY=<client id> \
//   NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/smoke.mjs
// Without SHOPIFY_API_SECRET/KEY the authenticated + signed-webhook checks are
// skipped (the unauthenticated subset still runs). SMOKE_WEBHOOK=1 opts in to a
// signed webhook round-trip (writes a synthetic delivery — staging only).
import { createHmac } from 'node:crypto';

process.env.NODE_TLS_REJECT_UNAUTHORIZED ??= '0';
const base = process.env.SIGHTLINE_BASE ?? 'https://ayoo.josh-test.harperfabric.com';
const secret = process.env.SHOPIFY_API_SECRET;
const apiKey = process.env.SHOPIFY_API_KEY ?? 'e446bda5edb3ee3bae6e0ba280ef8b12';
const smokeShop = process.env.SMOKE_SHOP ?? 'sightline-smoke.myshopify.com';

let ok = true;
const b64url = (buf) => Buffer.from(buf).toString('base64url');

function check(label, pass, detail = '') {
	console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -> ${detail}` : ''}`);
	if (!pass) ok = false;
}

async function req(path, { method = 'GET', headers = {}, body } = {}) {
	const opts = { method, headers };
	if (body !== undefined) opts.body = body;
	try {
		const r = await fetch(`${base}${path}`, opts);
		return { status: r.status, body: (await r.text()).slice(0, 200).replace(/\n/g, ' ') };
	} catch (e) {
		return { status: 0, body: e.code ?? e.message };
	}
}

// A Shopify session JWT signed with the app secret (matches verifySessionToken).
function mintSessionToken() {
	const now = Math.floor(Date.now() / 1000);
	const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
	const claims = b64url(
		JSON.stringify({
			iss: `https://${smokeShop}/admin`,
			dest: `https://${smokeShop}`,
			aud: apiKey,
			sub: '0',
			exp: now + 60,
			nbf: now - 5,
			iat: now - 5,
			jti: 'smoke',
			sid: 'smoke',
		}),
	);
	const sig = createHmac('sha256', secret).update(`${header}.${claims}`).digest('base64url');
	return `${header}.${claims}.${sig}`;
}

// ── unauthenticated surface ───────────────────────────────────────────────────
const health = await req('/api/v1/health');
check('GET /api/v1/health = 200', health.status === 200, `${health.status} ${health.body}`);

const noAuth = await req('/api/v1/session');
check('GET /api/v1/session unauthenticated = 401', noAuth.status === 401, String(noAuth.status));

// Webhook ingress rejects a bad HMAC with 401 and NO mutation (constant-time verify).
const badHmac = await req('/webhooks/shopify/events', {
	method: 'POST',
	headers: {
		'content-type': 'application/json',
		'x-shopify-hmac-sha256': 'AAAA',
		'x-shopify-shop-domain': smokeShop,
		'x-shopify-webhook-id': `smoke-bad-${Date.now()}`,
		'x-shopify-topic': 'orders/updated',
	},
	body: '{}',
});
check('POST /webhooks/shopify/events bad HMAC = 401', badHmac.status === 401, String(badHmac.status));

// ── authenticated surface (needs the app secret) ──────────────────────────────
if (secret) {
	const token = mintSessionToken();
	const auth = { 'X-Shopify-Session-Token': token };

	const session = await req('/api/v1/session', { headers: auth });
	check('GET /api/v1/session authenticated = 200', session.status === 200, `${session.status} ${session.body}`);

	const setup = await req('/api/v1/setup', { headers: auth });
	check('GET /api/v1/setup authenticated = 200', setup.status === 200, `${setup.status} ${setup.body}`);

	const summary = await req('/api/v1/summary', { headers: auth });
	check('GET /api/v1/summary authenticated = 200', summary.status === 200, String(summary.status));

	const privacy = await req('/api/v1/privacy', { headers: auth });
	check('GET /api/v1/privacy authenticated = 200', privacy.status === 200, String(privacy.status));

	const findings = await req('/api/v1/findings', { headers: auth });
	check('GET /api/v1/findings authenticated = 200', findings.status === 200, String(findings.status));

	// Opt-in signed webhook round-trip (writes a synthetic delivery — staging only).
	if (process.env.SMOKE_WEBHOOK === '1') {
		const wbody = JSON.stringify({ id: 9_900_000_000_000, updated_at: new Date(0).toISOString(), smoke: true });
		const hmac = createHmac('sha256', secret).update(Buffer.from(wbody, 'utf8')).digest('base64');
		const accepted = await req('/webhooks/shopify/events', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-shopify-hmac-sha256': hmac,
				'x-shopify-shop-domain': smokeShop,
				'x-shopify-webhook-id': `smoke-ok-${Date.now()}`,
				'x-shopify-topic': 'orders/updated',
			},
			body: wbody,
		});
		check('POST /webhooks/shopify/events signed = 2xx', accepted.status >= 200 && accepted.status < 300, String(accepted.status));
	}
} else {
	console.log('skip authenticated + signed-webhook checks (set SHOPIFY_API_SECRET to enable)');
}

console.log(ok ? 'SMOKE PASS' : 'SMOKE FAIL');
process.exit(ok ? 0 : 1);
