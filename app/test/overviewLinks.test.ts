import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTable } from './fakeTable.ts';
import { computeFlows, getSummary, listFindings, listOrders } from '../src/queries.ts';
import { runStateBackfill, type BackfillDeps } from '../src/stateBackfill.ts';
import { MAX_LIMIT } from '../src/apiContract.ts';
import { detectorKey, FAILED_RULE } from '../src/detector.ts';
import { overviewView } from '../web/src/view.ts';
import type { Summary } from '../web/src/api.ts';

// THE INVARIANT: every number on the Overview that links somewhere must equal the
// length of the list its own link opens.
//
// This is the assertion shape the branch never had, and it is the one that would
// have caught, on its own, all four of the defects found here: the aging buckets
// linking to everything older than their lower bound (C2), the legacy projections
// with no stored `state` making every lane count exceed its list (C1), the Paid
// tile linking to a page showing a different number, and the failed-attempts tile
// linking to a bigger set than it counted.
//
// It is deliberately DERIVED, not enumerated: the hrefs come out of the rendered
// markup, are parsed exactly as the router would parse them, and are then run
// through the real query functions with the real tenant scoping. Nothing here
// hard-codes what the Overview links to — a new linked count is picked up
// automatically, and the expected-link list below makes adding one a deliberate
// act rather than an untested one.

const NOW = 1_000_000_000_000;
const HOUR = 3_600_000;
const SHOP = 's1';

