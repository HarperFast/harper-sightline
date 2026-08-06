import {
	apiSession,
	apiSetup,
	apiSummary,
	apiFlows,
	apiEvents,
	apiEvent,
	apiFindings,
	apiFinding,
	apiPrivacy,
	type EventItem,
	type FindingDetail,
	type FindingItem,
	type Setup,
	type Summary,
} from './api.ts';

// ── helpers ──────────────────────────────────────────────────────────────────
const app = () => document.getElementById('app') as HTMLElement;

function esc(value: unknown): string {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

// Timestamps render in the viewer's own timezone — inside Shopify Admin that is
// the merchant's local time — and every one carries the exact absolute instant in
// a <time datetime> plus a title, so assistive tech and hover both get an
// unambiguous value (screen spec: "merchant timezone with an accessible exact
// timestamp"). The active zone is named once in the global context strip so a
// displayed time is never ambiguous about which zone it is in.
const TZ = (() => {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
	} catch {
		return 'local time';
	}
})();
const SHORT_FMT = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const EXACT_FMT = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'long' });
const CLOCK_FMT = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });
const DEADLINE_FMT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const DAY_FMT = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

function ts(ms: number | undefined, fmt: Intl.DateTimeFormat = SHORT_FMT): string {
	if (ms === undefined || ms === null) return '—';
	const date = new Date(ms);
	return `<time datetime="${esc(date.toISOString())}" title="${esc(EXACT_FMT.format(date))}">${esc(fmt.format(date))}</time>`;
}

// A coarse duration ("4m", "3h", "2d") for elapsed-time columns.
function elapsed(fromMs: number | undefined, toMs: number): string {
	if (!fromMs) return '—';
	const s = Math.max(0, Math.floor((toMs - fromMs) / 1000));
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	if (s < 86400) return `${Math.floor(s / 3600)}h`;
	return `${Math.floor(s / 86400)}d`;
}

function relative(fromMs: number | undefined, toMs: number): string {
	if (fromMs === undefined) return 'never';
	const s = Math.max(0, Math.floor((toMs - fromMs) / 1000));
	if (s < 60) return 'just now';
	return `${elapsed(fromMs, toMs)} ago`;
}

const STATUS_TONE: Record<string, string> = { unconfirmed: 'warn', resolved: 'ok', suppressed: 'muted', pending: 'muted', expired: 'warn' };
function badge(text: string, tone = 'muted'): string {
	return `<span class="badge badge-${esc(STATUS_TONE[text] ?? tone)}">${esc(text)}</span>`;
}

function loading(): void {
	app().innerHTML = `<p class="muted" role="status">Loading…</p>`;
}
// Auth-expired (401) is distinct from a recoverable error: the merchant needs to
// reopen the app so Shopify re-issues a session token (screen spec: every screen
// supports an authorization-expired state with a reauthorization action).
function authExpiredView(): void {
	app().innerHTML = `<div class="notice notice-warn" role="alert"><strong>Session expired.</strong> Your Shopify session timed out. Reload Sightline in Shopify Admin to reconnect — recording continued in the background the whole time.</div>`;
}
function errorView(err: unknown): void {
	app().innerHTML = `<div class="notice notice-warn" role="alert"><strong>Couldn’t load.</strong> ${esc((err as Error).message)} <button data-retry type="button">Retry</button></div>`;
	bindRetry();
}

function bindRetry(): void {
	for (const button of document.querySelectorAll<HTMLElement>('[data-retry]')) {
		button.addEventListener('click', () => {
			summaryCache = null;
			void route();
		});
	}
}

// Make whole-row links keyboard-operable (screen spec: filters/navigation are
// keyboard accessible). Rows carry role="link" + tabindex; Enter/Space activate.
function bindRowLinks(): void {
	for (const row of document.querySelectorAll<HTMLElement>('.rowlink')) {
		const go = (): void => {
			location.hash = row.dataset.href ?? '#/';
		};
		row.addEventListener('click', go);
		row.addEventListener('keydown', (ev) => {
			if (ev.key === 'Enter' || ev.key === ' ') {
				ev.preventDefault();
				go();
			}
		});
	}
}

function wrapTable(html: string): string {
	// Narrow embedded iframes (Admin on mobile) must scroll the table, never the
	// page (screen spec: mobile/narrow iframe behavior).
	return `<div class="tablewrap">${html}</div>`;
}

// ── global context strip ─────────────────────────────────────────────────────
// "Last 7 days," recording health, and last reconciliation time on every screen
// (screen spec, global behavior). Cached briefly so the strip and the Overview
// share one request.
let summaryCache: { at: number; value: Summary } | null = null;
let summaryInFlight: Promise<Summary> | null = null;
const SUMMARY_TTL_MS = 15_000;

