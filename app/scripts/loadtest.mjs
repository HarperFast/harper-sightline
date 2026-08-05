// Webhook ingress load harness (#24). Fires a burst of HMAC-signed webhooks at
// /webhooks/shopify/events and reports ack-latency percentiles + loss against the
// plan §13 gates. This is a MANUAL / staged tool — the production-like 10-minute
// 100 rps burst runs against the staged environment (#25), not in CI.
//
//   SIGHTLINE_BASE=https://<host> \
//   SHOPIFY_API_SECRET=<app secret> \
//   LOAD_RPS=100 LOAD_DURATION=600 \
//   NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/loadtest.mjs
//
// Gates (plan §13): ack p95 < 1000ms, ack max < 5000ms (Shopify's timeout), 0 loss.
import { createHmac } from 'node:crypto';

const base = process.env.SIGHTLINE_BASE ?? 'https://ayoo.josh-test.harperfabric.com';
const secret = process.env.SHOPIFY_API_SECRET;
const shop = process.env.LOAD_SHOP ?? 'load-test.myshopify.com';
const rps = Number(process.env.LOAD_RPS ?? 100);
const durationSec = Number(process.env.LOAD_DURATION ?? 60);
const topic = process.env.LOAD_TOPIC ?? 'orders/updated';

// Gates.
const P95_MS = 1000;
const MAX_MS = 5000;

if (!secret) {
	console.error('SHOPIFY_API_SECRET is required to sign webhooks. Refusing to run.');
	process.exit(2);
}
process.env.NODE_TLS_REJECT_UNAUTHORIZED ??= '0';

function sign(body) {
	return createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('base64');
}

// One signed webhook POST; returns { ms, status, ok }.
async function fireOne(seq) {
	// A minimal, PII-free order payload — the ingress only needs a valid body + headers.
	const body = JSON.stringify({ id: 5_000_000_000_000 + seq, updated_at: new Date(0).toISOString(), test: true });
	const headers = {
		'content-type': 'application/json',
		'x-shopify-hmac-sha256': sign(body),
		'x-shopify-shop-domain': shop,
		'x-shopify-webhook-id': `load-${Date.now().toString(36)}-${seq}`,
		'x-shopify-topic': topic,
	};
	const started = performance.now();
	try {
		const r = await fetch(`${base}/webhooks/shopify/events`, { method: 'POST', headers, body });
		await r.text();
		return { ms: performance.now() - started, status: r.status, ok: r.status >= 200 && r.status < 300 };
	} catch (e) {
		return { ms: performance.now() - started, status: 0, ok: false, err: e.code ?? e.message };
	}
}

function pct(sorted, p) {
	if (sorted.length === 0) return 0;
	const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[i];
}

async function main() {
	console.log(`Load: ${rps} rps for ${durationSec}s against ${base} (topic ${topic})`);
	const latencies = [];
	let sent = 0;
	let lost = 0;
	const statuses = new Map();

	for (let second = 0; second < durationSec; second++) {
		const tick = performance.now();
		const batch = [];
		for (let i = 0; i < rps; i++) batch.push(fireOne(sent + i));
		const results = await Promise.all(batch);
		sent += rps;
		for (const res of results) {
			latencies.push(res.ms);
			statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
			if (!res.ok) lost += 1;
		}
		// Pace to ~1s per batch (a burst then wait; never negative).
		const elapsed = performance.now() - tick;
		if (elapsed < 1000) await new Promise((r) => setTimeout(r, 1000 - elapsed));
		if ((second + 1) % 10 === 0) console.log(`  ${second + 1}/${durationSec}s sent=${sent} lost=${lost}`);
	}

	latencies.sort((a, b) => a - b);
	const p50 = pct(latencies, 50);
	const p95 = pct(latencies, 95);
	const max = latencies[latencies.length - 1] ?? 0;
	console.log('\n--- results ---');
	console.log(`sent=${sent} lost=${lost} statuses=${JSON.stringify(Object.fromEntries(statuses))}`);
	console.log(`ack latency ms: p50=${p50.toFixed(1)} p95=${p95.toFixed(1)} max=${max.toFixed(1)}`);

	const pass = lost === 0 && p95 < P95_MS && max < MAX_MS;
	console.log(
		`\nGATES: p95<${P95_MS} ${p95 < P95_MS ? 'PASS' : 'FAIL'} · max<${MAX_MS} ${max < MAX_MS ? 'PASS' : 'FAIL'} · loss=0 ${lost === 0 ? 'PASS' : 'FAIL'}`,
	);
	console.log(pass ? 'LOAD PASS' : 'LOAD FAIL');
	process.exit(pass ? 0 : 1);
}

await main();
