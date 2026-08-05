import {
	apiSession,
	apiSummary,
	apiFlows,
	apiEvents,
	apiEvent,
	apiFindings,
	apiFinding,
	apiPrivacy,
	type EventItem,
	type FindingItem,
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

function fmt(ms: number | undefined): string {
	if (ms === undefined || ms === null) return '—';
	return new Date(ms).toLocaleString();
}

function elapsed(fromMs: number | undefined, toMs: number): string {
	if (!fromMs) return '—';
	const s = Math.max(0, Math.floor((toMs - fromMs) / 1000));
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	if (s < 86400) return `${Math.floor(s / 3600)}h`;
	return `${Math.floor(s / 86400)}d`;
}

const STATUS_TONE: Record<string, string> = { unconfirmed: 'warn', resolved: 'ok', suppressed: 'muted', pending: 'muted', expired: 'warn' };
function badge(text: string, tone = 'muted'): string {
	return `<span class="badge badge-${esc(STATUS_TONE[text] ?? tone)}">${esc(text)}</span>`;
}

function loading(): void {
	app().innerHTML = `<p class="muted">Loading…</p>`;
}
function errorView(err: unknown): void {
	app().innerHTML = `<div class="notice notice-warn"><strong>Couldn’t load.</strong> ${esc((err as Error).message)}</div>`;
}

// ── screens ──────────────────────────────────────────────────────────────────
async function overview(): Promise<void> {
	loading();
	const [s, f] = await Promise.all([apiSummary(), apiFlows()]);
	const health = s.recorder.healthy
		? `<div class="notice notice-ok"><strong>Recorder healthy.</strong> Capturing order, fulfillment, inventory and refund activity.</div>`
		: `<div class="notice notice-warn"><strong>Recorder needs attention:</strong> ${s.recorder.deadLetteredDeliveries} deliver(ies) could not be processed. Gap results may be incomplete.</div>`;
	const stat = (label: string, value: number) =>
		`<div class="stat"><div class="stat-value">${value}</div><div class="stat-label">${esc(label)}</div></div>`;
	const lane = (label: string, n: number) => `<div class="lane"><span>${esc(label)}</span><span class="lane-count">${n}</span></div>`;
	app().innerHTML = `
		${health}
		<h2>Orders (last ${s.windowDays} days)</h2>
		<div class="stats">
			${stat('Tracked', s.orders.tracked)}${stat('Paid', s.orders.paid)}${stat('Fulfilled', s.orders.fulfilled)}${stat('Awaiting confirmation', s.orders.awaitingConfirmation)}
		</div>
		<h2>Findings</h2>
		<div class="stats">
			${stat('Unconfirmed', s.findings.unconfirmed)}${stat('Resolved', s.findings.resolved)}${stat('Suppressed', s.findings.suppressed)}
		</div>
		<h2>Flow</h2>
		<div class="lanes">
			${lane('Paid', f.lanes.paid)}${lane('Fulfilled', f.lanes.fulfilled)}${lane('Awaiting confirmation', f.lanes.awaitingConfirmation)}${lane('Cancelled', f.lanes.cancelled)}${lane('Refunded', f.lanes.refunded)}
		</div>
		<p class="muted">${s.events.total} normalized events recorded in the window.</p>`;
}

const DOMAINS = ['', 'order', 'fulfillment', 'inventory', 'refund'];
let eventItems: EventItem[] = [];
let eventCursor: string | undefined;

async function eventsList(params: Record<string, string>): Promise<void> {
	loading();
	eventItems = [];
	eventCursor = undefined;
	const page = await apiEvents(params);
	eventItems = page.items;
	eventCursor = page.nextCursor;
	renderEvents(params);
}

function renderEvents(params: Record<string, string>): void {
	const rows = eventItems
		.map(
			(e) => `<tr class="rowlink" data-href="#/events/${encodeURIComponent(e.eventId)}">
			<td>${fmt(e.occurredAt)}</td><td>${esc(e.domain)}</td><td>${esc(e.topic ?? '')}</td>
			<td>${esc(e.resourceId ?? '')}</td><td>${esc(e.sku ?? '')}${e.quantity !== undefined ? ` ×${e.quantity}` : ''}</td>
			<td>${e.state ? badge(e.state) : ''}</td></tr>`,
		)
		.join('');
	const sel = (v: string) => DOMAINS.map((d) => `<option value="${d}"${d === v ? ' selected' : ''}>${d || 'Any domain'}</option>`).join('');
	app().innerHTML = `
		<form id="eventFilters" class="filters">
			<select name="domain">${sel(params.domain ?? '')}</select>
			<input name="resourceId" placeholder="Order / resource ID" value="${esc(params.resourceId ?? '')}" />
			<input name="sku" placeholder="SKU" value="${esc(params.sku ?? '')}" />
			<button type="submit">Search</button>
		</form>
		<table class="grid"><thead><tr><th>Time</th><th>Domain</th><th>Topic</th><th>Resource</th><th>SKU</th><th>State</th></tr></thead>
		<tbody>${rows || `<tr><td colspan="6" class="muted">No events match.</td></tr>`}</tbody></table>
		${eventCursor ? `<button id="loadMore">Load more</button>` : ''}`;
	document.getElementById('eventFilters')?.addEventListener('submit', (ev) => {
		ev.preventDefault();
		const fd = new FormData(ev.target as HTMLFormElement);
		const q = new URLSearchParams();
		for (const k of ['domain', 'resourceId', 'sku']) {
			const v = String(fd.get(k) ?? '').trim();
			if (v) q.set(k, v);
		}
		location.hash = `#/events${q.toString() ? `?${q}` : ''}`;
	});
	document.getElementById('loadMore')?.addEventListener('click', async () => {
		const page = await apiEvents({ ...params, cursor: eventCursor });
		eventItems.push(...page.items);
		eventCursor = page.nextCursor;
		renderEvents(params);
	});
	for (const row of document.querySelectorAll<HTMLElement>('.rowlink')) {
		row.addEventListener('click', () => {
			location.hash = row.dataset.href ?? '#/events';
		});
	}
}

async function eventDetail(id: string): Promise<void> {
	loading();
	const e = await apiEvent(id);
	const field = (label: string, value: string) => `<div class="field"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
	const related = e.relatedEventIds.length
		? e.relatedEventIds.map((r) => `<a href="#/events/${encodeURIComponent(r)}">${esc(r.split(':').pop())}</a>`).join(', ')
		: '<span class="muted">none</span>';
	app().innerHTML = `
		<a href="#/events" class="back">← Events</a>
		<h2>${esc(e.domain)} · ${esc(e.topic ?? '')}</h2>
		<dl class="fields">
			${field('Resource', esc(e.resourceId ?? '—'))}
			${field('State', e.state ? badge(e.state) : '—')}
			${field('SKU', esc(e.sku ?? '—'))}
			${field('Quantity', e.quantity !== undefined ? String(e.quantity) : '—')}
			${field('Fulfillment-eligible units', e.fulfillableItemCount !== undefined ? String(e.fulfillableItemCount) : '—')}
			${field('Occurred (source)', fmt(e.occurredAt))}
			${field('Received', fmt(e.receivedAt))}
			${field('Source', esc(e.source))}
			${field('Affected a projection', e.affectedProjection ? 'Yes' : 'No')}
			${field('Affected a finding', e.affectedFinding ? 'Yes' : 'No')}
			${field('Related events', related)}
		</dl>`;
}

const STATUSES = ['', 'unconfirmed', 'resolved', 'suppressed'];
async function findingsList(params: Record<string, string>): Promise<void> {
	loading();
	const page = await apiFindings(params);
	const now = Date.now();
	const rows = page.items
		.map(
			(x: FindingItem) => `<tr class="rowlink" data-href="#/findings/${encodeURIComponent(x.id)}">
			<td>${esc(x.orderId)}</td><td>${badge(x.status)}</td><td>${fmt(x.detectedAt)}</td>
			<td>${x.status === 'unconfirmed' ? elapsed(x.detectedAt, now) : '—'}</td></tr>`,
		)
		.join('');
	const sel = STATUSES.map(
		(s) => `<option value="${s}"${s === (params.status ?? '') ? ' selected' : ''}>${s || 'Any status'}</option>`,
	).join('');
	app().innerHTML = `
		<form id="findingFilters" class="filters"><select name="status">${sel}</select><button type="submit">Filter</button></form>
		<table class="grid"><thead><tr><th>Order</th><th>Status</th><th>Detected</th><th>Open for</th></tr></thead>
		<tbody>${rows || `<tr><td colspan="4" class="muted">No findings — nothing is missing confirmation.</td></tr>`}</tbody></table>`;
	document.getElementById('findingFilters')?.addEventListener('submit', (ev) => {
		ev.preventDefault();
		const v = String(new FormData(ev.target as HTMLFormElement).get('status') ?? '');
		location.hash = `#/findings${v ? `?status=${v}` : ''}`;
	});
	for (const row of document.querySelectorAll<HTMLElement>('.rowlink')) {
		row.addEventListener('click', () => {
			location.hash = row.dataset.href ?? '#/findings';
		});
	}
}