// The context strip and the Overview both want the summary and start at the same
// moment, so concurrent callers share one in-flight request rather than issuing
// two. Retry clears the cache, which is what makes the next call refetch.
function loadSummary(): Promise<Summary> {
	if (summaryCache && Date.now() - summaryCache.at < SUMMARY_TTL_MS) return Promise.resolve(summaryCache.value);
	summaryInFlight ??= apiSummary()
		.then((value) => {
			summaryCache = { at: Date.now(), value };
			return value;
		})
		.finally(() => {
			summaryInFlight = null;
		});
	return summaryInFlight;
}

function reconChip(s: Summary, now: number): string {
	const r = s.reconciliation;
	if (r.lastReconciledAt === undefined) return `<span class="chip chip-warn">Initial check pending</span>`;
	if (r.stale) return `<span class="chip chip-warn">Reconciliation delayed — last ${esc(relative(r.lastReconciledAt, now))}</span>`;
	return `<span class="chip">Reconciled ${esc(relative(r.lastReconciledAt, now))}</span>`;
}

async function renderContext(): Promise<void> {
	const el = document.getElementById('context');
	if (!el) return;
	let s: Summary;
	try {
		s = await loadSummary();
	} catch {
		// The strip is supplementary — never let it replace a screen's own error.
		el.innerHTML = `<span class="chip">Last 7 days</span><span class="chip chip-quiet">Times in ${esc(TZ)}</span>`;
		return;
	}
	const now = Date.now();
	const health = s.recorder.healthy
		? `<span class="chip chip-ok">Recording healthy</span>`
		: `<span class="chip chip-warn">Recorder needs attention</span>`;
	el.innerHTML = `<span class="chip">Last ${s.windowDays} days</span>${health}${reconChip(s, now)}<span class="chip chip-quiet">Times in ${esc(TZ)}</span>`;
}

// ── setup / first open ───────────────────────────────────────────────────────
const SETUP_STEP_TONE: Record<string, string> = { done: 'ok', running: 'warn', waiting: 'muted', pending: 'muted', blocked: 'warn' };
const SETUP_STEP_NOTE: Record<string, string> = {
	done: 'Complete',
	running: 'In progress',
	waiting: 'Completing connection',
	pending: 'Not started',
	blocked: 'Needs reauthorization',
};

// The capture step is "connected" once subscriptions exist; whether anything has
// arrived is a separate fact, so a quiet store reads as connected-and-idle rather
// than as broken or as capture we haven't actually seen.
function setupStepNote(step: Setup['steps'][number], eventsObserved: boolean): string {
	if (step.key === 'capture' && step.state === 'done') return eventsObserved ? 'Receiving events' : 'Connected — no events yet';
	return SETUP_STEP_NOTE[step.state] ?? step.state;
}

async function setupScreen(): Promise<void> {
	loading();
	const setup = await apiSetup();
	const steps = setup.steps
		.map(
			(step, i) => `<li class="step step-${esc(SETUP_STEP_TONE[step.state] ?? 'muted')}">
			<span class="step-n">${i + 1}</span>
			<span class="step-body"><strong>${esc(step.label)}</strong><br /><span class="muted">${esc(setupStepNote(step, setup.eventsObserved))}</span></span>
		</li>`,
		)
		.join('');
	// A blocked step gets the one safe action a merchant can take; nothing here
	// writes to Shopify (screen spec §1: "a failed step gives a safe retry or
	// reauthorization action").
	const action =
		setup.action === 'reauthorize'
			? `<div class="notice notice-warn" role="alert"><strong>Reauthorization needed.</strong> Sightline’s access to your store needs to be renewed before the initial check can finish. Open Sightline from your Shopify Admin apps list to reconnect. Recording resumes automatically — nothing is lost.</div>`
			: `<p><button data-retry type="button">Check again</button></p>`;
	app().innerHTML = `
		<h2>Sightline is recording your Shopify operations</h2>
		<ol class="steps">${steps}</ol>
		<p>Sightline keeps seven days of order, fulfillment, inventory, and refund activity. It is read-only and never sits in your fulfillment path — if Sightline stops, your store’s operation is unaffected.</p>
		${
			setup.complete
				? `<div class="notice notice-ok"><strong>Setup complete.</strong> The first seven days of history are in place.</div>`
				: `<div class="notice"><strong>The initial check is still running.</strong> History is still being built, so counts and findings may be incomplete until it finishes.</div>`
		}
		${action}
		<p><a href="#/">Continue to overview</a> · <a href="#/privacy">View data we store</a></p>`;
	bindRetry();
}

