import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
	EventDetail,
	EventItem,
	FindingDetail,
	FindingItem,
	OrderDetail,
	OrderItem,
	Privacy,
	Setup,
	Summary,
} from '../web/src/api.ts';
import {
	activityView,
	adminOrderLink,
	adminOrderUrl,
	agingView,
	bucketMinHours,
	contextStrip,
	errorViewMarkup,
	authExpiredView,
	eventDetailView,
	eventQuery,
	eventsView,
	FINDINGS_BOUNDARY,
	FINDING_DISCLAIMER,
	findingDetailView,
	findingsListView,
	integrityView,
	money,
	needsAttention,
	observedTimeline,
	orderDetailView,
	orderTimeline,
	ordersView,
	overviewView,
	parseHash,
	privacyView,
	setShop,
	setSupport,
	setupView,
	storeHandle,
	useShopTimeZone,
	zoneText,
} from '../web/src/view.ts';
import { AGE_BUCKETS } from '../src/orders.ts';

// UI tests. view.ts is pure — every screen is a function from data to markup — so
// these run in plain node with no browser, DOM shim, or extra dependency. They
// cover what a screenshot review would otherwise have to catch by eye: the
// product-truth copy, the per-state banners, escaping, and the Polaris markup.

const NOW = 1_775_000_000_000; // fixed clock: no Date.now() in assertions
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function summary(over: Partial<Summary> = {}): Summary {
	return {
		shop: 's.myshopify.com',
		windowDays: 7,
		events: { total: 12 },
		orders: { tracked: 4, paid: 3, fulfilled: 2, awaitingConfirmation: 1 },
		findings: { unconfirmed: 1, resolved: 2, suppressed: 0 },
		aging: { buckets: [] },
		recorder: { healthy: true, deadLetteredDeliveries: 0 },
		reconciliation: { lastReconciledAt: NOW - 4 * MIN, ageMs: 4 * MIN, stale: false, state: 'ready' },
		activity: {
			days: 7,
			domains: ['order', 'fulfillment', 'inventory', 'refund'],
			buckets: Array.from({ length: 7 }, (_unused, i) => ({
				startAt: NOW - (6 - i) * DAY,
				total: i === 6 ? 3 : 0,
				order: i === 6 ? 2 : 0,
				fulfillment: i === 6 ? 1 : 0,
				inventory: 0,
				refund: 0,
			})),
		},
		integrity: { webhookEvents: 0, reconciliationOnlyEvents: 0 },
		...over,
	};
}

const FLOWS = { lanes: { paid: 3, fulfilled: 2, awaitingConfirmation: 1, cancelled: 0, refunded: 0 } };

function setup(over: Partial<Setup> = {}): Setup {
	return {
		shop: 's.myshopify.com',
		complete: true,
		steps: [
			{ key: 'installed', label: 'Installed', state: 'done' },
			{ key: 'capture', label: 'Webhooks connected', state: 'done' },
			{ key: 'initialCheck', label: 'Initial check', state: 'done' },
		],
		eventsObserved: true,
		action: 'none',
		...over,
	};
}

function finding(over: Partial<FindingDetail> = {}): FindingDetail {
	return {
		id: 'fulfillment_confirmation:s:1048',
		orderId: '1048',
		ruleVersion: 1,
		status: 'unconfirmed',
		detectedAt: NOW - HOUR,
		evidenceEventIds: ['s:e1', 's:e2'],
		description: 'No Shopify fulfillment confirmation was observed for this paid, fulfillment-eligible order by the expected time.',
		expectation: { state: 'expired', deadline: NOW - 2 * HOUR, createdAt: NOW - 26 * HOUR },
		projection: { orderId: '1048', paidAt: NOW - 26 * HOUR, requiresFulfillment: true },
		...over,
	};
}

const OVERVIEW_BASE = { flows: FLOWS, unconfirmed: [] as FindingItem[], setup: setup(), now: NOW };

// ── product truth ────────────────────────────────────────────────────────────

test('an unconfirmed finding renders the screen-spec disclaimer verbatim', () => {
	const html = findingDetailView(finding(), NOW - 5 * MIN, '');
	assert.ok(
		html.includes(FINDING_DISCLAIMER),
		'the spec §4 disclaimer must appear verbatim — it is the product-truth guardrail for the whole app',
	);
	assert.equal(
		FINDING_DISCLAIMER,
		'This does not prove that a warehouse or carrier failed. It means Shopify has not shown the expected fulfillment confirmation yet.',
		'the constant itself must not drift from the committed screen spec',
	);
});

test('resolved and suppressed findings omit the disclaimer, whose wording would be false', () => {
	for (const status of ['resolved', 'suppressed']) {
		const html = findingDetailView(finding({ status, description: 'A fulfillment confirmation was later observed.' }), NOW, '');
		assert.ok(!html.includes(FINDING_DISCLAIMER), `"has not shown … yet" is untrue for a ${status} finding`);
	}
});

