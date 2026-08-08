import type { EventDetail, EventItem, FindingDetail, FindingItem, OrderDetail, OrderItem, Privacy, Setup, Summary } from './api.ts';

// Every screen's markup, as PURE functions of already-fetched data. Nothing here
// touches the DOM, the network, or any Shopify global — main.ts owns all of that.
// That split is what makes the UI testable without a browser or a DOM shim: the
// tests in test/view.test.ts assert on the strings these functions return.
//
// The UI is built from Polaris web components (`s-*`, loaded in index.html), so it
// renders with Admin's own styling, spacing, and theming. Local CSS is limited to
// the activity bars, which have no Polaris equivalent.

export function esc(value: unknown): string {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

// ── time ─────────────────────────────────────────────────────────────────────
// Timestamps render in the STORE's configured timezone (screen spec: "merchant
// timezone with an accessible exact timestamp"), which the session carries as
// `timezone` once the reconcile sweep has cached it from the Admin API. Until
// then — and if the zone is one this browser's ICU doesn't know — we fall back to
// the viewer's own zone. Either way `zoneLabel()` names the zone actually used in
// the global context strip, and every timestamp carries the exact absolute
// instant in a <time datetime> plus a title, so no displayed time is ever
// ambiguous about which zone it is in.
const VIEWER_TZ = (() => {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
	} catch {
		return 'local time';
	}
})();

let activeTz: string | undefined; // undefined = viewer's zone
let SHORT_FMT: Intl.DateTimeFormat;
let EXACT_FMT: Intl.DateTimeFormat;
let CLOCK_FMT: Intl.DateTimeFormat;
let DEADLINE_FMT: Intl.DateTimeFormat;
let DAY_FMT: Intl.DateTimeFormat;

function buildFormatters(timeZone: string | undefined): void {
	// `timeZone: undefined` is how Intl asks for the runtime default, so one code
	// path serves both cases.
	SHORT_FMT = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone });
	EXACT_FMT = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'long', timeZone });
	CLOCK_FMT = new Intl.DateTimeFormat(undefined, { timeStyle: 'short', timeZone });
	DEADLINE_FMT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone });
	DAY_FMT = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone });
	activeTz = timeZone;
}
buildFormatters(undefined);

// Adopt the shop's zone if this runtime actually supports it; an unknown zone
// makes Intl throw, and silently keeping the viewer's zone is far better than a
// blank app. Passing undefined resets to the viewer's zone, so the function is
// total — the session simply not carrying a timezone is a valid input, not a
// no-op that leaves a stale zone in place.
export function useShopTimeZone(timeZone: string | undefined): void {
	try {
		buildFormatters(timeZone);
	} catch {
		buildFormatters(undefined);
	}
}

export function zoneLabel(): string {
	return activeTz ?? VIEWER_TZ;
}
export function usingStoreZone(): boolean {
	return activeTz !== undefined;
}

export function ts(ms: number | undefined, fmt?: Intl.DateTimeFormat): string {
	if (ms === undefined || ms === null) return '—';
	const date = new Date(ms);
	return `<time datetime="${esc(date.toISOString())}" title="${esc(EXACT_FMT.format(date))}">${esc((fmt ?? SHORT_FMT).format(date))}</time>`;
}

// A coarse duration ("4m", "3h", "2d") for elapsed-time columns.
export function elapsed(fromMs: number | undefined, toMs: number): string {
	if (!fromMs) return '—';
	const s = Math.max(0, Math.floor((toMs - fromMs) / 1000));
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	if (s < 86400) return `${Math.floor(s / 3600)}h`;
	return `${Math.floor(s / 86400)}d`;
}

export function relative(fromMs: number | undefined, toMs: number): string {
	if (fromMs === undefined) return 'never';
	const s = Math.max(0, Math.floor((toMs - fromMs) / 1000));
	if (s < 60) return 'just now';
	return `${elapsed(fromMs, toMs)} ago`;
}

// ── primitives ───────────────────────────────────────────────────────────────
// Polaris badge tones. Status text always accompanies the tone, so meaning never
// depends on colour alone.
const STATUS_TONE: Record<string, string> = {
	unconfirmed: 'warning',
	resolved: 'success',
	suppressed: 'neutral',
	pending: 'neutral',
	expired: 'warning',
};
export function badge(text: string, tone?: string): string {
	return `<s-badge tone="${esc(tone ?? STATUS_TONE[text] ?? 'neutral')}">${esc(text)}</s-badge>`;
}

// Money for display. Intl gives the merchant's own currency formatting; an
// unknown/absent currency degrades to the bare amount rather than guessing a
// symbol, and an absent amount is an em dash like every other missing value.
export function money(amount: number | undefined, currency: string | undefined): string {
	if (amount === undefined || amount === null) return '—';
	if (!currency) return amount.toFixed(2);
	try {
		return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
	} catch {
		return `${amount.toFixed(2)} ${currency}`;
	}
}

export function page(heading: string, body: string, breadcrumb?: { href: string; label: string }): string {
	return `<s-page heading="${esc(heading)}" inline-size="large">
		${breadcrumb ? `<s-link slot="breadcrumb-actions" href="${esc(breadcrumb.href)}">${esc(breadcrumb.label)}</s-link>` : ''}
		${body}
	</s-page>`;
}

export function table(headers: Array<{ label: string; numeric?: boolean }>, rows: string, emptyMessage: string): string {
	const head = headers.map((h) => `<s-table-header format="${h.numeric ? 'numeric' : 'base'}">${esc(h.label)}</s-table-header>`).join('');
	return rows
		? `<s-table variant="auto"><s-table-header-row>${head}</s-table-header-row><s-table-body>${rows}</s-table-body></s-table>`
		: `<s-paragraph><s-text color="subdued">${esc(emptyMessage)}</s-text></s-paragraph>`;
}