// ── screens ──────────────────────────────────────────────────────────────────
const DOMAIN_LABEL: Record<string, string> = {
	order: 'Orders',
	fulfillment: 'Fulfillment',
	inventory: 'Inventory',
	refund: 'Refunds',
};

// "Activity over time" (screen spec §2). The bars convey magnitude by height and
// carry no meaning in colour; an exact per-day table sits beside them as the
// required text equivalent, and the whole graphic exposes the same numbers to
// assistive tech through its aria-label.
function activityView(a: Summary['activity']): string {
	const peak = Math.max(1, ...a.buckets.map((b) => b.total));
	const rows = a.domains
		.map((domain) => {
			const counts = a.buckets.map((b) => Number(b[domain] ?? 0));
			const total = counts.reduce((n, c) => n + c, 0);
			const bars = a.buckets
				.map((b, i) => {
					const n = counts[i];
					const height = n === 0 ? 0 : Math.max(6, Math.round((n / peak) * 100));
					return `<span class="bar" title="${esc(DAY_FMT.format(new Date(b.startAt)))}: ${n}"><span class="bar-fill" style="height:${height}%"></span></span>`;
				})
				.join('');
			return `<div class="spark-row"><span class="spark-label">${esc(DOMAIN_LABEL[domain] ?? domain)}</span><span class="spark-bars">${bars}</span><span class="spark-total">${total}</span></div>`;
		})
		.join('');
	const label =
		`Events per day over the last ${a.days} days. ` +
		a.domains.map((d) => `${DOMAIN_LABEL[d] ?? d}: ${a.buckets.map((b) => Number(b[d] ?? 0)).join(', ')}`).join('. ');
	const head = a.buckets.map((b) => `<th scope="col">${esc(DAY_FMT.format(new Date(b.startAt)))}</th>`).join('');
	const body = a.domains
		.map(
			(d) => `<tr><th scope="row">${esc(DOMAIN_LABEL[d] ?? d)}</th>${a.buckets.map((b) => `<td>${Number(b[d] ?? 0)}</td>`).join('')}</tr>`,
		)
		.join('');
	return `<h2>Activity over time</h2>
		<div class="spark" role="img" aria-label="${esc(label)}">${rows}</div>
		<details class="alt"><summary>View activity as a table</summary>
			${wrapTable(`<table class="grid"><thead><tr><th scope="col">Domain</th>${head}</tr></thead><tbody>${body}</tbody></table>`)}
		</details>`;
}

