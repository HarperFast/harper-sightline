// Seed a dev store's Sightline tables with orders in every state the UI can show.
//
// HOW IT WORKS, AND WHY THIS WAY
// ------------------------------
// This does NOT write projections or findings. It writes raw `WebhookDelivery`
// rows with `status: 'accepted'` — exactly what the webhook ingress would have
// written — and lets the running component do the rest. jobs.ts's processing
// loop picks up accepted deliveries, normalizes them, folds them into
// OrderProjection, indexes SKUs, and the detector loop then produces findings.
//
// So every number and lane the UI shows is genuinely derived by the real
// pipeline. Hand-writing projections would let the seed contain combinations the
// reducer can never actually produce, which is worse than no test data: the
// views would be verified against a fiction.
//
// USAGE
//   # validate offline — no credentials, no network, nothing written:
//   node seed-dev-data.mjs --dry-run --shop=my-store.myshopify.com
//
//   # write to a live instance:
//   HARPER_OPS_URL=https://<host>:9925/ HARPER_USER=... HARPER_PASS=... \
//     node seed-dev-data.mjs --shop=my-store.myshopify.com
//
// The dry run pipes every generated payload through the REAL normalizer and
// reducer (src/normalize.ts, src/projection.ts, src/orders.ts) and asserts each
// order lands in the lane and age bucket it was designed for. It exits non-zero
// on any mismatch, so a payload that would not produce the intended state is
// caught before anything touches the cluster.
//
// Run it from `app/` so the relative imports resolve.

import { normalizeDelivery } from '../src/normalize.ts';
import { rebuildProjection } from '../src/projection.ts';
import { deriveOrderLane, ageBucketKey, ageHours } from '../src/orders.ts';
import { FULFILLMENT_DEADLINE_MS } from '../src/detector.ts';

// ─── args ─────────────────────────────────────────────────────────────────────

const args = new Map(
	process.argv.slice(2).map((a) => {
		const [k, v] = a.replace(/^--/, '').split('=');
		return [k, v ?? true];
	}),
);
const DRY_RUN = Boolean(args.get('dry-run'));
const SHOP = String(args.get('shop') ?? process.env.SHOP_DOMAIN ?? '');
if (!SHOP) {
	console.error('need --shop=<domain>.myshopify.com (or SHOP_DOMAIN)');
	process.exit(2);
}

const NOW = Date.now();
const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();
const hoursAgo = (h) => NOW - h * HOUR;

// ─── the catalogue ────────────────────────────────────────────────────────────
//
// Each spec declares the state it is MEANT to produce. The dry run checks that
// claim against the real reducer, so these comments cannot quietly go stale.
//
// Ages are chosen to land in specific aging buckets. The confirmation detector's
// deadline is FULFILLMENT_DEADLINE_MS (72h), so anything paid longer ago than
// that and still unfulfilled will produce a `fulfillment_confirmation` finding
// once the detector loop runs.

const DEADLINE_H = FULFILLMENT_DEADLINE_MS / HOUR;

let seq = 1000;
const nextOrder = () => {
	seq += 1;
	return { id: String(7518851000000 + seq), name: `#${seq}` };
};

/** A shipping line item: counts toward fulfillableItemCount. */
const shipItem = (sku, qty = 1) => ({
	sku,
	quantity: qty,
	fulfillable_quantity: qty,
	requires_shipping: true,
});

/** A digital line item: requires_shipping false, so it never counts. */
const digitalItem = (sku, qty = 1) => ({
	sku,
	quantity: qty,
	fulfillable_quantity: 0,
	requires_shipping: false,
});

const SKUS = ['SIGHT-TEE-BLK-M', 'SIGHT-TEE-BLK-L', 'SIGHT-MUG-01', 'SIGHT-CAP-NVY', 'SIGHT-STICKER-PK'];
const LOCATIONS = ['61234567890', '61234567891'];
const CARRIERS = ['UPS', 'USPS', 'DHL eCommerce'];

/**
 * The spec list. `lane` and `bucket` are assertions the dry run verifies.
 * `findings` documents what the detector should later produce — the dry run
 * checks the preconditions for it, since the detector itself runs in-cluster.
 */