test('a failed-attempt finding never carries the absence detector’s disclaimer — it would be false and self-contradictory', () => {
	const html = findingDetailView(
		finding({
			detector: 'fulfillment_attempt_failed',
			description: 'Shopify recorded a fulfillment attempt for this order that did not succeed.',
		}),
		NOW,
		'',
	);
	assert.ok(!html.includes(FINDING_DISCLAIMER), '"has not shown … yet" is false when Shopify already recorded the failed attempt');
	assert.ok(!html.includes('Why this qualified'), 'this detector has no confirmation window to explain');
	assert.ok(
		html.includes('Shopify recorded a fulfillment attempt for this order that did not succeed'),
		'the timeline states what was actually observed instead of an absence',
	);
});

test('a finding with no detector field still gets absence-detector copy (rows written before the column existed)', () => {
	const html = findingDetailView(finding({ detector: undefined }), NOW, '');
	assert.ok(html.includes(FINDING_DISCLAIMER));
});

test('the findings list states the claim boundary', () => {
	const html = findingsListView({}, [], NOW, '');
	assert.ok(html.includes(FINDINGS_BOUNDARY));
	assert.match(FINDINGS_BOUNDARY, /do not prove/);
});

test('no screen accuses a downstream party of failing', () => {
	// The only permitted use of "failed" is inside the disclaimer that denies it.
	const screens = [
		overviewView({
			...OVERVIEW_BASE,
			summary: summary(),
			unconfirmed: [{ id: 'f1', orderId: '1048', status: 'unconfirmed', detectedAt: NOW - HOUR }],
		}),
		findingsListView(
			{},
			[{ id: 'f1', orderId: '1048', status: 'unconfirmed', detectedAt: NOW - HOUR, paidAt: NOW - DAY, deadline: NOW - HOUR }],
			NOW,
			'',
		),
		setupView(setup()),
		privacyView(privacy(), NOW, ''),
	];
	for (const html of screens) {
		// Both constants legitimately contain the words — they are the sentences that
		// DENY the claim. Strip them, then nothing else may make it.
		const rest = html.replace(FINDING_DISCLAIMER, '').replace(FINDINGS_BOUNDARY, '');
		assert.ok(!/failed/i.test(rest), 'no failure language outside the sentences that disclaim it');
		assert.ok(!/warehouse|carrier|3PL|vendor/i.test(rest), 'no downstream party is named as a cause');
	}
});

test('the needs-attention row describes an absent observation, not a failure', () => {
	const html = needsAttention([{ id: 'f1', orderId: '1048', status: 'unconfirmed', detectedAt: NOW - 20 * HOUR }], NOW);
	assert.ok(html.includes('No Shopify fulfillment confirmation observed'));
	assert.ok(html.includes('20h'), 'elapsed time is shown');
	// Past a day the elapsed column coarsens to days rather than 3-digit hours.
	assert.ok(needsAttention([{ id: 'f1', orderId: '1', status: 'unconfirmed', detectedAt: NOW - 25 * HOUR }], NOW).includes('1d'));
});

// ── setup / first open ───────────────────────────────────────────────────────

test('a connected but quiet store reads as connected, not as broken or as unseen capture', () => {
	const html = setupView(setup({ eventsObserved: false }));
	assert.ok(html.includes('Connected — no events yet'), 'connected, with activity reported honestly as absent');
	assert.ok(!html.includes('Receiving events'));
});

test('a store with observed deliveries reports receiving events', () => {
	assert.ok(setupView(setup({ eventsObserved: true })).includes('Receiving events'));
});

test('setup offers reauthorization instead of a retry when a step is blocked', () => {
	const html = setupView(
		setup({
			complete: false,
			action: 'reauthorize',
			steps: [
				{ key: 'installed', label: 'Installed', state: 'done' },
				{ key: 'capture', label: 'Webhooks connected', state: 'blocked' },
				{ key: 'initialCheck', label: 'Initial check', state: 'blocked' },
			],
		}),
	);
	assert.ok(html.includes('Reauthorization needed'));
	assert.ok(!html.includes('data-retry'), 'a blocked step offers reauthorization, not a pointless retry');
	assert.ok(html.includes('tone="critical"'), 'blocked steps are badged critical');
});

test('an incomplete setup says history is still being built', () => {
	const html = setupView(setup({ complete: false }));
	assert.ok(html.includes('The initial check is still running'));
	assert.ok(!html.includes('Setup complete'));
});

// ── overview states ──────────────────────────────────────────────────────────

test('an unhealthy recorder never renders as "no gaps"', () => {
	const html = overviewView({
		...OVERVIEW_BASE,
		summary: summary({ recorder: { healthy: false, deadLetteredDeliveries: 3 }, findings: { unconfirmed: 0, resolved: 0, suppressed: 0 } }),
	});
	assert.ok(html.includes('Recorder needs attention'), 'health is stated separately from the finding count');
	assert.ok(html.includes('3 deliver(ies) could not be processed'));
	assert.ok(html.includes('Gap results may be incomplete'));
	assert.ok(!html.includes('Recorder healthy'));
});

test('a stale reconciliation is called out without disowning the counts', () => {
	const html = overviewView({
		...OVERVIEW_BASE,
		summary: summary({ reconciliation: { lastReconciledAt: NOW - 90 * MIN, ageMs: 90 * MIN, stale: true, state: 'ready' } }),
	});
	assert.ok(html.includes('Reconciliation delayed'));
	assert.ok(html.includes('Webhook capture is unaffected'));
});