// Label/value pairs. `variant="list"` keeps them stacked at every width, which is
// the narrow-iframe behavior the spec asks for without any custom breakpoint.
export function fields(rows: Array<[string, string]>): string {
	const body = rows
		.map(([label, value]) => `<s-table-row><s-table-cell>${esc(label)}</s-table-cell><s-table-cell>${value}</s-table-cell></s-table-row>`)
		.join('');
	return `<s-table variant="list"><s-table-header-row><s-table-header format="base">Field</s-table-header><s-table-header format="base">Value</s-table-header></s-table-header-row><s-table-body>${body}</s-table-body></s-table>`;
}

export function statGrid(tiles: Array<[string, number]>): string {
	const cells = tiles
		.map(
			([label, value]) => `<s-grid-item><s-box padding="base" background="subdued" borderRadius="base">
			<s-text type="strong" fontVariantNumeric="tabular-nums">${value}</s-text>
			<s-paragraph><s-text color="subdued">${esc(label)}</s-text></s-paragraph>
		</s-box></s-grid-item>`,
		)
		.join('');
	return `<s-grid gridTemplateColumns="@container (inline-size > 600px) repeat(4, 1fr), repeat(2, 1fr)" gap="base">${cells}</s-grid>`;
}

export function bullets(items: string[]): string {
	return `<s-unordered-list>${items.map((c) => `<s-list-item>${esc(c)}</s-list-item>`).join('')}</s-unordered-list>`;
}

// ── support ──────────────────────────────────────────────────────────────────
// The support contact comes from the session (server-configured, never a
// fabricated address). It is offered on the Privacy screen and, more usefully, on
// the two states where a merchant is actually stuck — an expired session and a
// load failure.
export interface Support {
	email?: string;
	url?: string;
}
let support: Support = {};
export function setSupport(next: Support | undefined): void {
	support = next ?? {};
}
export function supportKnown(): boolean {
	return Boolean(support.email || support.url);
}

// Inline "get help" links, or nothing at all when unconfigured — an empty
// promise of support is worse than none.
export function supportLinks(): string {
	const parts: string[] = [];
	if (support.email) parts.push(`<s-link href="mailto:${esc(support.email)}">${esc(support.email)}</s-link>`);
	if (support.url) parts.push(`<s-link href="${esc(support.url)}">Help centre</s-link>`);
	return parts.join(' · ');
}

function supportLine(): string {
	return supportKnown() ? `<s-paragraph>Need help? ${supportLinks()}</s-paragraph>` : '';
}

export function spinnerView(): string {
	return `<s-page heading="Sightline"><s-section><s-stack direction="inline" gap="base" alignItems="center">
		<s-spinner accessibilityLabel="Loading"></s-spinner><s-text>Loading…</s-text>
	</s-stack></s-section></s-page>`;
}

// Auth-expired (401) is distinct from a recoverable error: the merchant needs to
// reopen the app so Shopify re-issues a session token (screen spec: every screen
// supports an authorization-expired state with a reauthorization action).
export function authExpiredView(): string {
	return page(
		'Sightline',
		`<s-section><s-banner tone="warning" heading="Session expired">
			<s-paragraph>Your Shopify session timed out. Reload Sightline in Shopify Admin to reconnect — recording continued in the background the whole time.</s-paragraph>
			${supportLine()}
		</s-banner></s-section>`,
	);
}

export function errorViewMarkup(message: string): string {
	return page(
		'Sightline',
		`<s-section><s-banner tone="critical" heading="Couldn’t load">
			<s-paragraph>${esc(message)}</s-paragraph>
			<s-button data-retry>Retry</s-button>
			${supportLine()}
		</s-banner></s-section>`,
	);
}

// ── global context strip ─────────────────────────────────────────────────────
// Say which zone the times are in AND whose it is, so "store time" vs "your
// device" is never a guess.
export function zoneText(): string {
	return `<s-text color="subdued">Times in ${esc(zoneLabel())} (${usingStoreZone() ? 'store time' : 'your device'})</s-text>`;
}

function reconBadge(s: Summary, now: number): string {
	const r = s.reconciliation;
	if (r.lastReconciledAt === undefined) return badge('Initial check pending', 'warning');
	if (r.stale) return badge(`Reconciliation delayed — last ${relative(r.lastReconciledAt, now)}`, 'warning');
	return badge(`Reconciled ${relative(r.lastReconciledAt, now)}`, 'info');
}

// Rendered as the first section of every screen, so window/health/freshness/zone
// are always on screen (screen spec, global behavior).
export function contextStrip(s: Summary | null, now: number): string {
	if (!s) {
		return `<s-section><s-stack direction="inline" gap="small-200" alignItems="center">${badge('Last 7 days', 'info')}${zoneText()}</s-stack></s-section>`;
	}
	const health = s.recorder.healthy ? badge('Recording healthy', 'success') : badge('Recorder needs attention', 'warning');
	return `<s-section><s-stack direction="inline" gap="small-200" alignItems="center">
		${badge(`Last ${s.windowDays} days`, 'info')}${health}${reconBadge(s, now)}${zoneText()}
	</s-stack></s-section>`;
}

// ── setup / first open ───────────────────────────────────────────────────────
const SETUP_STEP_TONE: Record<string, string> = {
	done: 'success',
	running: 'warning',
	waiting: 'neutral',
	pending: 'neutral',
	blocked: 'critical',
};
const SETUP_STEP_LABEL: Record<string, string> = {
	done: 'Complete',
	running: 'In progress',
	waiting: 'Completing connection',
	pending: 'Not started',
	blocked: 'Needs reauthorization',
};

// The capture step is "connected" once subscriptions exist; whether anything has
// arrived is a separate fact, so a quiet store reads as connected-and-idle rather
// than as broken or as capture we haven't actually seen.
export function setupStepNote(step: Setup['steps'][number], eventsObserved: boolean): string {
	if (step.key === 'capture' && step.state === 'done') return eventsObserved ? 'Receiving events' : 'Connected — no events yet';
	return SETUP_STEP_LABEL[step.state] ?? step.state;
}