const SPECS = [
	// ── awaiting confirmation, one per aging bucket ───────────────────────────
	// The worklist's reason for existing. Four buckets: <24h, 24-48, 48-72, >72.
	// Enough of these that the unfiltered worklist runs past one page, so keyset
	// pagination and the cursor get exercised rather than just the first screen.
	...[2, 6, 9, 14, 17, 20, 23].map((h) => ({ lane: 'awaiting', bucket: 'under24', paidH: h, items: [shipItem(SKUS[0], 2)] })),
	...[26, 30, 33, 38, 44, 47].map((h) => ({ lane: 'awaiting', bucket: 'h24to48', paidH: h, items: [shipItem(SKUS[1])] })),
	...[50, 54, 58, 63, 70].map((h) => ({ lane: 'awaiting', bucket: 'h48to72', paidH: h, items: [shipItem(SKUS[2], 3)] })),
	// Past the 72h deadline → these are the ones that produce findings.
	...[80, 96, 120, 168].map((h) => ({
		lane: 'awaiting',
		bucket: 'over72',
		paidH: h,
		items: [shipItem(SKUS[0]), shipItem(SKUS[3])],
		findings: ['fulfillment_confirmation'],
	})),

	// ── a failed fulfillment attempt: a PRESENCE, not an absence ──────────────
	// Shopify itself recorded status 'error'/'failure'. The order stays awaiting
	// (a failed attempt is a finding about it, not a lane of its own), so these
	// also appear in the worklist.
	{
		lane: 'awaiting',
		bucket: 'over72',
		paidH: 90,
		items: [shipItem(SKUS[1], 2)],
		attemptFailed: 'failure',
		findings: ['fulfillment_confirmation', 'fulfillment_attempt_failed'],
	},
	{
		lane: 'awaiting',
		bucket: 'h48to72',
		paidH: 60,
		items: [shipItem(SKUS[2])],
		attemptFailed: 'error',
		findings: ['fulfillment_attempt_failed'],
	},

	// ── fulfilled, with and without tracking ─────────────────────────────────
	...[4, 30, 52, 100].map((h, i) => ({
		lane: 'fulfilled',
		paidH: h,
		items: [shipItem(SKUS[i % SKUS.length], 1 + (i % 2))],
		fulfilledH: Math.max(1, h - 3),
		tracking: i % 2 === 0 ? CARRIERS[i % CARRIERS.length] : undefined,
	})),
	// Fulfilled only AFTER the deadline: the detector should have opened a
	// finding and then resolved it. Exercises the resolved state on Findings.
	{
		lane: 'fulfilled',
		paidH: 140,
		items: [shipItem(SKUS[4], 5)],
		fulfilledH: 20,
		tracking: CARRIERS[0],
		findings: ['fulfillment_confirmation(resolved)'],
	},

	// ── digital: no fulfillment is ever expected ──────────────────────────────
	// requires_shipping false everywhere, so requiresFulfillment is never
	// latched. Must NOT read as "fulfilled" and must NOT produce a finding.
	...[8, 40, 90].map((h) => ({ lane: 'no_fulfillment_expected', paidH: h, items: [digitalItem(SKUS[4], 1)] })),

	// ── unpaid ────────────────────────────────────────────────────────────────
	...[3, 26].map((h) => ({ lane: 'unpaid', createdH: h, items: [shipItem(SKUS[0])], unpaid: true })),

	// ── cancelled ─────────────────────────────────────────────────────────────
	{ lane: 'cancelled', paidH: 48, cancelledH: 40, items: [shipItem(SKUS[1], 2)] },
	{ lane: 'cancelled', paidH: 96, cancelledH: 90, items: [shipItem(SKUS[0]), shipItem(SKUS[4], 2)] },
	// Cancelled BEFORE payment. This reads as `unpaid`, not `cancelled` — and
	// that is deliberate, not a bug: deriveOrderLane checks paidAt first, on the
	// stated rule that "an unpaid order is unpaid regardless of anything else"
	// (src/orders.ts). Kept in the seed precisely because it is the surprising
	// case, and worth having on screen to judge whether that ordering reads right.
	{ lane: 'unpaid', createdH: 30, cancelledH: 28, items: [shipItem(SKUS[3])], unpaid: true },

	// ── refunded ──────────────────────────────────────────────────────────────
	...[36, 96].map((h) => ({ lane: 'refunded', paidH: h, refundedH: Math.max(1, h - 10), items: [shipItem(SKUS[2], 2)] })),
];

// ─── payload builders ─────────────────────────────────────────────────────────

let webhookSeq = 0;
const deliveries = [];

function pushDelivery(topic, payload, receivedAt) {
	webhookSeq += 1;
	const webhookId = `seed-${NOW}-${String(webhookSeq).padStart(4, '0')}`;
	deliveries.push({
		id: `${SHOP}:${webhookId}`,
		shopId: SHOP,
		topic,
		webhookId,
		receivedAt,
		status: 'accepted',
		attempts: 0,
		hmacVerified: true,
		// The ingress stores the PII-stripped body; include_fields in
		// shopify.app.toml already excludes customer data, and nothing here
		// invents any.
		payload: JSON.stringify(payload),
	});
}

const money = (n) => n.toFixed(2);