// A universe with a non-zero count in EVERY linked category, so no assertion can
// pass vacuously as 0 === 0. Ages are chosen so all four aging buckets are
// occupied.
function world() {
	const projections = new FakeTable('id', [
		// awaiting, one per aging bucket
		{
			id: 's1:a1',
			shopId: SHOP,
			orderId: 'a1',
			paidAt: NOW - 2 * HOUR,
			requiresFulfillment: true,
			state: 'awaiting',
			lastEventAt: NOW - 2 * HOUR,
		},
		{
			id: 's1:a2',
			shopId: SHOP,
			orderId: 'a2',
			paidAt: NOW - 30 * HOUR,
			requiresFulfillment: true,
			state: 'awaiting',
			lastEventAt: NOW - 30 * HOUR,
		},
		{
			id: 's1:a3',
			shopId: SHOP,
			orderId: 'a3',
			paidAt: NOW - 60 * HOUR,
			requiresFulfillment: true,
			state: 'awaiting',
			lastEventAt: NOW - 60 * HOUR,
		},
		{
			id: 's1:a4',
			shopId: SHOP,
			orderId: 'a4',
			paidAt: NOW - 90 * HOUR,
			requiresFulfillment: true,
			state: 'awaiting',
			lastEventAt: NOW - 90 * HOUR,
		},
		// A LEGACY awaiting row: no stored `state`, the deploy-day shape. The backfill
		// below is what lets it be listed as well as counted; without that sweep this
		// whole test fails, which is the point.
		{
			id: 's1:aLegacy',
			shopId: SHOP,
			orderId: 'aLegacy',
			paidAt: NOW - 40 * HOUR,
			requiresFulfillment: true,
			lastEventAt: NOW - 40 * HOUR,
		},
		// the other lanes
		{
			id: 's1:f1',
			shopId: SHOP,
			orderId: 'f1',
			paidAt: NOW - 20 * HOUR,
			requiresFulfillment: true,
			fulfilledAt: NOW - 18 * HOUR,
			state: 'fulfilled',
			lastEventAt: NOW - 18 * HOUR,
		},
		{
			id: 's1:c1',
			shopId: SHOP,
			orderId: 'c1',
			paidAt: NOW - 10 * HOUR,
			requiresFulfillment: true,
			cancelledAt: NOW - 9 * HOUR,
			state: 'cancelled',
			lastEventAt: NOW - 9 * HOUR,
		},
		{
			id: 's1:r1',
			shopId: SHOP,
			orderId: 'r1',
			paidAt: NOW - 8 * HOUR,
			requiresFulfillment: true,
			fullyRefundedAt: NOW - 7 * HOUR,
			state: 'refunded',
			lastEventAt: NOW - 7 * HOUR,
		},
		// digital (no fulfillment observed, none expected) and unpaid
		{ id: 's1:d1', shopId: SHOP, orderId: 'd1', paidAt: NOW - 5 * HOUR, state: 'no_fulfillment_expected', lastEventAt: NOW - 5 * HOUR },
		{ id: 's1:u1', shopId: SHOP, orderId: 'u1', state: 'unpaid', lastEventAt: NOW - 4 * HOUR },
		// another tenant, sharing order ids, so a broken scope inflates a count
		{
			id: 's2:a1',
			shopId: 's2',
			orderId: 'a1',
			paidAt: NOW - 2 * HOUR,
			requiresFulfillment: true,
			state: 'awaiting',
			lastEventAt: NOW - 2 * HOUR,
		},
		{ id: 's2:u1', shopId: 's2', orderId: 'u1', state: 'unpaid', lastEventAt: NOW - 4 * HOUR },
	]);
	const findings = new FakeTable('id', [
		{
			id: detectorKey(SHOP, 'a2'),
			shopId: SHOP,
			orderId: 'a2',
			detector: 'fulfillment_confirmation',
			status: 'unconfirmed',
			detectedAt: NOW - 20 * HOUR,
		},
		{
			id: detectorKey(SHOP, 'a3'),
			shopId: SHOP,
			orderId: 'a3',
			detector: 'fulfillment_confirmation',
			status: 'resolved',
			detectedAt: NOW - 30 * HOUR,
		},
		{
			id: detectorKey(SHOP, 'a4'),
			shopId: SHOP,
			orderId: 'a4',
			detector: 'fulfillment_confirmation',
			status: 'suppressed',
			detectedAt: NOW - 40 * HOUR,
		},
		// Two failed-attempt findings in DIFFERENT statuses: `failedAttempts` counts
		// only the unconfirmed one, so a link without `status=unconfirmed` opens two
		// rows for a tile that says one.
		{
			id: detectorKey(SHOP, 'a2', FAILED_RULE),
			shopId: SHOP,
			orderId: 'a2',
			detector: 'fulfillment_attempt_failed',
			status: 'unconfirmed',
			detectedAt: NOW - 19 * HOUR,
		},
		{
			id: detectorKey(SHOP, 'a3', FAILED_RULE),
			shopId: SHOP,
			orderId: 'a3',
			detector: 'fulfillment_attempt_failed',
			status: 'resolved',
			detectedAt: NOW - 29 * HOUR,
		},
		{
			id: detectorKey('s2', 'a1'),
			shopId: 's2',
			orderId: 'a1',
			detector: 'fulfillment_confirmation',
			status: 'unconfirmed',
			detectedAt: NOW - 5 * HOUR,
		},
	]);
	return {
		events: new FakeTable('eventId', []),
		projections,
		findings,
		expectations: new FakeTable('id', []),
		deliveries: new FakeTable('id', []),
		shops: new FakeTable('shopId', [{ shopId: SHOP, status: 'active', lastReconciledAt: NOW - 60_000, reconciliationState: 'ready' }]),
	};
}

interface LinkedCount {
	label: string;
	href: string;
	count: number;
}

// Stat tiles (statGridLinked): the count and the label live INSIDE the link.
function linkedTiles(html: string): LinkedCount[] {
	const out: LinkedCount[] = [];
	for (const item of html.match(/<s-grid-item>[\s\S]*?<\/s-grid-item>/g) ?? []) {
		const link = item.match(
			/<s-link href="([^"]+)">\s*<s-text type="strong" fontVariantNumeric="tabular-nums">(\d+)<\/s-text>\s*<s-paragraph><s-text color="subdued">([^<]*)<\/s-text>/,
		);
		if (link) out.push({ href: link[1], count: Number(link[2]), label: link[3] });
	}
	return out;
}