async function overview(): Promise<void> {
	loading();
	// Panels load independently so one failure degrades to partial data instead of
	// blanking the screen (screen spec: every screen supports a partial-data state).
	const [summaryResult, flowsResult, unconfirmedResult, setupResult] = await Promise.allSettled([
		loadSummary(),
		apiFlows(),
		apiFindings({ status: 'unconfirmed' }),
		apiSetup(),
	]);
	// The summary is this screen's spine — without it there is nothing honest to
	// render, so its failure is a screen-level error (or auth-expired) upstream.
	if (summaryResult.status === 'rejected') throw summaryResult.reason;
	const s = summaryResult.value;
	const now = Date.now();

	const missing: string[] = [];
	if (flowsResult.status === 'rejected') missing.push('order flow');
	if (unconfirmedResult.status === 'rejected') missing.push('needs attention');
	const partial = missing.length
		? `<div class="notice notice-warn" role="alert"><strong>Partial data.</strong> The ${esc(missing.join(' and '))} panel${missing.length > 1 ? 's' : ''} couldn’t load. Everything else on this page is current. <button data-retry type="button">Retry</button></div>`
		: '';

	// Health is a separate signal from the finding count: an unhealthy recorder
	// must never render as "no gaps" (screen spec §2).
	const health = s.recorder.healthy
		? `<div class="notice notice-ok"><strong>Recorder healthy.</strong> Capturing order, fulfillment, inventory and refund activity.</div>`
		: `<div class="notice notice-warn" role="alert"><strong>Recorder needs attention:</strong> ${s.recorder.deadLetteredDeliveries} deliver(ies) could not be processed. Gap results may be incomplete.</div>`;

	// Stale reconciliation is its own state: counts below are still real, but they
	// may lag Shopify, so the screen says so rather than implying completeness.
	const stale =
		s.reconciliation.stale && s.reconciliation.lastReconciledAt !== undefined
			? `<div class="notice notice-warn" role="alert"><strong>Reconciliation delayed.</strong> Sightline last checked Shopify directly ${esc(relative(s.reconciliation.lastReconciledAt, now))}. Webhook capture is unaffected, but very recent changes may not appear yet.</div>`
			: '';

	// Before the first check completes there is genuinely no seven-day history, so
	// the screen must not present these counts as a full picture (spec §1).
	const backfill =
		setupResult.status === 'fulfilled' && !setupResult.value.complete
			? `<div class="notice"><strong>Initial check still running.</strong> Sightline is still building the first seven days of history — counts below may be incomplete. <a href="#/setup">View setup</a></div>`
			: '';

	const stat = (label: string, value: number) =>
		`<div class="stat"><div class="stat-value">${value}</div><div class="stat-label">${esc(label)}</div></div>`;
	const lane = (label: string, n: number) => `<div class="lane"><span>${esc(label)}</span><span class="lane-count">${n}</span></div>`;
	const flows =
		flowsResult.status === 'fulfilled'
			? `<h2>Order → fulfillment</h2>
				<div class="lanes">
					${lane('Paid', flowsResult.value.lanes.paid)}${lane('Fulfilled', flowsResult.value.lanes.fulfilled)}${lane('Awaiting confirmation', flowsResult.value.lanes.awaitingConfirmation)}${lane('Cancelled', flowsResult.value.lanes.cancelled)}${lane('Refunded', flowsResult.value.lanes.refunded)}
				</div>`
			: '';

	app().innerHTML = `
		${health}
		${stale}
		${backfill}
		${partial}
		<h2>Orders (last ${s.windowDays} days)</h2>
		<div class="stats">
			${stat('Tracked', s.orders.tracked)}${stat('Paid', s.orders.paid)}${stat('Fulfilled', s.orders.fulfilled)}${stat('Awaiting confirmation', s.orders.awaitingConfirmation)}
		</div>
		<h2>Findings</h2>
		<div class="stats">
			${stat('Unconfirmed', s.findings.unconfirmed)}${stat('Resolved', s.findings.resolved)}${stat('Suppressed', s.findings.suppressed)}
		</div>
		${flows}
		${s.activity ? activityView(s.activity) : ''}
		${unconfirmedResult.status === 'fulfilled' ? needsAttention(unconfirmedResult.value.items, now) : ''}
		<p class="muted">${s.events.total} normalized events recorded in the window.</p>`;
	bindRowLinks();
	bindRetry();
}

// The overview's "needs attention" list: recent orders with no observed Shopify
// fulfillment confirmation. Copy is non-accusatory (screen spec §2) — it never
// says a warehouse/carrier failed, only that Shopify has not shown confirmation.
function needsAttention(items: FindingItem[], now: number): string {
	if (!items.length) return `<h2>Needs attention</h2><p class="muted">Nothing is awaiting confirmation.</p>`;
	const rows = items
		.slice(0, 5)
		.map(
			(
				x,
			) => `<tr class="rowlink" tabindex="0" role="link" aria-label="Order ${esc(x.orderId)}, open finding detail" data-href="#/findings/${encodeURIComponent(x.id)}">
			<td>${esc(x.orderId)}</td><td>No Shopify fulfillment confirmation observed</td><td>${esc(elapsed(x.detectedAt, now))}</td></tr>`,
		)
		.join('');
	return `<h2>Needs attention</h2>
		${wrapTable(`<table class="grid"><thead><tr><th>Order</th><th>Observation</th><th>Open for</th></tr></thead><tbody>${rows}</tbody></table>`)}`;
}

const DOMAINS = ['', 'order', 'fulfillment', 'inventory', 'refund'];
const SOURCES = ['', 'webhook', 'reconciliation'];
// Time filter kept as a symbolic range in the URL rather than a frozen timestamp,
// so a shared/bookmarked filter stays meaningful (screen spec §3: filters are
// reflected in the URL).
const RANGES: Array<[string, string, number]> = [
	['', 'Any time in window', 0],
	['1h', 'Last hour', 3_600_000],
	['24h', 'Last 24 hours', 86_400_000],
	['7d', 'Last 7 days', 604_800_000],
];
const EVENT_FILTER_KEYS = ['domain', 'topic', 'resourceId', 'sku', 'source', 'range'];

let eventItems: EventItem[] = [];
let eventCursor: string | undefined;
// The resolved query for the current result set. Held so "Load more" pages
// against the SAME window — recomputing `since` per page would drift the floor
// forward between pages and could skip a boundary row.
let eventQueryActive: Record<string, string> = {};

