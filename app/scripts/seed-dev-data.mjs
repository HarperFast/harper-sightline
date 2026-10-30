// Seeds a dev store with orders in every state the UI can show. It writes raw
// `WebhookDelivery` rows with `status: 'accepted'`, as the ingress would, and lets
// the running component derive projections and findings, so every number the UI
// shows comes from the real pipeline rather than a hand-written fiction.
//
//   # validate offline (no credentials, no network, nothing written):
//   node seed-dev-data.mjs --dry-run --shop=my-store.myshopify.com
//
//   # write to a live instance:
//   HARPER_OPS_URL=https://<host>:9925/ HARPER_USER=... HARPER_PASS=... \
//     node seed-dev-data.mjs --shop=my-store.myshopify.com
//
// The dry run pipes every payload through the real normalizer and reducer and
// asserts each order lands in its designed lane and age bucket, exiting non-zero
// on a mismatch. Run it from `app/` so the relative imports resolve.

import { normalizeDelivery } from '../src/ingest/normalize.ts';
import { rebuildProjection } from '../src/ingest/projection.ts';
import { deriveOrderLane, ageBucketKey, ageHours } from '../src/domain/orders.ts';
import { FULFILLMENT_DEADLINE_MS } from '../src/domain/detector.ts';

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

// Each spec declares the state it is meant to produce; the dry run checks it against
// the real reducer. Anything paid longer ago than FULFILLMENT_DEADLINE_MS (72h) and
// unfulfilled produces a `fulfillment_confirmation` finding.

const DEADLINE_H = FULFILLMENT_DEADLINE_MS / HOUR;

let seq = 1000;
const nextOrder = () => {
	seq += 1;
	return { id: String(7518851000000 + seq), name: `#${seq}` };
};

const shipItem = (sku, qty = 1) => ({
	sku,
	quantity: qty,
	fulfillable_quantity: qty,
	requires_shipping: true,
});

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
 * `lane` and `bucket` are verified by the dry run. `findings` documents what the
 * detector should later produce; the dry run checks only its preconditions.
 */
const SPECS = [
	// Awaiting confirmation, one per aging bucket (<24h, 24-48, 48-72, >72); enough
	// that the worklist runs past one page and exercises keyset pagination.
	...[2, 6, 9, 14, 17, 20, 23].map((h) => ({ lane: 'awaiting', bucket: 'under24', paidH: h, items: [shipItem(SKUS[0], 2)] })),
	...[26, 30, 33, 38, 44, 47].map((h) => ({ lane: 'awaiting', bucket: 'h24to48', paidH: h, items: [shipItem(SKUS[1])] })),
	...[50, 54, 58, 63, 70].map((h) => ({ lane: 'awaiting', bucket: 'h48to72', paidH: h, items: [shipItem(SKUS[2], 3)] })),
	...[80, 96, 120, 168].map((h) => ({
		lane: 'awaiting',
		bucket: 'over72',
		paidH: h,
		items: [shipItem(SKUS[0]), shipItem(SKUS[3])],
		findings: ['fulfillment_confirmation'],
	})),

	// A failed attempt Shopify recorded ('error'/'failure'): a presence. The order stays
	// awaiting, so it also appears in the worklist.
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

	...[4, 30, 52, 100].map((h, i) => ({
		lane: 'fulfilled',
		paidH: h,
		items: [shipItem(SKUS[i % SKUS.length], 1 + (i % 2))],
		fulfilledH: Math.max(1, h - 3),
		tracking: i % 2 === 0 ? CARRIERS[i % CARRIERS.length] : undefined,
	})),
	// Fulfilled only after the deadline: the detector opens a finding, then resolves it.
	{
		lane: 'fulfilled',
		paidH: 140,
		items: [shipItem(SKUS[4], 5)],
		fulfilledH: 20,
		tracking: CARRIERS[0],
		findings: ['fulfillment_confirmation(resolved)'],
	},

	// Digital: requires_shipping false everywhere, so it is never "fulfilled" and never produces a finding.
	...[8, 40, 90].map((h) => ({ lane: 'no_fulfillment_expected', paidH: h, items: [digitalItem(SKUS[4], 1)] })),

	...[3, 26].map((h) => ({ lane: 'unpaid', createdH: h, items: [shipItem(SKUS[0])], unpaid: true })),

	{ lane: 'cancelled', paidH: 48, cancelledH: 40, items: [shipItem(SKUS[1], 2)] },
	{ lane: 'cancelled', paidH: 96, cancelledH: 90, items: [shipItem(SKUS[0]), shipItem(SKUS[4], 2)] },
	// Cancelled before payment reads as `unpaid`: deriveOrderLane checks paidAt first
	// (src/domain/orders.ts). Kept because it is the surprising case.
	{ lane: 'unpaid', createdH: 30, cancelledH: 28, items: [shipItem(SKUS[3])], unpaid: true },

	...[36, 96].map((h) => ({ lane: 'refunded', paidH: h, refundedH: Math.max(1, h - 10), items: [shipItem(SKUS[2], 2)] })),
];

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
		// The ingress stores the PII-stripped body; nothing here invents any.
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

	pushDelivery('orders/create', { ...base, updated_at: iso(createdAt), financial_status: 'pending', fulfillment_status: null }, createdAt);

	if (!spec.unpaid) {
		const paidAt = hoursAgo(spec.paidH ?? createdH);
		pushDelivery(
			'orders/paid',
			{ ...base, updated_at: iso(paidAt), processed_at: iso(paidAt), financial_status: 'paid', fulfillment_status: null },
			paidAt,
		);
	}

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
		pushDelivery('orders/updated', { ...base, updated_at: iso(at), financial_status: 'paid', fulfillment_status: 'fulfilled' }, at);
	}

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
		pushDelivery('orders/updated', { ...base, updated_at: iso(at), financial_status: 'refunded', fulfillment_status: null }, at);
	}

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

// Inventory movements so the Events view has an inventory domain and SKU column;
// they carry no order linkage.
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

function verify() {
	const byOrder = new Map();
	let normalized = 0;

	for (const d of deliveries) {
		const meta = { shopId: d.shopId, topic: d.topic, webhookId: d.webhookId, receivedAt: d.receivedAt };
		const events = normalizeDelivery(meta, JSON.parse(d.payload));
		normalized += events.length;
		for (const e of events) {
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
		// Shuffled: the reducer is commutative, so the lane must not depend on arrival order.
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

		// Precondition for the confirmation detector: awaiting, and paid longer ago than the deadline.
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
  - the process job (every 10s) normalizes these into OperationalEvent
    and folds them into OrderProjection
  - the detect job (every 5m) then opens findings for anything past the
    ${DEADLINE_H}h confirmation deadline, and for the recorded failed attempts
  - the state backfill gives older projections their lane

Watch for 'process.batch' then 'detect.' log lines, and give it a few minutes
before judging the Findings view. Re-running this script is safe: delivery ids
are unique per run, so it adds data rather than replacing it.
`);