// Linked table rows (the flow lanes and the aging buckets): the label is in the
// linked cell, the count in the cell beside it.
function linkedRows(html: string): LinkedCount[] {
	const out: LinkedCount[] = [];
	const re = /<s-table-cell><s-link href="([^"]+)">([^<]*)<\/s-link><\/s-table-cell>\s*<s-table-cell>(\d+)<\/s-table-cell>/g;
	for (const m of html.matchAll(re)) out.push({ href: m[1], label: m[2], count: Number(m[3]) });
	return out;
}

// Parse an href exactly as the router does: the markup carries HTML entities, so
// they must be decoded before the query string is read. A double-escaped `&`
// would silently produce an `amp;minAgeHours` param that no filter matches — the
// list would then be wrong in the merchant's favour and this test would catch it
// as a count mismatch.
function routeOf(href: string): { path: string; params: URLSearchParams } {
	const decoded = href.replace(/&amp;/g, '&');
	const [rawPath, query] = decoded.replace(/^#/, '').split('?');
	return { path: rawPath, params: new URLSearchParams(query ?? '') };
}

function numParam(params: URLSearchParams, name: string): number | undefined {
	const raw = params.get(name);
	if (raw === null) return undefined;
	const n = Number(raw);
	return Number.isFinite(n) ? n : undefined;
}

// Run the query the href names, with the same tenant scoping the resources use.
async function openLink(tables: ReturnType<typeof world>, href: string): Promise<Array<Record<string, unknown>>> {
	const { path, params } = routeOf(href);
	if (path === '/orders') {
		const page = await listOrders(tables.projections, SHOP, NOW, {
			state: params.get('state') ?? undefined,
			minAgeHours: numParam(params, 'minAgeHours'),
			maxAgeHours: numParam(params, 'maxAgeHours'),
			limit: MAX_LIMIT,
		});
		return page.items;
	}
	if (path === '/findings') {
		const page = await listFindings(tables.findings, tables.expectations, tables.projections, SHOP, {
			status: params.get('status') ?? undefined,
			detector: params.get('detector') ?? undefined,
			limit: MAX_LIMIT,
		});
		return page.items;
	}
	throw new Error(`the Overview links to ${path}, which this guard does not know how to open`);
}

async function renderOverview(tables: ReturnType<typeof world>): Promise<string> {
	const summary = (await getSummary(tables, SHOP, NOW)) as unknown as Summary;
	const flows = (await computeFlows(tables.projections, SHOP, NOW)) as unknown as { lanes: Record<string, number> };
	return overviewView({ summary, flows, unconfirmed: [], setup: null, now: NOW });
}

test('every linked count on the Overview equals the length of the list it links to', async () => {
	const tables = world();
	// The post-backfill state, which is the production invariant: the sweep is what
	// makes a legacy projection listable as well as countable. Delete this line and
	// this test fails on aLegacy — that failure IS C1.
	await runStateBackfill(NOW, {
		projections: tables.projections as unknown as BackfillDeps['projections'],
		checkpoints: new FakeTable('id', []) as unknown as BackfillDeps['checkpoints'],
	});
	const html = await renderOverview(tables);
	const linked = [...linkedTiles(html), ...linkedRows(html)];

	let nonZero = 0;
	for (const link of linked) {
		const items = await openLink(tables, link.href);
		assert.equal(
			items.length,
			link.count,
			`"${link.label}" shows ${link.count} but ${link.href} opens ${items.length}: ${items.map((i) => i.orderId ?? i.id).join(', ')}`,
		);
		if (link.count > 0) nonZero++;
	}
	// Guard against the guard passing because everything happened to be zero.
	assert.equal(nonZero, linked.length, 'every linked count in this fixture is non-zero, so no assertion passes vacuously');
});

test('the exact set of linked counts is pinned, so adding one is a deliberate act', async () => {
	// The invariant above is derived from the markup, so a NEW linked count is
	// checked automatically — but a count that stops being linked, or a link whose
	// filter set silently changes, would pass it. This pins both.
	const tables = world();
	const html = await renderOverview(tables);
	assert.deepEqual(
		[...linkedTiles(html), ...linkedRows(html)].map((l) => `${l.label} -> ${l.href}`).sort(),
		[
			'24–48h -> #/orders?state=awaiting&amp;minAgeHours=24&amp;maxAgeHours=48',
			'48–72h -> #/orders?state=awaiting&amp;minAgeHours=48&amp;maxAgeHours=72',
			// Twice each: once as an Overview stat tile, once as a flow lane. Both must
			// carry the same filter, or the two numbers drill into different lists.
			'Awaiting confirmation -> #/orders?state=awaiting',
			'Awaiting confirmation -> #/orders?state=awaiting',
			'Cancelled -> #/orders?state=cancelled',
			'Fulfilled -> #/orders?state=fulfilled',
			'Fulfilled -> #/orders?state=fulfilled',
			'No fulfillment expected -> #/orders?state=no_fulfillment_expected',
			// Was 'Failed attempts', which overstated the measure: the tile counts one
			// finding per order, so two failed attempts on one order are one row. The
			// href is unchanged — the same filtered list, correctly described.
			'Orders with a failed attempt -> #/findings?detector=fulfillment_attempt_failed&amp;status=unconfirmed',
			'Over 72h -> #/orders?state=awaiting&amp;minAgeHours=72',
			'Refunded -> #/orders?state=refunded',
			'Resolved -> #/findings?status=resolved',
			'Suppressed -> #/findings?status=suppressed',
			'Tracked -> #/orders',
			'Unconfirmed -> #/findings?status=unconfirmed',
			'Under 24h -> #/orders?state=awaiting&amp;minAgeHours=0&amp;maxAgeHours=24',
		],
		'the Overview gained or lost a linked count — add it here and to the invariant above',
	);
});

test('the Overview links carry no double-escaped separator, so every param reaches the query', async () => {
	const tables = world();
	const html = await renderOverview(tables);
	assert.doesNotMatch(html, /&amp;amp;/, 'a double-escaped & produces an "amp;status" param that matches nothing');
	// And no bare `&` inside an href attribute, which is invalid markup.
	for (const link of [...linkedTiles(html), ...linkedRows(html)]) {
		assert.doesNotMatch(link.href, /&(?!amp;)/, `${link.href} contains a bare &`);
	}
});

test('a count with no link is a deliberate choice, not an oversight', async () => {
	// "Paid" is every paid order regardless of lane, and no `state=` value reproduces
	// that, so it must stay unlinked rather than link to a page showing a different
	// number. Asserted here beside the invariant it is the exception to.
	const tables = world();
	const html = await renderOverview(tables);
	const linked = [...linkedTiles(html), ...linkedRows(html)].map((l) => l.label);
	assert.ok(!linked.includes('Paid'), 'the Paid tile/lane has no link because no worklist filter reproduces it');
	// It is still rendered — unlinked, not omitted.
	assert.match(html, /<s-text color="subdued">Paid<\/s-text>/);
	assert.match(html, /<s-table-cell>Paid<\/s-table-cell>/);
});

test('the linked lists a merchant lands on are tenant-scoped, not just the counts', async () => {
	// The counts are already tenant-scoped by construction; this checks the OTHER
	// half — that following the link cannot surface the other shop's rows, which
	// share order ids with this one.
	const tables = world();
	await runStateBackfill(NOW, {
		projections: tables.projections as unknown as BackfillDeps['projections'],
		checkpoints: new FakeTable('id', []) as unknown as BackfillDeps['checkpoints'],
	});
	const html = await renderOverview(tables);
	for (const link of [...linkedTiles(html), ...linkedRows(html)]) {
		for (const item of await openLink(tables, link.href)) {
			const id = String(item.id ?? '');
			assert.ok(!id.startsWith('s2:'), `${link.href} surfaced another tenant's row ${id}`);
		}
	}
});