// Translate the UI filter params into API query params (range → since).
function eventQuery(params: Record<string, string>): Record<string, string> {
	const q: Record<string, string> = {};
	for (const key of ['domain', 'topic', 'resourceId', 'sku', 'source']) {
		if (params[key]) q[key] = params[key];
	}
	const range = RANGES.find(([value]) => value && value === params.range);
	if (range) q.since = String(Date.now() - range[2]);
	return q;
}

async function eventsList(params: Record<string, string>): Promise<void> {
	loading();
	eventItems = [];
	eventCursor = undefined;
	eventQueryActive = eventQuery(params);
	const page = await apiEvents(eventQueryActive);
	eventItems = page.items;
	eventCursor = page.nextCursor;
	renderEvents(params);
}

function renderEvents(params: Record<string, string>): void {
	const rows = eventItems
		.map(
			(
				e,
			) => `<tr class="rowlink" tabindex="0" role="link" aria-label="${esc(e.topic ?? e.domain)} ${esc(e.resourceId ?? '')}, open event detail" data-href="#/events/${encodeURIComponent(e.eventId)}">
			<td>${ts(e.occurredAt)}</td><td>${esc(e.domain)}</td><td>${esc(e.topic ?? '')}</td>
			<td>${esc(e.resourceId ?? '')}</td><td>${esc(e.sku ?? '')}${e.quantity !== undefined ? ` ×${e.quantity}` : ''}</td>
			<td>${e.state ? badge(e.state) : ''}</td><td>${esc(e.source)}</td></tr>`,
		)
		.join('');
	const options = (values: readonly string[], selected: string, anyLabel: string) =>
		values.map((v) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(v || anyLabel)}</option>`).join('');
	const rangeOptions = RANGES.map(
		([value, label]) => `<option value="${esc(value)}"${value === (params.range ?? '') ? ' selected' : ''}>${esc(label)}</option>`,
	).join('');
	app().innerHTML = `
		<form id="eventFilters" class="filters" role="search">
			<select name="range" aria-label="Filter by time">${rangeOptions}</select>
			<select name="domain" aria-label="Filter by domain">${options(DOMAINS, params.domain ?? '', 'Any domain')}</select>
			<input name="topic" placeholder="Topic (e.g. orders/paid)" aria-label="Event topic" value="${esc(params.topic ?? '')}" />
			<input name="resourceId" placeholder="Order / resource ID" aria-label="Order or resource ID" value="${esc(params.resourceId ?? '')}" />
			<input name="sku" placeholder="SKU" aria-label="SKU" value="${esc(params.sku ?? '')}" />
			<select name="source" aria-label="Filter by evidence source">${options(SOURCES, params.source ?? '', 'Any source')}</select>
			<button type="submit">Search</button>
		</form>
		${wrapTable(`<table class="grid"><thead><tr><th>Time</th><th>Domain</th><th>Topic</th><th>Resource</th><th>SKU</th><th>State</th><th>Source</th></tr></thead>
		<tbody>${rows || `<tr><td colspan="7" class="muted">No events match.</td></tr>`}</tbody></table>`)}
		${eventCursor ? `<button id="loadMore">Load more</button>` : ''}`;
	document.getElementById('eventFilters')?.addEventListener('submit', (ev) => {
		ev.preventDefault();
		const fd = new FormData(ev.target as HTMLFormElement);
		const q = new URLSearchParams();
		for (const k of EVENT_FILTER_KEYS) {
			const v = String(fd.get(k) ?? '').trim();
			if (v) q.set(k, v);
		}
		location.hash = `#/events${q.toString() ? `?${q}` : ''}`;
	});
	document.getElementById('loadMore')?.addEventListener('click', async () => {
		const page = await apiEvents({ ...eventQueryActive, cursor: eventCursor });
		eventItems.push(...page.items);
		eventCursor = page.nextCursor;
		renderEvents(params);
	});
	bindRowLinks();
}