export function setupView(setup: Setup): string {
	const rows = setup.steps
		.map(
			(step) => `<s-table-row>
			<s-table-cell>${esc(step.label)}</s-table-cell>
			<s-table-cell>${badge(SETUP_STEP_LABEL[step.state] ?? step.state, SETUP_STEP_TONE[step.state] ?? 'neutral')}</s-table-cell>
			<s-table-cell>${esc(setupStepNote(step, setup.eventsObserved))}</s-table-cell>
		</s-table-row>`,
		)
		.join('');
	// A blocked step gets the one safe action a merchant can take; nothing here
	// writes to Shopify (screen spec §1: "a failed step gives a safe retry or
	// reauthorization action").
	const action =
		setup.action === 'reauthorize'
			? `<s-banner tone="warning" heading="Reauthorization needed">
					<s-paragraph>Sightline’s access to your store needs to be renewed before the initial check can finish. Open Sightline from your Shopify Admin apps list to reconnect. Recording resumes automatically — nothing is lost.</s-paragraph>
				</s-banner>`
			: `<s-button data-retry>Check again</s-button>`;
	return page(
		'Sightline is recording your Shopify operations',
		`${contextStrip(null, Date.now())}
		<s-section heading="Setup">
			${table([{ label: 'Step' }, { label: 'Status' }, { label: 'Detail' }], rows, 'No setup information.')}
		</s-section>
		<s-section>
			<s-paragraph>Sightline keeps seven days of order, fulfillment, inventory, and refund activity. It is read-only and never sits in your fulfillment path — if Sightline stops, your store’s operation is unaffected.</s-paragraph>
			${
				setup.complete
					? `<s-banner tone="success" heading="Setup complete"><s-paragraph>The first seven days of history are in place.</s-paragraph></s-banner>`
					: `<s-banner tone="info" heading="The initial check is still running"><s-paragraph>History is still being built, so counts and findings may be incomplete until it finishes.</s-paragraph></s-banner>`
			}
			${action}
			<s-stack direction="inline" gap="base"><s-link href="#/">Continue to overview</s-link><s-link href="#/privacy">View data we store</s-link></s-stack>
		</s-section>`,
	);
}

// ── overview ─────────────────────────────────────────────────────────────────
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
export function activityView(a: Summary['activity']): string {
	// Normalise to the tallest single domain-day, not to the daily total, so the
	// busiest bar fills the track and the bars stay comparable to one another. (Per
	// daily total, no bar could ever reach full height, which reads as "nothing
	// much happened" on a busy day.)
	const peak = Math.max(1, ...a.buckets.flatMap((b) => a.domains.map((d) => Number(b[d] ?? 0))));
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
	const head = a.buckets
		.map((b) => `<s-table-header format="numeric">${esc(DAY_FMT.format(new Date(b.startAt)))}</s-table-header>`)
		.join('');
	const body = a.domains
		.map(
			(d) =>
				`<s-table-row><s-table-cell>${esc(DOMAIN_LABEL[d] ?? d)}</s-table-cell>${a.buckets.map((b) => `<s-table-cell>${Number(b[d] ?? 0)}</s-table-cell>`).join('')}</s-table-row>`,
		)
		.join('');
	return `<s-section heading="Activity over time">
		<div class="spark" role="img" aria-label="${esc(label)}">${rows}</div>
		<details class="alt"><summary>View activity as a table</summary>
			<s-table variant="auto"><s-table-header-row><s-table-header format="base">Domain</s-table-header>${head}</s-table-header-row><s-table-body>${body}</s-table-body></s-table>
		</details>
	</s-section>`;
}

// The overview's "needs attention" list: recent orders with no observed Shopify
// fulfillment confirmation. Copy is non-accusatory (screen spec §2) — it never
// says a warehouse/carrier failed, only that Shopify has not shown confirmation.
export function needsAttention(items: FindingItem[], now: number): string {
	const rows = items
		.slice(0, 5)
		.map(
			(x) => `<s-table-row>
			<s-table-cell><s-link href="#/findings/${encodeURIComponent(x.id)}">${esc(x.orderId)}</s-link></s-table-cell>
			<s-table-cell>No Shopify fulfillment confirmation observed</s-table-cell>
			<s-table-cell>${esc(elapsed(x.detectedAt, now))}</s-table-cell>
		</s-table-row>`,
		)
		.join('');
	return `<s-section heading="Needs attention">
		${table([{ label: 'Order' }, { label: 'Observation' }, { label: 'Open for' }], rows, 'Nothing is awaiting confirmation.')}
	</s-section>`;
}

export interface OverviewData {
	summary: Summary;
	flows: { lanes: Record<string, number> } | null;
	unconfirmed: FindingItem[] | null;
	setup: Setup | null;
	now: number;
}

