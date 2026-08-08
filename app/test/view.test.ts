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
	bucketMaxHours,
	bucketMinHours,
	contextStrip,
	errorViewMarkup,
	authExpiredView,
	detectorLabel,
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
		findings: { unconfirmed: 1, resolved: 2, suppressed: 0, failedAttempts: 0 },
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

const FLOWS = { lanes: { paid: 3, fulfilled: 2, awaitingConfirmation: 1, noFulfillmentExpected: 0, cancelled: 0, refunded: 0 } };

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

test('an unlabelled detector degrades to a readable fallback rather than a blank cell', () => {
	assert.equal(detectorLabel(undefined), 'No confirmation observed');
	assert.equal(detectorLabel('something_new'), 'something_new');
});

test('findings show which detector produced them', () => {
	const absence: FindingItem = {
		id: 'f1',
		orderId: 'o1',
		orderName: '#1001',
		detector: 'fulfillment_confirmation',
		status: 'unconfirmed',
		detectedAt: NOW - HOUR,
	};
	const failed: FindingItem = {
		id: 'f2',
		orderId: 'o2',
		orderName: '#1002',
		detector: 'fulfillment_attempt_failed',
		status: 'unconfirmed',
		detectedAt: NOW - HOUR,
	};
	const html = findingsListView({}, [absence, failed], NOW, '');
	// Scoped to each row's own Order cell + the Type cell immediately after it, so
	// a label appearing anywhere else on the page (e.g. a filter option) can't make
	// this pass for the wrong row.
	assert.match(
		html,
		/<s-table-cell><s-link href="#\/findings\/f1">#1001<\/s-link><\/s-table-cell>\s*<s-table-cell>No confirmation observed<\/s-table-cell>/,
	);
	assert.match(
		html,
		/<s-table-cell><s-link href="#\/findings\/f2">#1002<\/s-link><\/s-table-cell>\s*<s-table-cell>Attempt did not succeed<\/s-table-cell>/,
	);
});

test('the findings list offers a detector filter', () => {
	const html = findingsListView({ detector: 'fulfillment_attempt_failed' }, [], NOW, '');
	// Scoped to the f-detector select itself, so a coincidental match elsewhere on
	// the page (e.g. a different control) can't make this pass.
	assert.match(
		html,
		/<s-select id="f-detector" label="Type">[\s\S]*?<option value="fulfillment_attempt_failed" selected>[\s\S]*?<\/s-select>/,
	);
});

test('the finding detail evidence table names which detector produced it', () => {
	const html = findingDetailView(
		finding({
			detector: 'fulfillment_attempt_failed',
			description: 'Shopify recorded a fulfillment attempt for this order that did not succeed.',
		}),
		undefined,
		'',
	);
	assert.match(html, /<s-table-row><s-table-cell>Type<\/s-table-cell><s-table-cell>Attempt did not succeed<\/s-table-cell><\/s-table-row>/);
});

test('the findings list states the claim boundary', () => {
	const html = findingsListView({}, [], NOW, '');
	assert.ok(html.includes(FINDINGS_BOUNDARY));
	assert.match(FINDINGS_BOUNDARY, /do not prove/);
});