test('a never-reconciled shop is not presented as freshly reconciled', () => {
	const html = contextStrip(summary({ reconciliation: { ageMs: null, stale: true, state: 'pending' } }), NOW);
	assert.ok(html.includes('Initial check pending'));
	assert.ok(!/Reconciled/.test(html));
});

test('an incomplete initial check warns that overview counts may be partial', () => {
	const html = overviewView({ ...OVERVIEW_BASE, summary: summary(), setup: setup({ complete: false }) });
	assert.ok(html.includes('Initial check still running'));
	assert.ok(html.includes('#/setup'), 'and links to the setup screen');
});

test('a failed panel degrades to partial data rather than blanking the screen', () => {
	const one = overviewView({ ...OVERVIEW_BASE, summary: summary(), flows: null });
	assert.ok(one.includes('Partial data'));
	assert.ok(one.includes('order flow panel couldn’t load'));
	assert.ok(one.includes('Everything else on this page is current'));
	assert.ok(one.includes('Awaiting confirmation'), 'the panels that did load are still rendered');

	const both = overviewView({ ...OVERVIEW_BASE, summary: summary(), flows: null, unconfirmed: null });
	assert.ok(both.includes('panels couldn’t load'), 'pluralised for two failures');
});

test('a fully healthy overview shows no warning banners', () => {
	const html = overviewView({ ...OVERVIEW_BASE, summary: summary() });
	assert.ok(html.includes('Recorder healthy'));
	for (const absent of ['Partial data', 'Reconciliation delayed', 'Initial check still running']) {
		assert.ok(!html.includes(absent), `${absent} must not appear on a healthy overview`);
	}
});

// ── aging / drill-down links ─────────────────────────────────────────────────

test('the aging breakdown links each bucket into the filtered worklist', () => {
	const html = agingView({
		buckets: [
			{ key: 'under24', label: 'Under 24h', count: 3 },
			{ key: 'over72', label: 'Over 72h', count: 1 },
		],
	});
	assert.match(html, /Under 24h/);
	assert.match(html, /href="#\/orders\?state=awaiting&amp;minAgeHours=72"/);
});

// Pull out one <s-grid-item>…</s-grid-item> block by the label it renders, so an
// assertion can check that block's own href/count rather than matching anywhere
// in the page — the loose-match failure mode that let an earlier defect (the
// Paid tile linking to a page showing a different count) pass silently.
function gridItem(html: string, label: string): string {
	const items = html.match(/<s-grid-item>[\s\S]*?<\/s-grid-item>/g) ?? [];
	const found = items.find((item) => item.includes(`>${label}<`));
	assert.ok(found, `no stat tile found for "${label}"`);
	return found!;
}

test('the overview stat tiles link into the worklist, each to its own count', () => {
	const html = overviewView({ ...OVERVIEW_BASE, summary: summary() });
	// summary()'s orders are { tracked: 4, paid: 3, fulfilled: 2, awaitingConfirmation: 1 }.
	assert.match(gridItem(html, 'Tracked'), /href="#\/orders"[\s\S]*>4</);
	assert.match(gridItem(html, 'Fulfilled'), /href="#\/orders\?state=fulfilled"[\s\S]*>2</);
	assert.match(gridItem(html, 'Awaiting confirmation'), /href="#\/orders\?state=awaiting"[\s\S]*>1</);
});

test('the Paid stat tile and the Paid flow lane are never links — no worklist filter reproduces "every paid order regardless of lane"', () => {
	const html = overviewView({ ...OVERVIEW_BASE, summary: summary() });
	assert.doesNotMatch(gridItem(html, 'Paid'), /<s-link/, 'the Paid stat tile has no href');
	assert.match(html, /<s-table-cell>Paid<\/s-table-cell>/, 'the Paid flow lane renders as a plain cell');
	assert.doesNotMatch(html, /<s-link[^>]*>Paid<\/s-link>/, 'no href wraps the Paid flow-lane label');
});

test('bucketMinHours agrees with AGE_BUCKETS for every key, so a renamed bucket fails a test instead of silently mapping to 72', () => {
	for (const bucket of AGE_BUCKETS) {
		assert.equal(bucketMinHours(bucket.key), bucket.minHours, `bucketMinHours('${bucket.key}') must match AGE_BUCKETS`);
	}
});

test('a zero-count aging bucket still renders, so the breakdown is readable', () => {
	const html = agingView({ buckets: [{ key: 'h48to72', label: '48–72h', count: 0 }] });
	assert.match(html, /48–72h/);
});

// ── activity visualization ───────────────────────────────────────────────────