export function overviewView(d: OverviewData): string {
	const s = d.summary;
	const now = d.now;

	// Panels load independently, so one failure degrades to partial data instead of
	// blanking the screen (screen spec: every screen supports a partial-data state).
	const missing: string[] = [];
	if (!d.flows) missing.push('order flow');
	if (!d.unconfirmed) missing.push('needs attention');
	const partial = missing.length
		? `<s-banner tone="warning" heading="Partial data">
				<s-paragraph>The ${esc(missing.join(' and '))} panel${missing.length > 1 ? 's' : ''} couldn’t load. Everything else on this page is current.</s-paragraph>
				<s-button data-retry>Retry</s-button>
			</s-banner>`
		: '';

	// Health is a separate signal from the finding count: an unhealthy recorder
	// must never render as "no gaps" (screen spec §2).
	const health = s.recorder.healthy
		? `<s-banner tone="success" heading="Recorder healthy"><s-paragraph>Capturing order, fulfillment, inventory and refund activity.</s-paragraph></s-banner>`
		: `<s-banner tone="critical" heading="Recorder needs attention"><s-paragraph>${s.recorder.deadLetteredDeliveries} deliver(ies) could not be processed. Gap results may be incomplete.</s-paragraph></s-banner>`;

	// Stale reconciliation is its own state: counts below are still real, but they
	// may lag Shopify, so the screen says so rather than implying completeness.
	const stale =
		s.reconciliation.stale && s.reconciliation.lastReconciledAt !== undefined
			? `<s-banner tone="warning" heading="Reconciliation delayed">
					<s-paragraph>Sightline last checked Shopify directly ${esc(relative(s.reconciliation.lastReconciledAt, now))}. Webhook capture is unaffected, but very recent changes may not appear yet.</s-paragraph>
				</s-banner>`
			: '';

	// Before the first check completes there is genuinely no seven-day history, so
	// the screen must not present these counts as a full picture (spec §1).
	const backfill =
		d.setup && !d.setup.complete
			? `<s-banner tone="info" heading="Initial check still running">
					<s-paragraph>Sightline is still building the first seven days of history — counts below may be incomplete.</s-paragraph>
					<s-link href="#/setup">View setup</s-link>
				</s-banner>`
			: '';

	const flows = d.flows
		? `<s-section heading="Order → fulfillment">
				${table(
					[{ label: 'Lane' }, { label: 'Orders', numeric: true }],
					(
						[
							['Paid', d.flows.lanes.paid],
							['Fulfilled', d.flows.lanes.fulfilled],
							['Awaiting confirmation', d.flows.lanes.awaitingConfirmation],
							['Cancelled', d.flows.lanes.cancelled],
							['Refunded', d.flows.lanes.refunded],
						] as Array<[string, number]>
					)
						.map(([label, n]) => `<s-table-row><s-table-cell>${esc(label)}</s-table-cell><s-table-cell>${n}</s-table-cell></s-table-row>`)
						.join(''),
					'No order activity in the window.',
				)}
			</s-section>`
		: '';

	return page(
		'Operations overview',
		`${contextStrip(s, now)}
		<s-section>${health}${stale}${backfill}${partial}</s-section>
		<s-section heading="Orders (last ${s.windowDays} days)">
			${statGrid([
				['Tracked', s.orders.tracked],
				['Paid', s.orders.paid],
				['Fulfilled', s.orders.fulfilled],
				['Awaiting confirmation', s.orders.awaitingConfirmation],
			])}
		</s-section>
		<s-section heading="Findings">
			${statGrid([
				['Unconfirmed', s.findings.unconfirmed],
				['Resolved', s.findings.resolved],
				['Suppressed', s.findings.suppressed],
			])}
		</s-section>
		${flows}
		${s.activity ? activityView(s.activity) : ''}
		${d.unconfirmed ? needsAttention(d.unconfirmed, now) : ''}
		<s-section><s-paragraph><s-text color="subdued">${s.events.total} normalized events recorded in the window.</s-text></s-paragraph></s-section>`,
	);
}

// ── events ───────────────────────────────────────────────────────────────────
export const DOMAINS = ['', 'order', 'fulfillment', 'inventory', 'refund'];
export const SOURCES = ['', 'webhook', 'reconciliation'];
// Time filter kept as a symbolic range in the URL rather than a frozen timestamp,
// so a shared/bookmarked filter stays meaningful (screen spec §3: filters are
// reflected in the URL).
export const RANGES: Array<[string, string, number]> = [
	['', 'Any time in window', 0],
	['1h', 'Last hour', 3_600_000],
	['24h', 'Last 24 hours', 86_400_000],
	['7d', 'Last 7 days', 604_800_000],
];
export const EVENT_FILTER_KEYS = ['range', 'domain', 'topic', 'resourceId', 'sku', 'source'];

// Translate the UI filter params into API query params (range → since).
export function eventQuery(params: Record<string, string>, now: number): Record<string, string> {
	const q: Record<string, string> = {};
	for (const key of ['domain', 'topic', 'resourceId', 'sku', 'source']) {
		if (params[key]) q[key] = params[key];
	}
	const range = RANGES.find(([value]) => value && value === params.range);
	if (range) q.since = String(now - range[2]);
	return q;
}