async function eventDetail(id: string): Promise<void> {
	loading();
	const e = await apiEvent(id);
	const field = (label: string, value: string) => `<div class="field"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
	const related = e.relatedEventIds.length
		? e.relatedEventIds.map((r) => `<a href="#/events/${encodeURIComponent(r)}">${esc(r.split(':').pop())}</a>`).join(', ')
		: '<span class="muted">none</span>';
	// A receipt later than the occurrence is normal (at-least-once, unordered
	// delivery) and is shown as such — it never reorders the ledger (spec §3).
	const delayed =
		e.receivedAt > e.occurredAt + 60_000
			? `<p class="muted">Received ${esc(elapsed(e.occurredAt, e.receivedAt))} after it occurred. Delayed or out-of-order receipt does not change an event’s place in the timeline.</p>`
			: '';
	app().innerHTML = `
		<a href="#/events" class="back">← Events</a>
		<h2>${esc(e.domain)} · ${esc(e.topic ?? '')}</h2>
		<dl class="fields">
			${field('Resource', esc(e.resourceId ?? '—'))}
			${field('State', e.state ? badge(e.state) : '—')}
			${field('SKU', esc(e.sku ?? '—'))}
			${field('Quantity', e.quantity !== undefined ? String(e.quantity) : '—')}
			${field('Fulfillment-eligible units', e.fulfillableItemCount !== undefined ? String(e.fulfillableItemCount) : '—')}
			${field('Occurred (source)', ts(e.occurredAt))}
			${field('Received', ts(e.receivedAt))}
			${field('Source', esc(e.source))}
			${field('Affected a projection', e.affectedProjection ? 'Yes' : 'No')}
			${field('Affected a finding', e.affectedFinding ? 'Yes' : 'No')}
			${field('Related events', related)}
		</dl>
		${delayed}`;
}

// The claim boundary, stated on the findings list as well as each detail: absence
// of an observed confirmation is not evidence that any downstream party failed.
const FINDINGS_BOUNDARY =
	'Findings describe what Sightline has observed in Shopify. They do not prove that a warehouse, carrier, or vendor failed.';
// Verbatim from the screen specification (§4). This sentence is the product-truth
// guardrail for the whole app — do not reword it.
const FINDING_DISCLAIMER =
	'This does not prove that a warehouse or carrier failed. It means Shopify has not shown the expected fulfillment confirmation yet.';

const STATUSES = ['', 'unconfirmed', 'resolved', 'suppressed'];
async function findingsList(params: Record<string, string>): Promise<void> {
	loading();
	const page = await apiFindings(params);
	const now = Date.now();
	const rows = page.items
		.map(
			(
				x: FindingItem,
			) => `<tr class="rowlink" tabindex="0" role="link" aria-label="Order ${esc(x.orderId)}, ${esc(x.status)}, open finding detail" data-href="#/findings/${encodeURIComponent(x.id)}">
			<td>${esc(x.orderId)}</td><td>${ts(x.paidAt)}</td><td>${ts(x.deadline)}</td>
			<td>${x.status === 'unconfirmed' ? esc(elapsed(x.detectedAt, now)) : '—'}</td><td>${badge(x.status)}</td></tr>`,
		)
		.join('');
	const sel = STATUSES.map(
		(s) => `<option value="${s}"${s === (params.status ?? '') ? ' selected' : ''}>${s || 'Any status'}</option>`,
	).join('');
	app().innerHTML = `
		<p class="muted">${esc(FINDINGS_BOUNDARY)}</p>
		<form id="findingFilters" class="filters" role="search"><select name="status" aria-label="Filter by status">${sel}</select><button type="submit">Filter</button></form>
		${wrapTable(`<table class="grid"><thead><tr><th>Order</th><th>Paid</th><th>Confirmation expected by</th><th>Open for</th><th>Status</th></tr></thead>
		<tbody>${rows || `<tr><td colspan="5" class="muted">No findings — nothing is missing confirmation.</td></tr>`}</tbody></table>`)}`;
	document.getElementById('findingFilters')?.addEventListener('submit', (ev) => {
		ev.preventDefault();
		const v = String(new FormData(ev.target as HTMLFormElement).get('status') ?? '');
		location.hash = `#/findings${v ? `?status=${v}` : ''}`;
	});
	bindRowLinks();
}

// "What Sightline observed" (screen spec §4): the finding's evidence as a
// chronological record. Every entry is an observation with a source timestamp —
// nothing here is inferred about a downstream system.
function observedTimeline(f: FindingDetail, lastReconciledAt: number | undefined): Array<{ at: number; text: string }> {
	const p = f.projection;
	const entries: Array<{ at: number; text: string }> = [];
	if (p?.paidAt !== undefined) entries.push({ at: p.paidAt, text: 'Order paid' });
	if (f.expectation?.deadline !== undefined)
		entries.push({
			at: f.expectation.deadline,
			text: `Fulfillment confirmation expected by ${DEADLINE_FMT.format(new Date(f.expectation.deadline))}`,
		});
	if (f.detectedAt !== undefined) entries.push({ at: f.detectedAt, text: 'No qualifying fulfillment confirmation observed' });
	if (p?.fulfilledAt !== undefined) entries.push({ at: p.fulfilledAt, text: 'Fulfillment confirmation observed in Shopify' });
	if (p?.cancelledAt !== undefined) entries.push({ at: p.cancelledAt, text: 'Order cancelled — confirmation no longer expected' });
	if (p?.fullyRefundedAt !== undefined)
		entries.push({ at: p.fullyRefundedAt, text: 'Order fully refunded — confirmation no longer expected' });
	if (lastReconciledAt !== undefined) entries.push({ at: lastReconciledAt, text: 'Last reconciled directly with Shopify' });
	return entries.sort((a, b) => a.at - b.at);
}

