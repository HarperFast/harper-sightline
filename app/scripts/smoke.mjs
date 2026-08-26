// Post-deploy staging smoke test (#24/#25). Guards the "component healthy but no
// routes registered" failure mode (ADR-001) and exercises the read/auth/webhook
// surfaces. Exits non-zero on any miss so it can gate a deploy.
//   SIGHTLINE_BASE=https://<host> \
//   SHOPIFY_API_SECRET=<app secret> SHOPIFY_API_KEY=<client id> \
//   NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/smoke.mjs
// Without SHOPIFY_API_SECRET/KEY the authenticated + signed-webhook checks are
// skipped (the unauthenticated subset still runs). SMOKE_WEBHOOK=1 opts in to a
// signed webhook round-trip (writes a synthetic delivery — staging only), and
// SMOKE_RATE_LIMIT=1 opts in to the export rate-limit check (single-node targets
// only — see the comment at that check).
import { createHmac } from 'node:crypto';

process.env.NODE_TLS_REJECT_UNAUTHORIZED ??= '0';
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
		// `body` stays truncated for log lines; `bodyFull` is for callers that need
		// to parse the response (a truncated JSON body is not parseable).
		return { status: r.status, body: text.slice(0, 200).replace(/\n/g, ' '), bodyFull: text };
	} catch (e) {
		return { status: 0, body: e.code ?? e.message, bodyFull: '' };
	}
}

// A Shopify session JWT signed with the app secret (matches verifySessionToken).
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

// ── unauthenticated surface ───────────────────────────────────────────────────
const health = await req('/api/v1/health');
check('GET /api/v1/health = 200', health.status === 200, `${health.status} ${health.body}`);

const noAuth = await req('/api/v1/session');
check('GET /api/v1/session unauthenticated = 401', noAuth.status === 401, String(noAuth.status));

// The App Store listing links to this and a reviewer reads it WITHOUT installing,
// so it must be 200 unauthenticated. Also guards the silent-404 failure mode: an
// unregistered resource falls through to the SPA catch-all and returns 200 HTML,
// so assert on the content, not just the status.
const policy = await req('/privacy-policy');
check(
	'GET /privacy-policy unauthenticated = 200 and is the policy',
	policy.status === 200 && /Privacy Policy/i.test(policy.body) && !/__SIGHTLINE_SESSION__|shopify-api-key/.test(policy.body),
	`${policy.status} ${policy.body.slice(0, 120)}`,
);

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

	// Opt-in: prove the per-shop export limit is real on the deployed instance
	// (security review F7). Opt-in, and not part of the default gate, for one
	// reason: the counters are per WORKER PROCESS, and a Fabric cluster puts several
	// behind one hostname — round-robined requests would each be counted by a
	// different node, so the trip point is limit x nodes and a default-on check would
	// fail spuriously on a multi-node target. Set SMOKE_RATE_LIMIT=1 against a
	// single-node instance to verify it end to end.
	//
	// Uses a throwaway shop domain: a verified token is all the limiter keys on, the
	// export reads an empty ledger, and no row is written — so this cannot burn the
	// real smoke shop's budget for the next run, or leave anything behind.
	if (process.env.SMOKE_RATE_LIMIT === '1') {
		const rateShop = `sightline-smoke-rate-${Date.now().toString(36)}.myshopify.com`;
		const rateAuth = { 'X-Shopify-Session-Token': mintSessionToken(rateShop) };
		const statuses = [];
		for (let i = 0; i < 13; i++) {
			const r = await req('/api/v1/export/findings.csv', { headers: rateAuth });
			statuses.push(r.status);
			if (r.status === 429) break;
		}
		const limited = statuses.includes(429);
		check('GET /api/v1/export repeated = 429 once the per-shop limit is spent', limited, `statuses ${statuses.join(',')}`);
		// 429, never 401 — the SPA turns a 401 into "your session expired,
		// reauthorize", which would send a throttled merchant into a loop.
		check('rate-limited export is not reported as an expired session', !statuses.includes(401), `statuses ${statuses.join(',')}`);
	}

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

	// ── app/uninstalled round-trip (app-store-review-checklist §1) ────────────────
	// Shopify's reviewer WILL uninstall the app, and uninstall is the one lifecycle
	// path that revokes the offline token and stops all Admin API work, so a
	// regression here is both a review failure and a "kept a credential we have no
	// right to" problem. Opt-in because it writes state, and it uses a shop domain
	// unique to this run: ensureShopRecord only creates a shop when one is missing,
	// so re-running against a fixed domain would start from an already-uninstalled
	// shop and assert nothing. Leaves one uninstalled Shop row per run (staging).
	if (process.env.SMOKE_UNINSTALL === '1') {
		const uninstallShopDomain = `sightline-smoke-uninstall-${Date.now().toString(36)}.myshopify.com`;
		const uninstallAuth = { 'X-Shopify-Session-Token': mintSessionToken(uninstallShopDomain) };

		// Session bootstraps the shop record as active — the state uninstall must clear.
		const bootstrapped = await req('/api/v1/session', { headers: uninstallAuth });
		check('uninstall: session bootstraps the throwaway shop = 200', bootstrapped.status === 200, String(bootstrapped.status));

		const before = await req('/api/v1/setup', { headers: uninstallAuth });
		let installedBefore = false;
		try {
			installedBefore = JSON.parse(before.bodyFull ?? before.body).installed === true;
		} catch {
			// fall through — reported by the check below
		}
		check('uninstall: shop reads as installed before the webhook', installedBefore, before.body.slice(0, 120));

		const ubody = JSON.stringify({ shop_domain: uninstallShopDomain, smoke: true });
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

		// Uninstall is applied by the background processing loop, not at ack time
		// (ADR-002), so poll rather than assume. The loop ticks every 10s.
		const deadline = Date.now() + Number(process.env.SMOKE_UNINSTALL_TIMEOUT_MS ?? 90_000);
		let installedAfter = true;
		let lastBody = '';
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 5000));
			const after = await req('/api/v1/setup', { headers: uninstallAuth });
			lastBody = after.body;
			try {
				installedAfter = JSON.parse(after.bodyFull ?? after.body).installed !== false;
			} catch {
				installedAfter = true;
			}
			if (!installedAfter) break;
		}
		check('uninstall: shop is no longer installed once the delivery is processed', !installedAfter, lastBody.slice(0, 160));
	}
} else {
	console.log('skip authenticated + signed-webhook checks (set SHOPIFY_API_SECRET to enable)');
}

console.log(ok ? 'SMOKE PASS' : 'SMOKE FAIL');
process.exit(ok ? 0 : 1);