function buildOrder(spec) {
	const { id, name } = nextOrder();
	const createdH = spec.createdH ?? spec.paidH ?? 1;
	const createdAt = hoursAgo(createdH);
	const total = 12.5 + (seq % 7) * 9.25;
	const currency = 'USD';

	const base = {
		id,
		admin_graphql_api_id: `gid://shopify/Order/${id}`,
		name,
		order_number: seq,
		created_at: iso(createdAt),
		currency,
		total_price: money(total),
		current_total_price: money(total),
		line_items: spec.items,
	};

	// orders/create — always, so the recorder sees the order exist.
	pushDelivery(
		'orders/create',
		{ ...base, updated_at: iso(createdAt), financial_status: 'pending', fulfillment_status: null },
		createdAt,
	);

	// orders/paid — unless the order is meant to stay unpaid.
	if (!spec.unpaid) {
		const paidAt = hoursAgo(spec.paidH ?? createdH);
		pushDelivery(
			'orders/paid',
			{ ...base, updated_at: iso(paidAt), processed_at: iso(paidAt), financial_status: 'paid', fulfillment_status: null },
			paidAt,
		);
	}

	// A failed fulfillment attempt Shopify itself recorded.
	if (spec.attemptFailed) {
		const at = hoursAgo(Math.max(1, (spec.paidH ?? 2) - 2));
		pushDelivery(
			'fulfillments/create',
			{
				id: `${id}-f-fail`,
				order_id: id,
				status: spec.attemptFailed, // 'error' | 'failure'
				shipment_status: null,
				location_id: LOCATIONS[0],
				created_at: iso(at),
				updated_at: iso(at),
				line_items: spec.items,
			},
			at,
		);
	}

	// A successful fulfillment.
	if (spec.fulfilledH !== undefined) {
		const at = hoursAgo(spec.fulfilledH);
		pushDelivery(
			'fulfillments/create',
			{
				id: `${id}-f-ok`,
				order_id: id,
				status: 'success',
				shipment_status: spec.tracking ? 'in_transit' : null,
				location_id: LOCATIONS[seq % LOCATIONS.length],
				created_at: iso(at),
				updated_at: iso(at),
				tracking_company: spec.tracking,
				tracking_numbers: spec.tracking ? [`1Z${seq}SEED`] : [],
				line_items: spec.items,
			},
			at,
		);
		pushDelivery(
			'orders/updated',
			{ ...base, updated_at: iso(at), financial_status: 'paid', fulfillment_status: 'fulfilled' },
			at,
		);
	}

	// A refund making the order fully refunded.
	if (spec.refundedH !== undefined) {
		const at = hoursAgo(spec.refundedH);
		pushDelivery(
			'refunds/create',
			{
				id: `${id}-r`,
				order_id: id,
				created_at: iso(at),
				processed_at: iso(at),
				refund_line_items: spec.items.map((li) => ({ quantity: li.quantity, line_item: { sku: li.sku } })),
				transactions: [{ amount: money(total), currency }],
			},
			at,
		);
		pushDelivery(
			'orders/updated',
			{ ...base, updated_at: iso(at), financial_status: 'refunded', fulfillment_status: null },
			at,
		);
	}

	// A cancellation.
	if (spec.cancelledH !== undefined) {
		const at = hoursAgo(spec.cancelledH);
		pushDelivery(
			'orders/cancelled',
			{
				...base,
				updated_at: iso(at),
				cancelled_at: iso(at),
				financial_status: spec.unpaid ? 'voided' : 'paid',
				fulfillment_status: null,
			},
			at,
		);
	}

	return { id, name, spec };
}

const orders = SPECS.map(buildOrder);

// Inventory movements, so the Events view's inventory domain and SKU column
// have something in them. These carry no order linkage by design — inventory
// events key on inventory_item_id, which is why redaction treats them as
// non-order-linked.
for (let i = 0; i < 6; i += 1) {
	const at = hoursAgo(2 + i * 7);
	pushDelivery(
		'inventory_levels/update',
		{
			inventory_item_id: String(49876543210 + i),
			location_id: LOCATIONS[i % LOCATIONS.length],
			available: 40 - i * 3,
			updated_at: iso(at),
		},
		at,
	);
}

// ─── dry run: prove the payloads produce the intended states ──────────────────

