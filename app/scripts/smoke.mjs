// Post-deploy staging smoke test. Guards the "component healthy but no routes
// registered" failure (ADR-001) and exercises the read, auth and webhook surfaces.
// Exits non-zero on any miss so it can gate a deploy.
//   SIGHTLINE_BASE=https://<host> \
//   SHOPIFY_API_SECRET=<app secret> SHOPIFY_API_KEY=<client id> \
//   node scripts/smoke.mjs
// TLS is verified; a self-signed host needs an explicit NODE_TLS_REJECT_UNAUTHORIZED=0.
// Without SHOPIFY_API_SECRET/KEY the authenticated + signed-webhook checks are
// skipped (the unauthenticated subset still runs). SMOKE_WEBHOOK=1 opts in to a
// signed webhook round-trip (writes a synthetic delivery — staging only), and
// SMOKE_RATE_LIMIT=1 opts in to the 429-is-not-401 check on a throttled export.
import { createHmac } from 'node:crypto';
import { installedFromSetup } from './smokeSetup.mjs';

const base = process.env.SIGHTLINE_BASE ?? 'https://ayoo.josh-test.harperfabric.com';
const secret = process.env.SHOPIFY_API_SECRET;
const apiKey = process.env.SHOPIFY_API_KEY ?? 'e446bda5edb3ee3bae6e0ba280ef8b12';
const smokeShop = process.env.SMOKE_SHOP ?? 'sightline-smoke.myshopify.com';
const defaultSmokeShop = smokeShop;

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
		const text = await r.text();
		// `body` is truncated for logs; `bodyFull` is for callers that parse the response.
		return { status: r.status, body: text.slice(0, 200).replace(/\n/g, ' '), bodyFull: text };
	} catch (e) {
		return { status: 0, body: e.code ?? e.message, bodyFull: '' };
	}
}

// A session JWT signed with the app secret (matches verifySessionToken).
function mintSessionToken(smokeShop = defaultSmokeShop) {
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

const health = await req('/api/v1/health');
check('GET /api/v1/health = 200', health.status === 200, `${health.status} ${health.body}`);

const noAuth = await req('/api/v1/session');
check('GET /api/v1/session unauthenticated = 401', noAuth.status === 401, String(noAuth.status));

// A reviewer reads this without installing, so it must be 200 unauthenticated.
// Assert on the content: an unregistered resource falls through to the SPA
// catch-all and returns 200 HTML.
const policy = await req('/privacy-policy');
check(
	'GET /privacy-policy unauthenticated = 200 and is the policy',
	policy.status === 200 && /Privacy Policy/i.test(policy.body) && !/__SIGHTLINE_SESSION__|shopify-api-key/.test(policy.body),
	`${policy.status} ${policy.body.slice(0, 120)}`,
);

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

	// Opt-in: a throttled export must be a 429, never a 401 (the SPA turns a 401 into
	// "reauthorize"). Counters are per worker thread, so no run can prove the limit
	// exists; this asserts only what holds under any distribution. Uses a throwaway
	// shop domain so it cannot burn the real smoke shop's budget.
	if (process.env.SMOKE_RATE_LIMIT === '1') {
		const rateShop = `sightline-smoke-rate-${Date.now().toString(36)}.myshopify.com`;
		const rateAuth = { 'X-Shopify-Session-Token': mintSessionToken(rateShop) };
		const statuses = [];
		for (let i = 0; i < 13; i++) {
			const r = await req('/api/v1/export/findings.csv', { headers: rateAuth });
			statuses.push(r.status);
			if (r.status === 429) break;
		}
		check('rate-limited export is not reported as an expired session', !statuses.includes(401), `statuses ${statuses.join(',')}`);
		check(
			'exports are 200 or 429 only',
			statuses.every((s) => s === 200 || s === 429),
			`statuses ${statuses.join(',')}`,
		);
	}

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

	// app/uninstalled round-trip (app-store-review-checklist §1): uninstall revokes the
	// offline token and stops Admin API work, and a reviewer will do it. Opt-in because
	// it writes state, with a shop domain unique to this run (ensureShopRecord only
	// creates a missing shop, so a fixed domain would start already uninstalled).
	// Leaves one uninstalled Shop row per run (staging).
	if (process.env.SMOKE_UNINSTALL === '1') {
		const uninstallShopDomain = `sightline-smoke-uninstall-${Date.now().toString(36)}.myshopify.com`;
		const uninstallAuth = { 'X-Shopify-Session-Token': mintSessionToken(uninstallShopDomain) };

		const bootstrapped = await req('/api/v1/session', { headers: uninstallAuth });
		check('uninstall: session bootstraps the throwaway shop = 200', bootstrapped.status === 200, String(bootstrapped.status));

		const before = await req('/api/v1/setup', { headers: uninstallAuth });
		check('uninstall: shop reads as installed before the webhook', installedFromSetup(before.bodyFull) === true, before.body.slice(0, 120));

		const ubody = JSON.stringify({ myshopify_domain: uninstallShopDomain, smoke: true });
		const uhmac = createHmac('sha256', secret).update(Buffer.from(ubody, 'utf8')).digest('base64');
		const uninstallAck = await req('/webhooks/shopify/events', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-shopify-hmac-sha256': uhmac,
				'x-shopify-shop-domain': uninstallShopDomain,
				'x-shopify-webhook-id': `smoke-uninstall-${Date.now()}`,
				'x-shopify-topic': 'app/uninstalled',
			},
			body: ubody,
		});
		check(
			'uninstall: POST app/uninstalled signed = 2xx',
			uninstallAck.status >= 200 && uninstallAck.status < 300,
			String(uninstallAck.status),
		);

		// Uninstall is applied by the scheduled process job, not at ack time (ADR-002), so
		// poll. The job is leader-coordinated: a deploy restart can move leadership and a
		// failover takes ~5-6.5 minutes, so raise SMOKE_UNINSTALL_TIMEOUT_MS right after a deploy.
		const deadline = Date.now() + Number(process.env.SMOKE_UNINSTALL_TIMEOUT_MS ?? 90_000);
		let installedAfter = true;
		let lastBody = '';
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 5000));
			// A fresh token per poll: the 60 s session token would expire inside the window.
			const after = await req('/api/v1/setup', { headers: { 'X-Shopify-Session-Token': mintSessionToken(uninstallShopDomain) } });
			lastBody = after.body;
			// Only a readable "not installed" ends the wait; an error or a 401 keeps polling.
			installedAfter = installedFromSetup(after.bodyFull) !== false;
			if (!installedAfter) break;
		}
		check('uninstall: shop is no longer installed once the delivery is processed', !installedAfter, lastBody.slice(0, 160));
	}
} else {
	console.log('skip authenticated + signed-webhook checks (set SHOPIFY_API_SECRET to enable)');
}

console.log(ok ? 'SMOKE PASS' : 'SMOKE FAIL');
process.exit(ok ? 0 : 1);