async function findingDetail(id: string): Promise<void> {
	loading();
	const f = await apiFinding(id);
	const field = (label: string, value: string) => `<div class="field"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
	const evidence = (f.evidenceEventIds ?? []).length
		? (f.evidenceEventIds ?? []).map((e) => `<a href="#/events/${encodeURIComponent(e)}">${esc(e.split(':').pop())}</a>`).join(', ')
		: '<span class="muted">none</span>';
	app().innerHTML = `
		<a href="#/findings" class="back">← Findings</a>
		<h2>Order ${esc(f.orderId)} ${badge(f.status)}</h2>
		<div class="notice">${esc(f.description)}</div>
		<dl class="fields">
			${field('Paid', fmt(f.projection?.paidAt))}
			${field('Expected confirmation by', fmt(f.expectation?.deadline))}
			${field('Detected', fmt(f.detectedAt))}
			${field('Resolved', fmt(f.resolvedAt))}
			${field('Expectation state', f.expectation?.state ? badge(f.expectation.state) : '—')}
			${field('Rule version', esc(f.ruleVersion ?? '—'))}
			${field('Evidence events', evidence)}
		</dl>`;
}

async function privacy(): Promise<void> {
	loading();
	const p = await apiPrivacy();
	const cats = p.dataCategories.map((c) => `<li>${esc(c)}</li>`).join('');
	const del = Object.entries(p.deletion)
		.map(([k, v]) => `<li><strong>${esc(k)}:</strong> ${esc(v)}</li>`)
		.join('');
	app().innerHTML = `
		<div class="notice notice-ok"><strong>No customer PII is stored.</strong> Sightline never records customer name, email, phone, or address.</div>
		<h2>What we store (${p.retentionDays}-day retention)</h2>
		<ul>${cats}</ul>
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
	try {
		const eventId = path.match(/^\/events\/(.+)$/);
		const findingId = path.match(/^\/findings\/(.+)$/);
		if (path === '/' || path === '') await overview();
		else if (eventId) await eventDetail(decodeURIComponent(eventId[1]));
		else if (path === '/events') await eventsList(params);
		else if (findingId) await findingDetail(decodeURIComponent(findingId[1]));
		else if (path === '/findings') await findingsList(params);
		else if (path === '/privacy') await privacy();
		else app().innerHTML = `<p class="muted">Not found.</p>`;
	} catch (err) {
		errorView(err);
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
	void route();
}

void boot();