async function findingDetail(id: string): Promise<void> {
	loading();
	const f = await apiFinding(id);
	// Last-reconciled is context, not evidence — a failure to read it must not
	// break the finding.
	let lastReconciledAt: number | undefined;
	try {
		lastReconciledAt = (await loadSummary()).reconciliation.lastReconciledAt;
	} catch {
		lastReconciledAt = undefined;
	}
	const field = (label: string, value: string) => `<div class="field"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
	const evidence = (f.evidenceEventIds ?? []).length
		? (f.evidenceEventIds ?? []).map((e) => `<a href="#/events/${encodeURIComponent(e)}">${esc(e.split(':').pop())}</a>`).join(', ')
		: '<span class="muted">none</span>';

	const timeline = observedTimeline(f, lastReconciledAt)
		.map((entry) => `<li><span class="tl-at">${ts(entry.at, CLOCK_FMT)}</span><span class="tl-text">${esc(entry.text)}</span></li>`)
		.join('');

	// "Why this qualified" (screen spec §4): the eligibility rule, shown from the
	// projection/expectation already in the payload. Only meaningful while the
	// order is unconfirmed — resolved/suppressed findings explain themselves via
	// the (retained) description.
	const p = f.projection;
	const why =
		f.status === 'unconfirmed' && p
			? `<h2>Why this qualified</h2><ul>
				${p.requiresFulfillment ? '<li>Contains fulfillment-eligible items</li>' : ''}
				${p.paidAt !== undefined ? '<li>Payment was observed</li>' : ''}
				${p.cancelledAt === undefined && p.fullyRefundedAt === undefined ? '<li>Not canceled or fully refunded</li>' : ''}
				<li>The confirmation window elapsed without an observed fulfillment</li>
			</ul>`
			: '';
	// The disclaimer is only literally true while confirmation is still absent;
	// resolved/suppressed findings carry their own accurate description instead.
	const disclaimer = f.status === 'unconfirmed' ? `<div class="notice notice-warn"><strong>${esc(FINDING_DISCLAIMER)}</strong></div>` : '';

	app().innerHTML = `
		<a href="#/findings" class="back">← Findings</a>
		<h2>Order ${esc(f.orderId)} ${badge(f.status)}</h2>
		<div class="notice">${esc(f.description)}</div>
		${timeline ? `<h2>What Sightline observed</h2><ol class="timeline">${timeline}</ol>` : ''}
		${why}
		${disclaimer}
		<dl class="fields">
			${field('Paid', ts(f.projection?.paidAt))}
			${field('Expected confirmation by', ts(f.expectation?.deadline))}
			${field('Detected', ts(f.detectedAt))}
			${field('Resolved', ts(f.resolvedAt))}
			${field('Last reconciled with Shopify', ts(lastReconciledAt))}
			${field('Expectation state', f.expectation?.state ? badge(f.expectation.state) : '—')}
			${field('Rule version', esc(f.ruleVersion ?? '—'))}
			${field('Evidence events', evidence)}
		</dl>`;
}

async function privacy(): Promise<void> {
	loading();
	const p = await apiPrivacy();
	const list = (items: string[]) => items.map((c) => `<li>${esc(c)}</li>`).join('');
	const del = Object.entries(p.deletion)
		.map(([k, v]) => `<li><strong>${esc(k)}:</strong> ${esc(v)}</li>`)
		.join('');
	const now = Date.now();
	app().innerHTML = `
		<div class="notice notice-ok"><strong>No customer PII is stored.</strong> Sightline never records customer name, email, phone, or address.</div>
		<h2>Installation</h2>
		<dl class="fields">
			<div class="field"><dt>Shop</dt><dd>${esc(p.shop)}</dd></div>
			<div class="field"><dt>Granted access</dt><dd>${p.scopes.length ? p.scopes.map((s) => `<code>${esc(s)}</code>`).join(' ') : '<span class="muted">read-only scopes pending confirmation</span>'}</dd></div>
			<div class="field"><dt>Retention</dt><dd>${p.retentionDays} days, then permanently purged</dd></div>
		</dl>
		<h2>What we store</h2>
		<ul>${list(p.dataCategories)}</ul>
		<h2>What we never store</h2>
		<ul>${list(p.excludedFields)}</ul>
		<h2>App health</h2>
		<div class="stats">
			<div class="stat"><div class="stat-value">${p.webhooks.received}</div><div class="stat-label">Deliveries received</div></div>
			<div class="stat"><div class="stat-value">${p.webhooks.processed}</div><div class="stat-label">Processed</div></div>
			<div class="stat"><div class="stat-value">${p.webhooks.deadLettered}</div><div class="stat-label">Could not process</div></div>
		</div>
		<dl class="fields">
			<div class="field"><dt>Webhook capture</dt><dd>${p.webhooks.healthy ? badge('healthy', 'ok') : badge('needs attention', 'warn')}${p.webhooks.lastReceivedAt !== undefined ? ` · last delivery ${esc(relative(p.webhooks.lastReceivedAt, now))}` : ''}</dd></div>
			<div class="field"><dt>Reconciliation</dt><dd>${p.reconciliation.stale ? badge('delayed', 'warn') : badge('healthy', 'ok')} · ${p.reconciliation.lastReconciledAt === undefined ? 'initial check pending' : `last ran ${esc(relative(p.reconciliation.lastReconciledAt, now))}`}</dd></div>
		</dl>
		<h2>Deletion</h2>
		<ul>${del}</ul>
		<h2>This shop’s footprint</h2>
		<div class="stats">
			<div class="stat"><div class="stat-value">${p.footprint.events}</div><div class="stat-label">Events</div></div>
			<div class="stat"><div class="stat-value">${p.footprint.orders}</div><div class="stat-label">Orders</div></div>
			<div class="stat"><div class="stat-value">${p.footprint.findings}</div><div class="stat-label">Findings</div></div>
		</div>`;
}

// ── router ───────────────────────────────────────────────────────────────────
function parseHash(): { path: string; params: Record<string, string> } {
	const raw = location.hash.replace(/^#/, '') || '/';
	const [path, query] = raw.split('?');
	const params: Record<string, string> = {};
	for (const [k, v] of new URLSearchParams(query ?? '')) params[k] = v;
	return { path: path || '/', params };
}

function setActiveNav(path: string): void {
	const base = '/' + (path.split('/')[1] ?? '');
	for (const link of document.querySelectorAll<HTMLElement>('[data-nav]')) {
		link.toggleAttribute('data-active', (link.getAttribute('data-nav') || '/') === base);
	}
}

async function route(): Promise<void> {
	const { path, params } = parseHash();
	setActiveNav(path);
	void renderContext();
	try {
		const eventId = path.match(/^\/events\/(.+)$/);
		const findingId = path.match(/^\/findings\/(.+)$/);
		if (path === '/' || path === '') await overview();
		else if (path === '/setup') await setupScreen();
		else if (eventId) await eventDetail(decodeURIComponent(eventId[1]));
		else if (path === '/events') await eventsList(params);
		else if (findingId) await findingDetail(decodeURIComponent(findingId[1]));
		else if (path === '/findings') await findingsList(params);
		else if (path === '/privacy') await privacy();
		else app().innerHTML = `<p class="muted">Not found.</p>`;
	} catch (err) {
		// api.ts prefixes the thrown message with the HTTP status; a 401 means the
		// short-lived session token expired → show the reauthorization state.
		if (String((err as Error).message).startsWith('401')) authExpiredView();
		else errorView(err);
	}
}

async function boot(): Promise<void> {
	const status = document.getElementById('status');
	try {
		const session = window.__SIGHTLINE_SESSION__ ?? (await apiSession());
		if (status) status.textContent = `Recording ${session.shop}`;
	} catch (err) {
		if (status) status.textContent = `Not connected: ${(err as Error).message}`;
	}
	window.addEventListener('hashchange', () => void route());

	// First open lands on the setup screen while the initial check runs, so the app
	// explains itself instead of showing an empty overview that looks like "no
	// gaps" (screen spec §1). Any explicit route wins — this never traps the user.
	if (!location.hash || location.hash === '#/' || location.hash === '#') {
		let setup: Setup | null = null;
		try {
			setup = await apiSetup();
		} catch {
			setup = null;
		}
		// replaceState (not location.hash =) so this does NOT fire hashchange and
		// double-render — route() below does the single render.
		if (setup && !setup.complete) history.replaceState(null, '', '#/setup');
	}
	void route();
}

void boot();