function selectOptions(values: readonly string[], selected: string, anyLabel: string): string {
	return values.map((v) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(v || anyLabel)}</option>`).join('');
}

export function eventsView(params: Record<string, string>, items: EventItem[], hasMore: boolean, strip: string): string {
	const rows = items
		.map(
			(e) => `<s-table-row>
			<s-table-cell><s-link href="#/events/${encodeURIComponent(e.eventId)}">${ts(e.occurredAt)}</s-link></s-table-cell>
			<s-table-cell>${esc(e.domain)}</s-table-cell>
			<s-table-cell>${esc(e.topic ?? '')}</s-table-cell>
			<s-table-cell>${esc(e.resourceId ?? '')}</s-table-cell>
			<s-table-cell>${esc(e.sku ?? '')}${e.quantity !== undefined ? ` ×${e.quantity}` : ''}</s-table-cell>
			<s-table-cell>${e.state ? badge(e.state) : ''}</s-table-cell>
			<s-table-cell>${esc(e.source)}</s-table-cell>
		</s-table-row>`,
		)
		.join('');
	const rangeOptions = RANGES.map(
		([value, label]) => `<option value="${esc(value)}"${value === (params.range ?? '') ? ' selected' : ''}>${esc(label)}</option>`,
	).join('');
	return page(
		'Events',
		`${strip}
		<s-section heading="Search the seven-day ledger">
			<s-stack id="eventFilters" direction="inline" gap="base" alignItems="end">
				<s-select id="f-range" label="Time">${rangeOptions}</s-select>
				<s-select id="f-domain" label="Domain">${selectOptions(DOMAINS, params.domain ?? '', 'Any domain')}</s-select>
				<s-text-field id="f-topic" label="Topic" placeholder="orders/paid" value="${esc(params.topic ?? '')}"></s-text-field>
				<s-text-field id="f-resourceId" label="Order / resource ID" value="${esc(params.resourceId ?? '')}"></s-text-field>
				<s-text-field id="f-sku" label="SKU" value="${esc(params.sku ?? '')}"></s-text-field>
				<s-select id="f-source" label="Evidence source">${selectOptions(SOURCES, params.source ?? '', 'Any source')}</s-select>
				<s-button variant="primary" data-submit>Search</s-button>
			</s-stack>
		</s-section>
		<s-section>
			${table(
				[
					{ label: 'Time' },
					{ label: 'Domain' },
					{ label: 'Topic' },
					{ label: 'Resource' },
					{ label: 'SKU' },
					{ label: 'State' },
					{ label: 'Source' },
				],
				rows,
				'No events match.',
			)}
			${hasMore ? `<s-button id="loadMore">Load more</s-button>` : ''}
		</s-section>`,
	);
}

export function eventDetailView(e: EventDetail, strip: string): string {
	const related = e.relatedEventIds.length
		? e.relatedEventIds.map((r) => `<s-link href="#/events/${encodeURIComponent(r)}">${esc(r.split(':').pop())}</s-link>`).join(' ')
		: `<s-text color="subdued">none</s-text>`;
	// A receipt later than the occurrence is normal (at-least-once, unordered
	// delivery) and is shown as such — it never reorders the ledger (spec §3).
	const delayed =
		e.receivedAt > e.occurredAt + 60_000
			? `<s-paragraph><s-text color="subdued">Received ${esc(elapsed(e.occurredAt, e.receivedAt))} after it occurred. Delayed or out-of-order receipt does not change an event’s place in the timeline.</s-text></s-paragraph>`
			: '';
	return page(
		`${e.domain}${e.topic ? ` · ${e.topic}` : ''}`,
		`${strip}
		<s-section heading="Normalized event">
			${fields([
				['Resource', esc(e.resourceId ?? '—')],
				['State', e.state ? badge(e.state) : '—'],
				['SKU', esc(e.sku ?? '—')],
				['Quantity', e.quantity !== undefined ? String(e.quantity) : '—'],
				['Fulfillment-eligible units', e.fulfillableItemCount !== undefined ? String(e.fulfillableItemCount) : '—'],
				['Occurred (source)', ts(e.occurredAt)],
				['Received', ts(e.receivedAt)],
				['Source', esc(e.source)],
				['Affected a projection', e.affectedProjection ? 'Yes' : 'No'],
				['Affected a finding', e.affectedFinding ? 'Yes' : 'No'],
				['Related events', related],
			])}
			${delayed}
		</s-section>`,
		{ href: '#/events', label: 'Events' },
	);
}

// ── orders ───────────────────────────────────────────────────────────────────
// The worklist: every order Sightline is tracking, with its lane, its age since
// payment, and its value. This is what the Overview's counts drill into — before
// it existed, "Awaiting confirmation: 14" was a number with nowhere to go, and
// the only order list was the findings list, which shows only orders that have
// ALREADY blown the deadline.
export const ORDER_STATES = ['', 'awaiting', 'fulfilled', 'cancelled', 'refunded', 'unpaid'];
export const ORDER_SORTS: Array<[string, string]> = [
	['newest', 'Newest first'],
	['oldest', 'Oldest first (most overdue)'],
];
// Sub-deadline aging: the confirmation detector waits 72h, so these let a
// merchant see what is heading that way while it can still be acted on.
export const ORDER_AGES: Array<[string, string]> = [
	['', 'Any age'],
	['12', 'Paid over 12h ago'],
	['24', 'Paid over 24h ago'],
	['48', 'Paid over 48h ago'],
	['72', 'Paid over 72h ago'],
];
export const ORDER_FILTER_KEYS = ['state', 'minAgeHours', 'sort'];

export function orderQuery(params: Record<string, string>): Record<string, string> {
	const q: Record<string, string> = {};
	for (const key of ORDER_FILTER_KEYS) {
		if (params[key]) q[key] = params[key];
	}
	return q;
}

// The order's own label, never a blank cell: Shopify's merchant-facing name when
// we have it, otherwise the raw id (which is at least copy-pasteable).
export function orderLabel(o: { orderName?: string; orderId: string }): string {
	return o.orderName ?? o.orderId;
}

function ageCell(o: OrderItem): string {
	if (o.ageHours === undefined) return '—';
	return o.ageHours < 24 ? `${o.ageHours}h` : `${Math.floor(o.ageHours / 24)}d ${o.ageHours % 24}h`;
}

// A failed attempt is stated as an observation of Shopify's own record. It is
// direct evidence — Shopify recorded the attempt as unsuccessful — so it does not
// hedge like an absence finding, and it still names no downstream party.
function attemptFlag(o: OrderItem): string {
	return o.fulfillmentFailedAt !== undefined ? ` ${badge('attempt did not succeed', 'critical')}` : '';
}

export function ordersView(params: Record<string, string>, items: OrderItem[], hasMore: boolean, strip: string): string {
	const rows = items
		.map(
			(o) => `<s-table-row>
			<s-table-cell><s-link href="#/orders/${encodeURIComponent(o.orderId)}">${esc(orderLabel(o))}</s-link></s-table-cell>
			<s-table-cell>${badge(o.state)}${attemptFlag(o)}</s-table-cell>
			<s-table-cell>${ts(o.paidAt)}</s-table-cell>
			<s-table-cell>${esc(ageCell(o))}</s-table-cell>
			<s-table-cell>${money(o.orderTotal, o.currency)}</s-table-cell>
			<s-table-cell>${o.hasTracking ? esc(o.trackingCompany ?? 'yes') : '—'}</s-table-cell>
		</s-table-row>`,
		)
		.join('');
	const stateOptions = ORDER_STATES.map(
		(v) => `<option value="${esc(v)}"${v === (params.state ?? '') ? ' selected' : ''}>${esc(v || 'Any lane')}</option>`,
	).join('');
	const ageOptions = ORDER_AGES.map(
		([v, label]) => `<option value="${esc(v)}"${v === (params.minAgeHours ?? '') ? ' selected' : ''}>${esc(label)}</option>`,
	).join('');
	const sortOptions = ORDER_SORTS.map(
		([v, label]) => `<option value="${esc(v)}"${v === (params.sort ?? 'newest') ? ' selected' : ''}>${esc(label)}</option>`,
	).join('');

	return page(
		'Orders',
		`${strip}
		<s-section heading="Orders Sightline is tracking">
			<s-paragraph><s-text color="subdued">Every order observed in the last 7 days, with how long it has been waiting since payment. Sightline is read-only — nothing here changes your store.</s-text></s-paragraph>
			<s-stack id="orderFilters" direction="inline" gap="base" alignItems="end">
				<s-select id="f-state" label="Lane">${stateOptions}</s-select>
				<s-select id="f-minAgeHours" label="Age">${ageOptions}</s-select>
				<s-select id="f-sort" label="Sort">${sortOptions}</s-select>
				<s-button variant="primary" data-submit>Filter</s-button>
			</s-stack>
		</s-section>
		<s-section>
			${table(
				[
					{ label: 'Order' },
					{ label: 'Lane' },
					{ label: 'Paid' },
					{ label: 'Waiting' },
					{ label: 'Value', numeric: true },
					{ label: 'Tracking' },
				],
				rows,
				'No orders match.',
			)}
			${hasMore ? `<s-button id="loadMore">Load more</s-button>` : ''}
		</s-section>`,
	);
}

// The one product-truth sentence for "Shopify recorded a failed attempt",
// shared between this timeline and the finding timeline's observedTimeline
// below, so there is a single hand-maintained copy instead of two near-
// duplicates drifting apart. Matches describeFinding's DETECTOR_FAILED copy
// verbatim (src/detector.ts).
export const FULFILLMENT_ATTEMPT_FAILED_OBSERVATION = 'Shopify recorded a fulfillment attempt for this order that did not succeed';

// One order's observed history. Same discipline as the finding timeline: every
// entry is something Sightline OBSERVED in Shopify, with a source timestamp, and
// nothing is inferred about a downstream system.
export function orderTimeline(o: OrderDetail): Array<{ at: number; text: string }> {
	const entries: Array<{ at: number; text: string }> = [];
	if (o.paidAt !== undefined) entries.push({ at: o.paidAt, text: 'Order paid' });
	if (o.fulfillmentFailedAt !== undefined) entries.push({ at: o.fulfillmentFailedAt, text: FULFILLMENT_ATTEMPT_FAILED_OBSERVATION });
	if (o.fulfilledAt !== undefined) entries.push({ at: o.fulfilledAt, text: 'Fulfillment confirmation observed in Shopify' });
	if (o.cancelledAt !== undefined) entries.push({ at: o.cancelledAt, text: 'Order cancelled — confirmation no longer expected' });
	if (o.fullyRefundedAt !== undefined)
		entries.push({ at: o.fullyRefundedAt, text: 'Order fully refunded — confirmation no longer expected' });
	return entries.sort((a, b) => a.at - b.at);
}

// Replaced with a real Admin deep link in the deep-links task.
function adminOrderLink(_orderId: string): string {
	return '';
}

export function orderDetailView(o: OrderDetail, strip: string): string {
	const timeline = orderTimeline(o)
		.map(
			(entry) =>
				`<s-table-row><s-table-cell>${ts(entry.at, CLOCK_FMT)}</s-table-cell><s-table-cell>${esc(entry.text)}</s-table-cell></s-table-row>`,
		)
		.join('');

	const eventRows = o.events
		.map(
			(e) => `<s-table-row>
			<s-table-cell><s-link href="#/events/${encodeURIComponent(e.eventId)}">${ts(e.occurredAt)}</s-link></s-table-cell>
			<s-table-cell>${esc(e.domain)}</s-table-cell>
			<s-table-cell>${esc(e.topic ?? '')}</s-table-cell>
			<s-table-cell>${e.state ? badge(e.state) : ''}</s-table-cell>
			<s-table-cell>${esc(e.source)}</s-table-cell>
		</s-table-row>`,
		)
		.join('');

	const findingRows = o.findings
		.map(
			(f) => `<s-table-row>
			<s-table-cell><s-link href="#/findings/${encodeURIComponent(f.id)}">${badge(f.status)}</s-link></s-table-cell>
			<s-table-cell>${esc(f.description)}</s-table-cell>
			<s-table-cell>${ts(f.detectedAt)}</s-table-cell>
		</s-table-row>`,
		)
		.join('');

	return page(
		`Order ${orderLabel(o)}`,
		`${strip}
		<s-section>
			<s-stack direction="inline" gap="small-200" alignItems="center">${badge(o.state)}${adminOrderLink(o.orderId)}</s-stack>
			${fields([
				['Order', esc(orderLabel(o))],
				['Value', money(o.orderTotal, o.currency)],
				['Paid', ts(o.paidAt)],
				['Waiting since payment', o.ageHours === undefined ? '—' : esc(`${o.ageHours}h`)],
				['Needs shipping', o.requiresFulfillment ? 'Yes' : 'No'],
				['Fulfillment confirmed', ts(o.fulfilledAt)],
				['Tracking', o.hasTracking ? esc(o.trackingCompany ?? 'present') : 'none observed'],
			])}
		</s-section>
		<s-section heading="What Sightline observed">
			${table([{ label: 'Time' }, { label: 'Observation' }], timeline, 'No observations recorded.')}
		</s-section>
		<s-section heading="Findings">
			${table([{ label: 'Status' }, { label: 'Observation' }, { label: 'Detected' }], findingRows, 'No findings for this order.')}
		</s-section>
		<s-section heading="Events">
			${table([{ label: 'Time' }, { label: 'Domain' }, { label: 'Topic' }, { label: 'State' }, { label: 'Source' }], eventRows, 'No events recorded in the window.')}
		</s-section>`,
		{ href: '#/orders', label: 'Orders' },
	);
}

// ── findings ─────────────────────────────────────────────────────────────────
// The claim boundary, stated on the findings list as well as each detail: absence
// of an observed confirmation is not evidence that any downstream party failed.
export const FINDINGS_BOUNDARY =
	'Findings describe what Sightline has observed in Shopify. They do not prove that a warehouse, carrier, or vendor failed.';
// Verbatim from the screen specification (§4). This sentence is the product-truth
// guardrail for the whole app — do not reword it.
export const FINDING_DISCLAIMER =
	'This does not prove that a warehouse or carrier failed. It means Shopify has not shown the expected fulfillment confirmation yet.';

export const STATUSES = ['', 'unconfirmed', 'resolved', 'suppressed'];

// Which finding-detail copy applies is a single fact, not three independently
// -drifting checks: the ABSENCE detector ('fulfillment_confirmation', or no
// `detector` at all on rows written before that column existed) is the only one
// whose confirmation-window disclaimer/"why this qualified" copy is true. The
// PRESENCE detector ('fulfillment_attempt_failed', src/detector.ts DETECTOR_FAILED)
// fires on a fulfillment Shopify itself recorded as failed — the disclaimer's "has
// not shown … yet" wording would be false for it (C2).
function isAbsenceFinding(f: { detector?: string }): boolean {
	return f.detector === undefined || f.detector === 'fulfillment_confirmation';
}

export function findingsListView(params: Record<string, string>, items: FindingItem[], now: number, strip: string): string {
	const rows = items
		.map(
			(x) => `<s-table-row>
			<s-table-cell><s-link href="#/findings/${encodeURIComponent(x.id)}">${esc(x.orderId)}</s-link></s-table-cell>
			<s-table-cell>${ts(x.paidAt)}</s-table-cell>
			<s-table-cell>${ts(x.deadline)}</s-table-cell>
			<s-table-cell>${x.status === 'unconfirmed' ? esc(elapsed(x.detectedAt, now)) : '—'}</s-table-cell>
			<s-table-cell>${badge(x.status)}</s-table-cell>
		</s-table-row>`,
		)
		.join('');
	return page(
		'Findings',
		`${strip}
		<s-section>
			<s-paragraph><s-text color="subdued">${esc(FINDINGS_BOUNDARY)}</s-text></s-paragraph>
			<s-stack id="findingFilters" direction="inline" gap="base" alignItems="end">
				<s-select id="f-status" label="Status">${selectOptions(STATUSES, params.status ?? '', 'Any status')}</s-select>
				<s-button variant="primary" data-submit>Filter</s-button>
			</s-stack>
		</s-section>
		<s-section>
			${table(
				[{ label: 'Order' }, { label: 'Paid' }, { label: 'Confirmation expected by' }, { label: 'Open for' }, { label: 'Status' }],
				rows,
				'No findings — nothing is missing confirmation.',
			)}
		</s-section>`,
	);
}

// "What Sightline observed" (screen spec §4): the finding's evidence as a
// chronological record. Every entry is an observation with a source timestamp —
// nothing here is inferred about a downstream system.
export function observedTimeline(f: FindingDetail, lastReconciledAt: number | undefined): Array<{ at: number; text: string }> {
	const p = f.projection;
	const entries: Array<{ at: number; text: string }> = [];
	if (p?.paidAt !== undefined) entries.push({ at: p.paidAt, text: 'Order paid' });
	if (isAbsenceFinding(f)) {
		if (f.expectation?.deadline !== undefined)
			entries.push({
				at: f.expectation.deadline,
				text: `Fulfillment confirmation expected by ${DEADLINE_FMT.format(new Date(f.expectation.deadline))}`,
			});
		if (f.detectedAt !== undefined) entries.push({ at: f.detectedAt, text: 'No qualifying fulfillment confirmation observed' });
	} else if (f.detectedAt !== undefined) {
		// The presence detector's own observation — Shopify recorded the attempt as
		// failed, so the entry states that fact rather than an absence (matches
		// describeFinding's DETECTOR_FAILED 'unconfirmed' copy, src/detector.ts).
		entries.push({ at: f.detectedAt, text: FULFILLMENT_ATTEMPT_FAILED_OBSERVATION });
	}
	if (p?.fulfilledAt !== undefined) entries.push({ at: p.fulfilledAt, text: 'Fulfillment confirmation observed in Shopify' });
	if (p?.cancelledAt !== undefined) entries.push({ at: p.cancelledAt, text: 'Order cancelled — confirmation no longer expected' });
	if (p?.fullyRefundedAt !== undefined)
		entries.push({ at: p.fullyRefundedAt, text: 'Order fully refunded — confirmation no longer expected' });
	if (lastReconciledAt !== undefined) entries.push({ at: lastReconciledAt, text: 'Last reconciled directly with Shopify' });
	return entries.sort((a, b) => a.at - b.at);
}

export function findingDetailView(f: FindingDetail, lastReconciledAt: number | undefined, strip: string): string {
	const evidence = (f.evidenceEventIds ?? []).length
		? (f.evidenceEventIds ?? [])
				.map((e) => `<s-link href="#/events/${encodeURIComponent(e)}">${esc(e.split(':').pop())}</s-link>`)
				.join(' ')
		: `<s-text color="subdued">none</s-text>`;

	const timeline = observedTimeline(f, lastReconciledAt)
		.map(
			(entry) =>
				`<s-table-row><s-table-cell>${ts(entry.at, CLOCK_FMT)}</s-table-cell><s-table-cell>${esc(entry.text)}</s-table-cell></s-table-row>`,
		)
		.join('');

	// "Why this qualified" (screen spec §4): the eligibility rule, shown from the
	// projection/expectation already in the payload. Only meaningful while the
	// order is unconfirmed — resolved/suppressed findings explain themselves via
	// the (retained) description. And only meaningful for the ABSENCE detector:
	// the presence detector has no confirmation window (deadlineMs is 0), so there
	// is no "window elapsed" rule to explain here (C2) — its own description
	// already states what was observed.
	const p = f.projection;
	const absence = isAbsenceFinding(f);
	const why =
		absence && f.status === 'unconfirmed' && p
			? `<s-section heading="Why this qualified"><s-unordered-list>
				${p.requiresFulfillment ? '<s-list-item>Contains fulfillment-eligible items</s-list-item>' : ''}
				${p.paidAt !== undefined ? '<s-list-item>Payment was observed</s-list-item>' : ''}
				${p.cancelledAt === undefined && p.fullyRefundedAt === undefined ? '<s-list-item>Not canceled or fully refunded</s-list-item>' : ''}
				<s-list-item>The confirmation window elapsed without an observed fulfillment</s-list-item>
			</s-unordered-list></s-section>`
			: '';
	// The disclaimer is only literally true for the ABSENCE detector while
	// confirmation is still absent — for the presence detector it would be
	// self-contradictory (Shopify DID record a failed attempt) and is never shown
	// regardless of status (C2). Resolved/suppressed absence findings carry their
	// own accurate description instead.
	const disclaimer =
		absence && f.status === 'unconfirmed'
			? `<s-banner tone="warning" heading="What this finding does and does not mean">
					<s-paragraph>${esc(FINDING_DISCLAIMER)}</s-paragraph>
				</s-banner>`
			: '';

	return page(
		`Order ${f.orderId}`,
		`${strip}
		<s-section>
			<s-stack direction="inline" gap="small-200" alignItems="center">${badge(f.status)}</s-stack>
			<s-paragraph>${esc(f.description)}</s-paragraph>
			${disclaimer}
		</s-section>
		${timeline ? `<s-section heading="What Sightline observed">${table([{ label: 'Time' }, { label: 'Observation' }], timeline, 'No observations recorded.')}</s-section>` : ''}
		${why}
		<s-section heading="Evidence">
			${fields([
				['Paid', ts(f.projection?.paidAt)],
				['Expected confirmation by', ts(f.expectation?.deadline)],
				['Detected', ts(f.detectedAt)],
				['Resolved', ts(f.resolvedAt)],
				['Last reconciled with Shopify', ts(lastReconciledAt)],
				['Expectation state', f.expectation?.state ? badge(f.expectation.state) : '—'],
				['Rule version', esc(f.ruleVersion ?? '—')],
				['Evidence events', evidence],
			])}
		</s-section>`,
		{ href: '#/findings', label: 'Findings' },
	);
}

// ── privacy ──────────────────────────────────────────────────────────────────
export function privacyView(p: Privacy, now: number, strip: string): string {
	return page(
		'Privacy and app health',
		`${strip}
		<s-section>
			<s-banner tone="success" heading="No customer PII is stored">
				<s-paragraph>Sightline never records customer name, email, phone, or address.</s-paragraph>
			</s-banner>
		</s-section>
		<s-section heading="Installation">
			${fields([
				['Shop', esc(p.shop)],
				[
					'Granted access',
					p.scopes.length
						? p.scopes.map((s) => `<s-badge tone="info">${esc(s)}</s-badge>`).join(' ')
						: `<s-text color="subdued">read-only scopes pending confirmation</s-text>`,
				],
				['Retention', `${p.retentionDays} days, then permanently purged`],
			])}
		</s-section>
		<s-section heading="What we store">${bullets(p.dataCategories)}</s-section>
		<s-section heading="What we never store">${bullets(p.excludedFields)}</s-section>
		<s-section heading="App health">
			${statGrid([
				['Deliveries received', p.webhooks.received],
				['Processed', p.webhooks.processed],
				['Could not process', p.webhooks.deadLettered],
			])}
			${fields([
				[
					'Webhook capture',
					`${p.webhooks.healthy ? badge('healthy', 'success') : badge('needs attention', 'warning')}${
						p.webhooks.lastReceivedAt !== undefined ? ` · last delivery ${esc(relative(p.webhooks.lastReceivedAt, now))}` : ''
					}`,
				],
				[
					'Reconciliation',
					`${p.reconciliation.stale ? badge('delayed', 'warning') : badge('healthy', 'success')} · ${
						p.reconciliation.lastReconciledAt === undefined
							? 'initial check pending'
							: `last ran ${esc(relative(p.reconciliation.lastReconciledAt, now))}`
					}`,
				],
			])}
		</s-section>
		<s-section heading="Deletion">
			${bullets(Object.entries(p.deletion).map(([k, v]) => `${k}: ${v}`))}
		</s-section>
		<s-section heading="Help and support">
			${
				supportKnown()
					? `<s-paragraph>Questions about your data, or something not working? ${supportLinks()}</s-paragraph>`
					: `<s-paragraph><s-text tone="warning">Support contact is not configured for this deployment.</s-text></s-paragraph>`
			}
			<s-paragraph><s-link href="/privacy-policy" target="_blank">Read the full privacy policy</s-link></s-paragraph>
		</s-section>
		<s-section heading="This shop’s footprint">
			${statGrid([
				['Events', p.footprint.events],
				['Orders', p.footprint.orders],
				['Findings', p.footprint.findings],
			])}
		</s-section>`,
	);
}

export function notFoundView(): string {
	return page('Not found', `<s-section><s-paragraph>That page doesn’t exist.</s-paragraph></s-section>`);
}

// ── routing (pure) ───────────────────────────────────────────────────────────
export function parseHash(hash: string): { path: string; params: Record<string, string> } {
	const raw = hash.replace(/^#/, '') || '/';
	const [path, query] = raw.split('?');
	const params: Record<string, string> = {};
	for (const [k, v] of new URLSearchParams(query ?? '')) params[k] = v;
	return { path: path || '/', params };
}
