// Webhook ingress load harness. Fires a burst of HMAC-signed webhooks at
// /webhooks/shopify/events, then proves the accepted work drained. A manual,
// staged tool, not run in CI.
//
//   SIGHTLINE_BASE=https://<host> \
//   SHOPIFY_API_SECRET=<app secret> SIGHTLINE_OPS_TOKEN=<ops token> \
//   LOAD_RPS=100 LOAD_DURATION=600 \
//   NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/loadtest.mjs
//
// The drain phase exists because ack latency alone cannot fail (work is deferred,
// ADR-002); a run once printed LOAD PASS with every delivery accepted and none processed.
//
// Gates: ack p95 < 1s, ack max < 5s (Shopify's timeout), 0 rejected deliveries,
// the backlog returns to its pre-burst level, no new dead letters, and the
// observed drain rate keeps up with the offered rate.
import { createHmac } from 'node:crypto';

const base = process.env.SIGHTLINE_BASE ?? 'https://ayoo.josh-test.harperfabric.com';
const secret = process.env.SHOPIFY_API_SECRET;
const opsToken = process.env.SIGHTLINE_OPS_TOKEN;
const shop = process.env.LOAD_SHOP ?? 'load-test.myshopify.com';
const rps = Number(process.env.LOAD_RPS ?? 100);
const durationSec = Number(process.env.LOAD_DURATION ?? 60);
const topic = process.env.LOAD_TOPIC ?? 'orders/updated';
// How long to wait for the backlog to return to its pre-burst level; processing is periodic, so samples are coarse.
const drainTimeoutSec = Number(process.env.LOAD_DRAIN_TIMEOUT ?? 900);
const drainPollMs = Number(process.env.LOAD_DRAIN_POLL_MS ?? 5000);

const P95_MS = 1000;
const MAX_MS = 5000;

if (!secret) {
	console.error('SHOPIFY_API_SECRET is required to sign webhooks. Refusing to run.');
	process.exit(2);
}
// Refuse rather than degrade: without the backlog the harness could only re-report ack latency.
if (!opsToken) {
	console.error('SIGHTLINE_OPS_TOKEN is required to verify the burst drained. Refusing to run a drain-blind load test.');
	process.exit(2);
}
process.env.NODE_TLS_REJECT_UNAUTHORIZED ??= '0';

// Backlog and dead letters, cluster-wide (derived from replicated tables).
async function readOps() {
	const r = await fetch(`${base}/api/v1/ops`, { headers: { 'x-sightline-ops-token': opsToken } });
	if (r.status === 404) {
		throw new Error('/api/v1/ops returned 404 — SIGHTLINE_OPS_TOKEN is unset or too short (>= 32 chars) on the target instance');
	}
	if (!r.ok) throw new Error(`/api/v1/ops returned ${r.status}`);
	const health = await r.json();
	return { accepted: health.backlog.accepted, deadLetter: health.deadLetter.count, oldestAgeMs: health.backlog.oldestAgeMs };
}

function sign(body) {
	return createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('base64');
}

async function fireOne(seq) {
	// Minimal PII-free order payload; the ingress needs only a valid body and headers.
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

// Waits for the backlog to fall to its pre-burst level, sampling so the drain rate is measured.
async function waitForDrain(baselineAccepted) {
	const startedAt = performance.now();
	const samples = [];
	let drained = false;
	while ((performance.now() - startedAt) / 1000 < drainTimeoutSec) {
		const ops = await readOps();
		samples.push({ atSec: (performance.now() - startedAt) / 1000, ...ops });
		if (ops.accepted <= baselineAccepted) {
			drained = true;
			break;
		}
		const shown = samples.length;
		if (shown === 1 || shown % 6 === 0) {
			console.log(
				`  draining: backlog=${ops.accepted} (baseline ${baselineAccepted}) oldest=${ops.oldestAgeMs ?? 0}ms deadLetter=${ops.deadLetter}`,
			);
		}
		await new Promise((r) => setTimeout(r, drainPollMs));
	}
	return { drained, samples };
}

// Deliveries cleared per second between the first and last samples. `reason` matters:
// an unmeasurable rate because nothing was queued is a pass; one because the backlog
// never moved is the worst result and must not read as "kept up".
function drainProgress(samples, baselineAccepted) {
	if (samples.length === 0) return { rate: null, reason: 'no-samples' };
	const first = samples[0];
	if (first.accepted <= baselineAccepted) return { rate: null, reason: 'nothing-queued' };
	if (samples.length < 2) return { rate: null, reason: 'too-few-samples' };
	const last = samples[samples.length - 1];
	const cleared = first.accepted - last.accepted;
	const seconds = last.atSec - first.atSec;
	if (seconds <= 0) return { rate: null, reason: 'too-few-samples' };
	if (cleared <= 0) return { rate: 0, reason: 'no-progress' };
	return { rate: cleared / seconds, reason: 'measured' };
}

function describeDrainRate({ rate, reason }) {
	if (reason === 'nothing-queued') return 'n/a — processing kept up with ingest in real time, nothing queued';
	if (reason === 'no-progress') return `0/s vs ${rps}/s offered — the backlog did not move at all`;
	if (rate === null) return 'n/a — too few samples to measure';
	return `${rate.toFixed(1)}/s vs ${rps}/s offered`;
}

async function main() {
	console.log(`Load: ${rps} rps for ${durationSec}s against ${base} (topic ${topic})`);
	const baseline = await readOps();
	console.log(`pre-burst: backlog=${baseline.accepted} deadLetter=${baseline.deadLetter}`);
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

	console.log(`\nwaiting up to ${drainTimeoutSec}s for the backlog to return to ${baseline.accepted}...`);
	const { drained, samples } = await waitForDrain(baseline.accepted);
	const finalOps = samples.length > 0 ? samples[samples.length - 1] : await readOps();
	const drainSec = samples.length > 0 ? samples[samples.length - 1].atSec : 0;
	const progress = drainProgress(samples, baseline.accepted);
	const deadLetterDelta = finalOps.deadLetter - baseline.deadLetter;
	// A drain slower than ingest means the backlog grows without bound under sustained
	// load; only an empty queue is exempt.
	const keepsUp = progress.reason === 'nothing-queued' ? true : progress.rate !== null && progress.rate >= rps;

	console.log(
		`drain: ${drained ? `complete in ~${drainSec.toFixed(1)}s` : `INCOMPLETE — backlog still ${finalOps.accepted} after ${drainTimeoutSec}s`}`,
	);
	console.log(`drain rate: ${describeDrainRate(progress)}`);
	console.log(`dead letters: ${baseline.deadLetter} -> ${finalOps.deadLetter} (delta ${deadLetterDelta})`);

	const pass = lost === 0 && p95 < P95_MS && max < MAX_MS && drained && deadLetterDelta === 0 && keepsUp;
	console.log(
		[
			`\nGATES: p95<${P95_MS} ${p95 < P95_MS ? 'PASS' : 'FAIL'}`,
			`max<${MAX_MS} ${max < MAX_MS ? 'PASS' : 'FAIL'}`,
			`rejected=0 ${lost === 0 ? 'PASS' : 'FAIL'}`,
			`drained ${drained ? 'PASS' : 'FAIL'}`,
			`deadLetterDelta=0 ${deadLetterDelta === 0 ? 'PASS' : 'FAIL'}`,
			`drain>=offered ${keepsUp ? 'PASS' : 'FAIL'}`,
		].join(' · '),
	);
	console.log(pass ? 'LOAD PASS' : 'LOAD FAIL');
	process.exit(pass ? 0 : 1);
}

await main();