test('activity exposes the same numbers to assistive tech and as a table', () => {
	const html = activityView(summary().activity);
	assert.match(html, /role="img"/);
	assert.match(html, /aria-label="Events per day over the last 7 days\. Orders: 0, 0, 0, 0, 0, 0, 2\./);
	assert.ok(html.includes('View activity as a table'), 'the required text equivalent is present');
	assert.ok(html.includes('<s-table'), 'and it is a real table');
});

test('a zero-count day renders no bar height, so magnitude never overstates', () => {
	const html = activityView(summary().activity);
	assert.ok(html.includes('style="height:0%"'), 'empty days are visibly empty');
	assert.ok(html.includes('style="height:100%"'), 'the peak day fills the track');
});

test('the integrity section states what a direct-check discovery does and does not mean', () => {
	const html = integrityView({ webhookEvents: 40, reconciliationOnlyEvents: 3 });
	assert.match(html, /3/);
	assert.match(html, /direct check/i);
	// It must NOT claim Shopify failed, or that other apps missed anything.
	assert.doesNotMatch(html, /Shopify failed|never delivered to your|your vendors did not/i);
	assert.match(html, /href="#\/events\?source=reconciliation"/);
});

test('zero direct-check discoveries reads as healthy, not as an absence of data', () => {
	assert.match(integrityView({ webhookEvents: 40, reconciliationOnlyEvents: 0 }), /Every change[\s\S]*webhook/i);
});

// ── escaping ─────────────────────────────────────────────────────────────────

test('hostile field values are escaped everywhere they surface', () => {
	const nasty = '<img src=x onerror="alert(1)">';
	const screens = [
		findingsListView({}, [{ id: nasty, orderId: nasty, status: 'unconfirmed', detectedAt: NOW }], NOW, ''),
		findingDetailView(finding({ orderId: nasty, description: nasty }), NOW, ''),
		needsAttention([{ id: nasty, orderId: nasty, status: 'unconfirmed', detectedAt: NOW }], NOW),
		eventsView(
			{},
			[{ eventId: nasty, domain: nasty, topic: nasty, resourceId: nasty, sku: nasty, source: nasty, occurredAt: NOW, receivedAt: NOW }],
			false,
			'',
		),
		errorViewMarkup(nasty),
	];
	for (const html of screens) {
		assert.ok(!html.includes('<img src=x'), 'raw markup must never reach the page');
		assert.ok(html.includes('&lt;img'), 'it is escaped instead');
		assert.ok(!html.includes('onerror="alert(1)"'), 'nor the event handler');
	}
});

test('a quote in a filter value cannot break out of an attribute', () => {
	const html = eventsView({ sku: 'a" onfocus="x' }, [], false, '');
	assert.ok(html.includes('value="a&quot; onfocus=&quot;x"'));
	assert.ok(!html.includes('onfocus="x"'));
});

// ── timestamps and timezone ──────────────────────────────────────────────────

test('every timestamp carries a machine-readable absolute instant', () => {
	const html = findingDetailView(finding(), NOW, '');
	assert.match(html, /<time datetime="20\d\d-\d\d-\d\dT[\d:.]+Z" title="[^"]+">/, 'ISO datetime plus an exact human title');
});

test('the store timezone is actually applied and labelled as such', () => {
	const row = (): string => findingsListView({}, [{ id: 'f', orderId: '1', status: 'resolved', paidAt: NOW }], NOW, '');
	try {
		useShopTimeZone('Asia/Tokyo');
		assert.ok(zoneText().includes('Asia/Tokyo'));
		assert.ok(zoneText().includes('store time'), 'the label says whose zone it is');
		const tokyo = row();

		useShopTimeZone('America/Los_Angeles');
		const la = row();
		// Same instant, two zones — if the zone weren't threaded into the formatters
		// these would be identical. Machine-zone independent, so it holds in CI.
		assert.notEqual(tokyo, la, 'the store zone changes the rendered wall-clock time');
		assert.ok(tokyo.includes('datetime="') && tokyo.includes(new Date(NOW).toISOString()), 'while the absolute instant is unchanged');
		assert.ok(la.includes(new Date(NOW).toISOString()));
	} finally {
		useShopTimeZone(undefined);
	}
});

test('an unknown zone falls back to the viewer instead of blanking the app', () => {
	useShopTimeZone('Mars/Olympus_Mons');
	try {
		assert.ok(zoneText().includes('your device'), 'falls back and says so, rather than claiming store time');
		assert.doesNotThrow(() => findingsListView({}, [{ id: 'f', orderId: '1', status: 'resolved', paidAt: NOW }], NOW, ''));
	} finally {
		useShopTimeZone(undefined);
	}
});

test('with no store zone the label does not claim store time', () => {
	useShopTimeZone(undefined);
	assert.ok(zoneText().includes('your device'));
});

// ── events ───────────────────────────────────────────────────────────────────

test('the events screen offers the full screen-spec filter set', () => {
	const html = eventsView({}, [], false, '');
	for (const id of ['f-range', 'f-domain', 'f-topic', 'f-resourceId', 'f-sku', 'f-source']) {
		assert.ok(html.includes(`id="${id}"`), `missing the ${id} filter`);
	}
	assert.ok(html.includes('Evidence source'));
	// Column headers only render alongside rows, so check them on a populated list.
	const populated = eventsView(
		{},
		[{ eventId: 'e1', domain: 'order', source: 'reconciliation', occurredAt: NOW, receivedAt: NOW }],
		false,
		'',
	);
	assert.ok(populated.includes('<s-table-header format="base">Source</s-table-header>'), 'and shows the source column');
	assert.ok(populated.includes('>reconciliation</s-table-cell>'), 'with the per-row provenance');
});

test('active filters are reflected back into the controls', () => {
	const html = eventsView(
		{ range: '24h', domain: 'fulfillment', topic: 'fulfillments/create', sku: 'SKU-1', source: 'reconciliation' },
		[],
		false,
		'',
	);
	assert.ok(html.includes('<option value="24h" selected>'));
	assert.ok(html.includes('<option value="fulfillment" selected>'));
	assert.ok(html.includes('<option value="reconciliation" selected>'));
	assert.ok(html.includes('value="fulfillments/create"'));
	assert.ok(html.includes('value="SKU-1"'));
});

test('eventQuery turns a symbolic range into a window floor', () => {
	assert.deepEqual(eventQuery({ range: '24h' }, NOW), { since: String(NOW - DAY) });
	assert.deepEqual(eventQuery({ range: '1h', domain: 'order' }, NOW), { domain: 'order', since: String(NOW - HOUR) });
	assert.deepEqual(eventQuery({}, NOW), {}, 'no range means the full retention window');
	assert.deepEqual(eventQuery({ range: 'bogus' }, NOW), {}, 'an unknown range is ignored, not passed through');
});

test('an empty ledger says so instead of rendering an empty table', () => {
	const html = eventsView({}, [], false, '');
	assert.ok(html.includes('No events match.'));
	assert.ok(!html.includes('<s-table-body>'), 'no headers over nothing');
});

test('load-more only appears when there is another page', () => {
	const item: EventItem = { eventId: 'e1', domain: 'order', source: 'webhook', occurredAt: NOW, receivedAt: NOW };
	assert.ok(eventsView({}, [item], true, '').includes('id="loadMore"'));
	assert.ok(!eventsView({}, [item], false, '').includes('id="loadMore"'));
});

test('a delayed receipt is disclosed without reordering the ledger', () => {
	const base: EventDetail = {
		eventId: 'e1',
		domain: 'order',
		source: 'webhook',
		occurredAt: NOW - 2 * HOUR,
		receivedAt: NOW,
		relatedEventIds: [],
		affectedProjection: true,
		affectedFinding: false,
	};
	assert.ok(eventDetailView(base, '').includes('Received 2h after it occurred'));
	assert.ok(!eventDetailView({ ...base, receivedAt: base.occurredAt }, '').includes('after it occurred'));
});

// ── findings ─────────────────────────────────────────────────────────────────

test('the findings list carries the screen-spec columns', () => {
	const html = findingsListView(
		{},
		[{ id: 'f1', orderId: '1048', status: 'unconfirmed', detectedAt: NOW - HOUR, paidAt: NOW - DAY, deadline: NOW - 2 * HOUR }],
		NOW,
		'',
	);
	for (const header of ['Order', 'Paid', 'Confirmation expected by', 'Open for', 'Status']) {
		assert.ok(html.includes(`>${header}</s-table-header>`), `missing the ${header} column`);
	}
	assert.equal((html.match(/<time /g) ?? []).length, 2, 'paid and expected-by both render as real timestamps');
	assert.ok(html.includes('1h'), 'open-for elapsed');
});

test('open-for is blank for findings that are no longer open', () => {
	const html = findingsListView({}, [{ id: 'f1', orderId: '1', status: 'resolved', detectedAt: NOW - DAY }], NOW, '');
	assert.ok(!html.includes('>24h<'), 'a resolved finding is not "open for" anything');
});

test('"why this qualified" is shown only while confirmation is absent', () => {
	assert.ok(findingDetailView(finding(), NOW, '').includes('Why this qualified'));
	assert.ok(!findingDetailView(finding({ status: 'resolved' }), NOW, '').includes('Why this qualified'));
});

test('the observed timeline is chronological and cites only observations', () => {
	const entries = observedTimeline(finding(), NOW - 5 * MIN);
	assert.deepEqual(
		entries.map((e) => e.text),
		[
			'Order paid',
			`Fulfillment confirmation expected by ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(NOW - 2 * HOUR))}`,
			'No qualifying fulfillment confirmation observed',
			'Last reconciled directly with Shopify',
		],
	);
	for (let i = 1; i < entries.length; i++) assert.ok(entries[i].at >= entries[i - 1].at, 'sorted by time');
});

test('a resolved finding’s timeline records the confirmation that arrived', () => {
	const entries = observedTimeline(
		finding({ status: 'resolved', projection: { orderId: '1048', paidAt: NOW - 26 * HOUR, fulfilledAt: NOW - MIN } }),
		undefined,
	);
	assert.ok(entries.some((e) => e.text === 'Fulfillment confirmation observed in Shopify'));
});

test('a suppressed finding’s timeline explains why confirmation stopped being expected', () => {
	const cancelled = observedTimeline(finding({ status: 'suppressed', projection: { orderId: '1', cancelledAt: NOW - MIN } }), undefined);
	assert.ok(cancelled.some((e) => e.text.includes('cancelled — confirmation no longer expected')));
	const refunded = observedTimeline(finding({ status: 'suppressed', projection: { orderId: '1', fullyRefundedAt: NOW - MIN } }), undefined);
	assert.ok(refunded.some((e) => e.text.includes('refunded — confirmation no longer expected')));
});

test('a finding always names its rule version and evidence', () => {
	const html = findingDetailView(finding(), NOW, '');
	assert.ok(html.includes('Rule version'));
	assert.ok(html.includes('#/events/s%3Ae1'), 'evidence links to the immutable events');
});

// ── privacy ──────────────────────────────────────────────────────────────────

function privacy(over: Partial<Privacy> = {}): Privacy {
	return {
		shop: 's.myshopify.com',
		retentionDays: 7,
		storesCustomerPii: false,
		scopes: ['read_orders', 'read_fulfillments'],
		dataCategories: ['order status & timestamps'],
		excludedFields: ['customer name', 'customer email', 'customer phone', 'shipping & billing address'],
		deletion: { onUninstall: 'shop data erased' },
		footprint: { events: 10, orders: 4, findings: 1 },
		webhooks: { received: 10, processed: 9, deadLettered: 1, healthy: false, lastReceivedAt: NOW - MIN },
		reconciliation: { lastReconciledAt: NOW - 4 * MIN, ageMs: 4 * MIN, stale: false, state: 'ready' },
		...over,
	};
}

test('the privacy screen discloses everything the screen spec requires', () => {
	const html = privacyView(privacy(), NOW, '');
	assert.ok(html.includes('No customer PII is stored'));
	assert.ok(html.includes('s.myshopify.com'), 'installed shop');
	assert.ok(html.includes('read_orders') && html.includes('read_fulfillments'), 'granted scopes');
	assert.ok(html.includes('What we never store'), 'the exclusion list, not just the inclusion list');
	assert.ok(html.includes('customer email'));
	assert.ok(html.includes('7 days, then permanently purged'), 'retention');
	assert.ok(html.includes('needs attention'), 'webhook health reflects the dead letter');
	assert.ok(html.includes('Reconciliation'), 'reconciliation health');
	assert.ok(html.includes('shop data erased'), 'deletion explanation');
});

test('the privacy screen never renders secrets or another tenant', () => {
	const html = privacyView(privacy(), NOW, '');
	for (const forbidden of ['shpat_', 'shpss_', 'accessToken', 'Bearer']) {
		assert.ok(!html.includes(forbidden), `${forbidden} must never appear`);
	}
});

test('a shop with no scopes recorded says so rather than showing an empty list', () => {
	assert.ok(privacyView(privacy({ scopes: [] }), NOW, '').includes('read-only scopes pending confirmation'));
});

// ── shell states ─────────────────────────────────────────────────────────────

test('an expired session is distinguished from a recoverable error', () => {
	const expired = authExpiredView();
	assert.ok(expired.includes('Session expired'));
	assert.ok(expired.includes('recording continued in the background'), 'reassures that no data was lost');
	assert.ok(!expired.includes('data-retry'), 'reloading in Admin is the action, not an in-app retry');

	const failed = errorViewMarkup('503 upstream');
	assert.ok(failed.includes('data-retry'), 'a recoverable error offers a retry');
	assert.ok(failed.includes('503 upstream'));
});

// ── support surface ──────────────────────────────────────────────────────────

test('support is offered on the two screens where a merchant is stuck', () => {
	setSupport({ email: 'help@example.com' });
	try {
		assert.ok(authExpiredView().includes('mailto:help@example.com'), 'an expired session offers help');
		assert.ok(errorViewMarkup('503 upstream').includes('mailto:help@example.com'), 'so does a load failure');
		assert.ok(privacyView(privacy(), NOW, '').includes('mailto:help@example.com'), 'and the Privacy screen');
	} finally {
		setSupport(undefined);
	}
});

test('an unconfigured deployment promises no support it cannot deliver', () => {
	setSupport(undefined);
	assert.ok(!authExpiredView().includes('Need help?'), 'no empty offer of help');
	assert.ok(!errorViewMarkup('503').includes('Need help?'));
	// The Privacy screen is where an operator would notice, so it says so there.
	assert.ok(privacyView(privacy(), NOW, '').includes('Support contact is not configured'));
});

test('the Privacy screen links the public policy', () => {
	assert.ok(privacyView(privacy(), NOW, '').includes('href="/privacy-policy"'));
});

test('a hostile support value cannot inject markup into the app', () => {
	setSupport({ email: '"><img src=x onerror=alert(1)>', url: '"><script>alert(1)</script>' });
	try {
		const html = privacyView(privacy(), NOW, '');
		assert.ok(!html.includes('<img src=x'));
		assert.ok(!html.includes('<script>alert(1)</script>'));
	} finally {
		setSupport(undefined);
	}
});

// ── Polaris markup ───────────────────────────────────────────────────────────

test('screens are built from Polaris components, not hand-rolled markup', () => {
	const screens = [
		overviewView({ ...OVERVIEW_BASE, summary: summary() }),
		eventsView({}, [], false, ''),
		findingsListView({}, [], NOW, ''),
		findingDetailView(finding(), NOW, ''),
		privacyView(privacy(), NOW, ''),
		setupView(setup()),
	];
	for (const html of screens) {
		assert.ok(html.includes('<s-page heading='), 'every screen is an s-page');
		assert.ok(html.includes('<s-section'), 'content sits in s-sections');
		// Guard against regressing to the pre-Polaris CSS classes.
		for (const legacy of ['class="notice', 'class="grid"', 'class="stat', 'class="chip', 'class="filters']) {
			assert.ok(!html.includes(legacy), `legacy markup ${legacy} reintroduced`);
		}
	}
});

test('detail screens offer a breadcrumb back to their list', () => {
	assert.ok(findingDetailView(finding(), NOW, '').includes('slot="breadcrumb-actions" href="#/findings"'));
	const event: EventDetail = {
		eventId: 'e1',
		domain: 'order',
		source: 'webhook',
		occurredAt: NOW,
		receivedAt: NOW,
		relatedEventIds: [],
		affectedProjection: false,
		affectedFinding: false,
	};
	assert.ok(eventDetailView(event, '').includes('slot="breadcrumb-actions" href="#/events"'));
});

// ── routing ──────────────────────────────────────────────────────────────────

test('parseHash resolves every route and its filters', () => {
	assert.deepEqual(parseHash(''), { path: '/', params: {} });
	assert.deepEqual(parseHash('#/'), { path: '/', params: {} });
	assert.deepEqual(parseHash('#/setup'), { path: '/setup', params: {} });
	assert.deepEqual(parseHash('#/events?domain=order&sku=A'), { path: '/events', params: { domain: 'order', sku: 'A' } });
	assert.deepEqual(parseHash('#/findings?status=unconfirmed'), { path: '/findings', params: { status: 'unconfirmed' } });
	assert.deepEqual(parseHash('#/events/s%3Ae1'), { path: '/events/s%3Ae1', params: {} });
});

// ── admin deep links ─────────────────────────────────────────────────────────

test('an admin deep link is built from the store handle and opens the top frame', () => {
	setShop('acme-store.myshopify.com');
	assert.equal(storeHandle(), 'acme-store');
	assert.equal(adminOrderUrl('7518851989809'), 'https://admin.shopify.com/store/acme-store/orders/7518851989809');
	const link = adminOrderLink('7518851989809');
	assert.match(link, /target="_top"/);
	assert.match(link, /admin\.shopify\.com\/store\/acme-store\/orders\/7518851989809/);
});

test('with no known shop there is no fabricated admin link', () => {
	setShop(undefined);
	assert.equal(adminOrderUrl('1'), undefined);
	assert.equal(adminOrderLink('1'), '');
});

test('a hostile order id cannot escape the admin link attribute', () => {
	setShop('acme-store.myshopify.com');
	const link = adminOrderLink('1"><script>alert(1)</script>');
	assert.doesNotMatch(link, /<script>alert/);
});

test('findings and needs-attention rows show the order name when known', () => {
	setShop('acme-store.myshopify.com');
	const item: FindingItem = {
		id: 'f1',
		orderId: '7518851989809',
		orderName: '#1001',
		status: 'unconfirmed',
		detectedAt: NOW - HOUR,
		paidAt: NOW - 73 * HOUR,
		deadline: NOW - HOUR,
	};
	assert.match(findingsListView({}, [item], NOW, ''), /#1001/);
	assert.match(needsAttention([item], NOW), /#1001/);
});

test('findings fall back to the raw order id when no name was captured', () => {
	setShop(undefined);
	const item: FindingItem = { id: 'f1', orderId: '7518851989809', status: 'unconfirmed', detectedAt: NOW - HOUR };
	assert.match(findingsListView({}, [item], NOW, ''), /7518851989809/);
});

// ── orders ───────────────────────────────────────────────────────────────────

function order(over: Partial<OrderItem> = {}): OrderItem {
	return {
		orderId: '7518851989809',
		orderName: '#1001',
		state: 'awaiting',
		paidAt: NOW - 30 * HOUR,
		ageHours: 30,
		orderTotal: 129.95,
		currency: 'USD',
		...over,
	};
}

test('the orders worklist shows the merchant-facing name, lane, age and value', () => {
	const html = ordersView({}, [order()], false, '');
	assert.match(html, /#1001/);
	assert.match(html, /awaiting/);
	// Fixture is 30h old (paidAt: NOW - 30 * HOUR) — past the 24h cutoff, so it
	// renders as the multi-day format, not the plain-hours one.
	assert.match(html, /1d 6h/);
	assert.match(html, /\$129\.95|129\.95/);
});

test('the age cell renders plain hours under the 24h cutoff and days+hours past it', () => {
	assert.ok(ordersView({}, [order({ ageHours: 6 })], false, '').includes('<s-table-cell>6h</s-table-cell>'));
	assert.ok(ordersView({}, [order({ ageHours: 30 })], false, '').includes('<s-table-cell>1d 6h</s-table-cell>'));
});

test('an order with no name falls back to its id so the row is never blank', () => {
	const html = ordersView({}, [order({ orderName: undefined })], false, '');
	assert.match(html, /7518851989809/);
});

test('a failed fulfillment attempt is flagged on the row without accusing anyone', () => {
	const html = ordersView({}, [order({ fulfillmentFailedAt: NOW - 20 * HOUR })], false, '');
	assert.match(html, /attempt did not succeed|failed attempt/i);
	assert.doesNotMatch(html, /warehouse|carrier|vendor|3PL/i);
});

test('the orders screen offers lane, age and sort filters reflected in the URL', () => {
	const html = ordersView({ state: 'awaiting', minAgeHours: '24', sort: 'oldest' }, [order()], false, '');
	assert.match(html, /id="f-state"/);
	assert.match(html, /id="f-minAgeHours"/);
	assert.match(html, /id="f-sort"/);
	assert.match(html, /value="awaiting" selected/);
	assert.match(html, /value="24" selected/);
	assert.match(html, /value="oldest" selected/);
});

test('an empty worklist says so rather than rendering an empty table', () => {
	assert.match(ordersView({}, [], false, ''), /No orders match/);
});

test('load more appears only when there is another page', () => {
	assert.match(ordersView({}, [order()], true, ''), /id="loadMore"/);
	assert.doesNotMatch(ordersView({}, [order()], false, ''), /id="loadMore"/);
});

test('a hostile order name cannot inject markup', () => {
	const html = ordersView({}, [order({ orderName: '"><script>alert(1)</script>' })], false, '');
	assert.doesNotMatch(html, /<script>alert/);
});

test('money renders with its currency and omits gracefully when absent', () => {
	assert.match(money(129.95, 'USD'), /129\.95/);
	assert.equal(money(undefined, 'USD'), '—');
	assert.equal(money(129.95, undefined), '129.95');
});

test('the orders screen is Polaris markup like every other screen', () => {
	const html = ordersView({}, [order()], false, '');
	assert.match(html, /<s-page/);
	assert.match(html, /<s-section/);
	assert.match(html, /<s-table/);
});

function orderDetail(over: Partial<OrderDetail> = {}): OrderDetail {
	return {
		orderId: '7518851989809',
		orderName: '#1001',
		state: 'awaiting',
		paidAt: NOW - 30 * HOUR,
		ageHours: 30,
		orderTotal: 129.95,
		currency: 'USD',
		requiresFulfillment: true,
		events: [],
		findings: [],
		...over,
	};
}

test('the order timeline is chronological and every entry is an observation', () => {
	// orderTimeline checks fields in a fixed order — paid, failed attempt, fulfilled,
	// cancelled, refunded — so a fixture whose insertion order already matches time
	// order would pass even with the trailing .sort() deleted. These timestamps are
	// deliberately out of that check order: the cancellation is recorded before the
	// failed-attempt entry, which Shopify reports later (an attempt already in flight
	// can still fail after the order was cancelled), so an unsorted implementation
	// would emit the failed-attempt entry before the cancellation entry.
	const entries = orderTimeline(orderDetail({ paidAt: 100, fulfillmentFailedAt: 500, cancelledAt: 300 }));
	assert.deepEqual(
		entries.map((e) => e.at),
		[100, 300, 500],
	);
	assert.match(entries[0].text, /paid/i);
	assert.match(entries[1].text, /cancelled/i);
	assert.match(entries[2].text, /did not succeed/i);
	for (let i = 1; i < entries.length; i++) assert.ok(entries[i].at >= entries[i - 1].at, 'sorted by time');
});

test('a later fulfillment confirmation appears after the payment in the timeline', () => {
	const entries = orderTimeline(orderDetail({ paidAt: NOW - 40 * HOUR, fulfilledAt: NOW - 10 * HOUR }));
	assert.deepEqual(
		entries.map((e) => e.text),
		['Order paid', 'Fulfillment confirmation observed in Shopify'],
	);
});

test('order detail renders the timeline, the events, and any findings', () => {
	const html = orderDetailView(
		orderDetail({
			events: [
				{
					eventId: 's1:e1',
					domain: 'order',
					topic: 'orders/paid',
					source: 'webhook',
					occurredAt: NOW - 30 * HOUR,
					receivedAt: NOW - 30 * HOUR,
				},
			],
			findings: [
				{
					id: 'f1',
					orderId: '7518851989809',
					status: 'unconfirmed',
					detectedAt: NOW - 2 * HOUR,
					description: 'No Shopify fulfillment confirmation was observed for this paid, fulfillment-eligible order by the expected time.',
				},
			],
		}),
		'',
	);
	assert.match(html, /#1001/);
	assert.match(html, /What Sightline observed/);
	assert.match(html, /orders\/paid/);
	assert.match(html, /No Shopify fulfillment confirmation/);
});

test('order detail has a breadcrumb back to the worklist', () => {
	assert.match(orderDetailView(orderDetail(), ''), /href="#\/orders"/);
});

test('an order with nothing but a payment still renders, with an empty-state note', () => {
	const html = orderDetailView(orderDetail({ events: [], findings: [] }), '');
	assert.match(html, /No events recorded|No findings/);
});

test('order detail never claims a downstream party failed', () => {
	const html = orderDetailView(orderDetail({ fulfillmentFailedAt: NOW - 5 * HOUR }), '');
	assert.doesNotMatch(html, /warehouse|carrier|vendor|3PL/i);
});

test('a hostile order name cannot inject markup on the order detail screen', () => {
	// orderLabel() surfaces the name twice — the page heading (page()) and the
	// fields table (fields()) — and both must escape it independently.
	const html = orderDetailView(orderDetail({ orderName: '"><script>alert(1)</script>' }), '');
	assert.doesNotMatch(html, /<script>alert/);
	assert.match(html, /heading="Order &quot;&gt;&lt;script&gt;/, 'the page heading escapes the name');
	assert.match(html, /<s-table-cell>&quot;&gt;&lt;script&gt;/, 'the fields table escapes the name');
});