test('an empty findings list mentions both the absence and the failed-attempt detector', () => {
	const html = findingsListView({}, [], NOW, '');
	assert.match(html, /No findings — nothing is missing confirmation and no attempt has failed\./);
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
		// DENY the claim. The "Failed attempts" tile label and the
		// fulfillment_attempt_failed detector id (in filter hrefs) are also legitimate:
		// that detector fires on a fulfillment Shopify itself recorded as failed, so
		// stating that is direct evidence, not an inference or an accusation against a
		// downstream party — strip them too, then nothing else may make the claim.
		const rest = html
			.replace(FINDING_DISCLAIMER, '')
			.replace(FINDINGS_BOUNDARY, '')
			.replace(/Failed attempts/g, '')
			.replace(/fulfillment_attempt_failed/g, '');
		assert.ok(!/failed/i.test(rest), 'no failure language outside the sentences/labels that are approved to use it');
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
		summary: summary({
			recorder: { healthy: false, deadLetteredDeliveries: 3 },
			findings: { unconfirmed: 0, resolved: 0, suppressed: 0, failedAttempts: 0 },
		}),
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

test('the aging breakdown links each bucket to the bucket, not to everything older', () => {
	// Every bucket, per bucket. Asserting one href (as this test used to) missed
	// that three of the four linked to a strictly larger set than they displayed:
	// the buckets are half-open intervals, `minAgeHours` alone is an open-ended
	// threshold, so "Under 24h: 1" opened the whole awaiting list.
	const html = agingView({
		buckets: AGE_BUCKETS.map((b) => ({ key: b.key, label: b.label, count: 1 })),
	});
	const expected: Record<string, string> = {
		under24: '#/orders?state=awaiting&amp;minAgeHours=0&amp;maxAgeHours=24',
		h24to48: '#/orders?state=awaiting&amp;minAgeHours=24&amp;maxAgeHours=48',
		h48to72: '#/orders?state=awaiting&amp;minAgeHours=48&amp;maxAgeHours=72',
		// The last bucket is genuinely open-ended, so it carries no upper bound.
		over72: '#/orders?state=awaiting&amp;minAgeHours=72',
	};
	for (const bucket of AGE_BUCKETS) {
		const row = html.match(new RegExp(`<s-table-row>[\\s\\S]*?${bucket.label}[\\s\\S]*?</s-table-row>`));
		assert.ok(row, `no row rendered for ${bucket.key}`);
		assert.match(
			row![0],
			new RegExp(`href="${expected[bucket.key].replace(/[?&]/g, (c) => `\\${c}`)}"`),
			`${bucket.key} links to its own set`,
		);
	}
	// Built inline rather than through esc(), so the separator must be the literal
	// entity — and must not have been escaped twice.
	assert.doesNotMatch(html, /&amp;amp;/);
	assert.doesNotMatch(html, /minAgeHours=\d+&maxAgeHours/, 'a bare & in an attribute is invalid markup');
});

test('bucketMinHours and bucketMaxHours agree with AGE_BUCKETS, and the four buckets partition', () => {
	for (const bucket of AGE_BUCKETS) {
		assert.equal(bucketMinHours(bucket.key), bucket.minHours, `bucketMinHours('${bucket.key}') must match AGE_BUCKETS`);
		assert.equal(bucketMaxHours(bucket.key), bucket.maxHours, `bucketMaxHours('${bucket.key}') must match AGE_BUCKETS`);
	}
	// Each bucket's upper bound is the next one's lower bound: contiguous, no gap,
	// and (because the query pairs `<=` with `>`) no double-count at the seam.
	for (let i = 0; i < AGE_BUCKETS.length - 1; i++) {
		assert.equal(bucketMaxHours(AGE_BUCKETS[i].key), bucketMinHours(AGE_BUCKETS[i + 1].key));
	}
	assert.equal(bucketMaxHours(AGE_BUCKETS[AGE_BUCKETS.length - 1].key), undefined, 'only the last bucket is open-ended');
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

test('the overview surfaces failed attempts as their own count, linking to the exact set it counts', () => {
	const s = summary({ findings: { unconfirmed: 3, resolved: 1, suppressed: 0, failedAttempts: 2 } });
	const html = overviewView({ summary: s, flows: null, unconfirmed: [], setup: null, now: NOW });
	// failedAttempts only counts UNCONFIRMED failed-attempt findings (a resolved or
	// suppressed one is still counted in its own status bucket) — so the link must
	// carry status=unconfirmed too, or it opens a bigger set than the tile shows
	// (the same class of defect this plan already caught on the Paid tile).
	assert.match(
		gridItem(html, 'Failed attempts'),
		/href="#\/findings\?detector=fulfillment_attempt_failed&amp;status=unconfirmed"[\s\S]*>2</,
	);
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

function event(over: Partial<EventItem> = {}): EventItem {
	return {
		eventId: 'e1',
		domain: 'order',
		source: 'webhook',
		occurredAt: NOW,
		receivedAt: NOW,
		...over,
	};
}

function eventDetail(over: Partial<EventDetail> = {}): EventDetail {
	return {
		...event(),
		relatedEventIds: [],
		affectedProjection: false,
		affectedFinding: false,
		...over,
	};
}

// ── events ───────────────────────────────────────────────────────────────────

test('the events screen offers the full screen-spec filter set', () => {
	const html = eventsView({}, [], false, '');
	for (const id of ['f-range', 'f-domain', 'f-topic', 'f-resourceId', 'f-sku', 'f-source', 'f-state']) {
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
		{ range: '24h', domain: 'fulfillment', topic: 'fulfillments/create', sku: 'SKU-1', source: 'reconciliation', state: 'error' },
		[],
		false,
		'',
	);
	assert.ok(html.includes('<option value="24h" selected>'));
	assert.ok(html.includes('<option value="fulfillment" selected>'));
	assert.ok(html.includes('<option value="reconciliation" selected>'));
	assert.ok(html.includes('value="fulfillments/create"'));
	assert.ok(html.includes('value="SKU-1"'));
	assert.ok(
		html.includes('id="f-state" label="State" placeholder="error" value="error"'),
		'a failed attempt can be found directly by state',
	);
});

test('eventQuery turns a symbolic range into a window floor', () => {
	assert.deepEqual(eventQuery({ range: '24h' }, NOW), { since: String(NOW - DAY) });
	assert.deepEqual(eventQuery({ range: '1h', domain: 'order' }, NOW), { domain: 'order', since: String(NOW - HOUR) });
	assert.deepEqual(eventQuery({}, NOW), {}, 'no range means the full retention window');
	assert.deepEqual(eventQuery({ range: 'bogus' }, NOW), {}, 'an unknown range is ignored, not passed through');
	assert.deepEqual(eventQuery({ state: 'error' }, NOW), { state: 'error' }, 'the state filter passes through to the API query');
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

test('the SKU cell shows every SKU on a multi-SKU event', () => {
	const html = eventsView({}, [event({ skus: ['STICKER-PK', 'TSHIRT-BLK-M'], sku: undefined })], false, '');
	assert.match(html, /STICKER-PK/);
	assert.match(html, /TSHIRT-BLK-M/);
});

test('the SKU cell falls back to the scalar, then to an em dash', () => {
	assert.match(eventsView({}, [event({ skus: undefined, sku: 'ONLY-ONE' })], false, ''), /ONLY-ONE/);
	assert.match(eventsView({}, [event({ skus: undefined, sku: undefined })], false, ''), /—/);
});

test('an inventory row shows its resolved SKU rather than only a numeric id', () => {
	const html = eventsView(
		{},
		[event({ domain: 'inventory', resourceId: '8400000000001', skus: ['TSHIRT-BLK-M'], sku: undefined })],
		false,
		'',
	);
	assert.match(html, /TSHIRT-BLK-M/);
});

test('event detail names the product and location behind an inventory id', () => {
	const html = eventDetailView(
		{
			...eventDetail(),
			domain: 'inventory',
			resourceId: '8400000000001',
			inventorySku: 'TSHIRT-BLK-M',
			productTitle: 'T-Shirt',
			locationName: 'Brooklyn',
		},
		'',
	);
	assert.match(html, /TSHIRT-BLK-M/);
	assert.match(html, /T-Shirt/);
	assert.match(html, /Brooklyn/);
});

test('event detail omits the enrichment rows when nothing is resolved', () => {
	const html = eventDetailView({ ...eventDetail(), inventorySku: undefined, productTitle: undefined, locationName: undefined }, '');
	assert.doesNotMatch(html, /Inventory SKU|Product|Location name/);
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
	const list = findingsListView({}, [item], NOW, '');
	const attention = needsAttention([item], NOW);
	assert.match(list, /#1001/);
	assert.match(attention, /#1001/);
	// The task's core promise: a way into Shopify Admin from the row, not just the
	// merchant-facing name. Regression-proofs findingsListView and needsAttention
	// each still call adminOrderLink for their order cell.
	assert.match(list, /admin\.shopify\.com\/store\/acme-store\/orders\/7518851989809/);
	assert.match(attention, /admin\.shopify\.com\/store\/acme-store\/orders\/7518851989809/);
});

test('findings fall back to the raw order id when no name was captured', () => {
	setShop(undefined);
	const item: FindingItem = { id: 'f1', orderId: '7518851989809', status: 'unconfirmed', detectedAt: NOW - HOUR };
	assert.match(findingsListView({}, [item], NOW, ''), /7518851989809/);
});

test('the admin link also appears on the finding detail, orders worklist, and order detail screens', () => {
	// Rounds out call-site coverage for the task's core promise: every screen that
	// names an order also offers a way into it in Shopify Admin. A regression that
	// silently dropped the adminOrderLink(...) call from any one of these five
	// sites (findingsListView and needsAttention are covered above) would still
	// pass every other test in this file, since adminOrderUrl/adminOrderLink are
	// otherwise only exercised standalone.
	setShop('acme-store.myshopify.com');
	const orderUrl = 'admin.shopify.com/store/acme-store/orders/7518851989809';
	assert.match(findingDetailView(finding({ orderId: '7518851989809' }), NOW, ''), new RegExp(orderUrl.replace(/\./g, '\\.')));
	assert.match(ordersView({}, [order()], false, ''), new RegExp(orderUrl.replace(/\./g, '\\.')));
	assert.match(orderDetailView(orderDetail(), ''), new RegExp(orderUrl.replace(/\./g, '\\.')));
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

test('a digital order is never labelled as fulfilled, and its label claims nothing unobserved', () => {
	const html = ordersView({}, [order({ state: 'no_fulfillment_expected', fulfilledAt: undefined })], false, '');
	assert.match(html, /<s-badge tone="neutral">no fulfillment expected<\/s-badge>/, 'the raw lane value is not shown as snake_case');
	// Scoped to the table body: "fulfilled" legitimately appears in the Lane
	// select's own option list, and an unscoped search would pass on that instead of
	// on the row it is meant to be checking.
	const body = html.match(/<s-table-body>[\s\S]*<\/s-table-body>/)?.[0] ?? '';
	assert.doesNotMatch(body, /fulfilled/i, 'no row cell claims a fulfillment nobody observed');
	// "expected" is a fact about Sightline's own expectation. requiresFulfillment is
	// only ever latched true, so its absence cannot license a claim about the order
	// itself ("needs no shipping").
	assert.doesNotMatch(html, /needs no shipping|no shipping required|digital/i);
	// The same label reaches the Lane select, so the filter reads like the badge.
	assert.match(html, /<option value="no_fulfillment_expected">no fulfillment expected<\/option>/);
});

test('the overview flow lanes include the no-fulfillment-expected lane, linked to the set it counts', () => {
	const html = overviewView({
		...OVERVIEW_BASE,
		flows: { lanes: { paid: 4, fulfilled: 2, awaitingConfirmation: 1, noFulfillmentExpected: 1, cancelled: 0, refunded: 0 } },
		summary: summary(),
	});
	assert.match(
		html,
		/<s-table-cell><s-link href="#\/orders\?state=no_fulfillment_expected">No fulfillment expected<\/s-link><\/s-table-cell><s-table-cell>1<\/s-table-cell>/,
	);
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

test('the worklist names the column it is sorted on, and the sort control agrees', () => {
	// The list keysets on lastEventAt (paidAt is nullable and cannot be paged on —
	// C3), so the sort control must not promise an ordering by payment. A "Newest
	// first" label over a list sorted by last activity is a lie the merchant cannot
	// see; naming the column makes the ordering checkable on screen.
	const html = ordersView({}, [order({ lastEventAt: NOW - 2 * HOUR })], false, '');
	assert.ok(html.includes('<s-table-header format="base">Last activity</s-table-header>'), 'the sort key has a column');
	assert.match(html, /<option value="newest"[^>]*>Latest activity first<\/option>/);
	assert.match(html, /<option value="oldest"[^>]*>Earliest activity first<\/option>/);
	assert.doesNotMatch(html, /Newest first|Oldest first/, 'no label claims an ordering by payment');
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

test('every list screen offers a CSV export', () => {
	assert.match(eventsView({}, [], false, ''), /data-export="events"/);
	assert.match(findingsListView({}, [], NOW, ''), /data-export="findings"/);
	assert.match(ordersView({}, [], false, ''), /data-export="orders"/);
});