function verify() {
	const byOrder = new Map();
	let normalized = 0;

	for (const d of deliveries) {
		const meta = { shopId: d.shopId, topic: d.topic, webhookId: d.webhookId, receivedAt: d.receivedAt };
		const events = normalizeDelivery(meta, JSON.parse(d.payload));
		normalized += events.length;
		for (const e of events) {
			// The reducer keys on the order id; inventory events aren't order-linked.
			if (e.domain === 'inventory' || !e.resourceId) continue;
			const list = byOrder.get(e.resourceId) ?? [];
			list.push({ ...e, shopId: SHOP, eventId: `${SHOP}:${d.webhookId}:${list.length}` });
			byOrder.set(e.resourceId, list);
		}
	}

	const problems = [];
	const laneCounts = {};
	const bucketCounts = {};
	let expectedFindings = 0;

	for (const { id, name, spec } of orders) {
		const events = byOrder.get(id) ?? [];
		// Shuffle: the reducer is meant to be commutative, so a correct seed must
		// produce the same lane regardless of arrival order. This catches a spec
		// that only works because the events happen to arrive in a tidy sequence.
		const shuffled = [...events].sort((a, b) => (a.eventId < b.eventId ? 1 : -1));
		const projection = rebuildProjection(shuffled);
		if (!projection) {
			problems.push(`${name}: produced no projection at all`);
			continue;
		}
		const lane = deriveOrderLane(projection);
		laneCounts[lane] = (laneCounts[lane] ?? 0) + 1;

		if (lane !== spec.lane) problems.push(`${name}: intended lane ${spec.lane}, reducer says ${lane}`);

		if (spec.bucket) {
			const bucket = ageBucketKey(projection.paidAt, NOW);
			bucketCounts[bucket] = (bucketCounts[bucket] ?? 0) + 1;
			if (bucket !== spec.bucket) problems.push(`${name}: intended bucket ${spec.bucket}, got ${bucket}`);
		}

		// Precondition for the confirmation detector: awaiting, and paid longer
		// ago than the deadline. The detector itself runs in-cluster.
		if (spec.findings?.some((f) => f.startsWith('fulfillment_confirmation'))) {
			const age = ageHours(projection.paidAt, NOW) ?? 0;
			if (spec.findings.includes('fulfillment_confirmation') && age <= DEADLINE_H) {
				problems.push(`${name}: expected a confirmation finding but it is only ${age}h old (deadline ${DEADLINE_H}h)`);
			}
			expectedFindings += 1;
		}
		if (spec.findings?.includes('fulfillment_attempt_failed')) {
			if (projection.fulfillmentFailedAt === undefined) {
				problems.push(`${name}: expected a failed-attempt finding but no failure was latched`);
			}
			expectedFindings += 1;
		}
	}

	console.log(`shop:            ${SHOP}`);
	console.log(`orders:          ${orders.length}`);
	console.log(`deliveries:      ${deliveries.length}`);
	console.log(`events produced: ${normalized}`);
	console.log(`\nlanes:   ${JSON.stringify(laneCounts)}`);
	console.log(`buckets: ${JSON.stringify(bucketCounts)}`);
	console.log(`findings the detector should open: ${expectedFindings}`);

	if (problems.length) {
		console.error(`\n${problems.length} problem(s):`);
		for (const p of problems) console.error(`  - ${p}`);
		return false;
	}
	console.log('\nevery order lands in the lane and bucket it was designed for, under shuffled event order.');
	return true;
}

const ok = verify();
if (!ok) process.exit(1);
if (DRY_RUN) {
	console.log('\ndry run — nothing written.');
	process.exit(0);
}

// ─── live insert ──────────────────────────────────────────────────────────────

process.env.NODE_TLS_REJECT_UNAUTHORIZED ??= '0';
const { HARPER_OPS_URL, HARPER_USER, HARPER_PASS } = process.env;
if (!HARPER_OPS_URL || !HARPER_USER || !HARPER_PASS) {
	console.error('\nset HARPER_OPS_URL, HARPER_USER, HARPER_PASS (or pass --dry-run)');
	process.exit(2);
}
const auth = 'Basic ' + Buffer.from(`${HARPER_USER}:${HARPER_PASS}`).toString('base64');

async function op(body) {
	const res = await fetch(HARPER_OPS_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: auth },
		body: JSON.stringify(body),
	});
	const text = await res.text();
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

const BATCH = 50;
for (let i = 0; i < deliveries.length; i += BATCH) {
	const records = deliveries.slice(i, i + BATCH);
	const result = await op({
		operation: 'insert',
		database: 'sightline_ledger',
		table: 'WebhookDelivery',
		records,
	});
	console.log(`inserted ${i + records.length}/${deliveries.length}`, JSON.stringify(result).slice(0, 200));
}

console.log(`
Done. The component does the rest:
  - the processing loop (runs every ~30s) normalizes these into OperationalEvent
    and folds them into OrderProjection
  - the detector loop (every ~15m) then opens findings for anything past the
    ${DEADLINE_H}h confirmation deadline, and for the recorded failed attempts
  - the state backfill gives older projections their lane

Watch for 'process.batch' then 'detect.' log lines, and give it a few minutes
before judging the Findings view. Re-running this script is safe: delivery ids
are unique per run, so it adds data rather than replacing it.
`);
