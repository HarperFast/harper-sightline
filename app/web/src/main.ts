import {
	apiSession,
	apiSetup,
	apiSummary,
	apiFlows,
	apiEvents,
	apiEvent,
	apiExport,
	apiFindings,
	apiFinding,
	apiPrivacy,
	apiOrders,
	apiOrder,
	apiDigest,
	apiSaveDigest,
	type EventItem,
	type OrderItem,
	type Setup,
	type Summary,
} from './api.ts';
import {
	authExpiredView,
	contextStrip,
	errorViewMarkup,
	eventDetailView,
	eventQuery,
	eventsView,
	EVENT_FILTER_KEYS,
	findingDetailView,
	findingsListView,
	notFoundView,
	notificationsView,
	orderDetailView,
	orderQuery,
	ordersView,
	ORDER_FILTER_KEYS,
	overviewView,
	parseHash,
	privacyView,
	setShop,
	setSupport,
	setupView,
	spinnerView,
	useShopTimeZone,
} from './view.ts';

// The DOM/fetch shell. All markup lives in view.ts as pure functions of data —
// this module only fetches, writes innerHTML, binds listeners, and routes.

const app = () => document.getElementById('app') as HTMLElement;

function render(html: string): void {
	app().innerHTML = html;
}

function loading(): void {
	render(spinnerView());
}

function bindRetry(): void {
	for (const button of document.querySelectorAll<HTMLElement>('[data-retry]')) {
		button.addEventListener('click', () => {
			summaryCache = null;
			void route();
		});
	}
}

// Polaris fields hold their value as a PROPERTY, so FormData/submit cannot be
// relied on to read them — every filter is read explicitly off the element.
function fieldValue(id: string): string {
	const el = document.getElementById(id) as (HTMLElement & { value?: unknown }) | null;
	const raw = el?.value ?? el?.getAttribute('value') ?? '';
	return String(raw).trim();
}

// Submit a filter group on its button click and on Enter anywhere within it.
function bindFilters(containerId: string, submit: () => void): void {
	const container = document.getElementById(containerId);
	if (!container) return;
	container.querySelector('[data-submit]')?.addEventListener('click', submit);
	container.addEventListener('keydown', (ev) => {
		if ((ev as KeyboardEvent).key === 'Enter') {
			ev.preventDefault();
			submit();
		}
	});
}

// Download the export as a blob. A direct link cannot carry the session-token
// header, so the file is fetched and handed to a synthetic anchor.
async function downloadExport(kind: string, params: Record<string, string | undefined>): Promise<void> {
	const result = await apiExport(kind, params);
	const url = URL.createObjectURL(new Blob([result.csv], { type: 'text/csv;charset=utf-8' }));
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = result.filename;
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	URL.revokeObjectURL(url);
	if (result.truncated) {
		// Never let a capped export read as "this is everything".
		window.alert(`Exported the first ${result.rows} rows. Narrow the filters to export the rest.`);
	}
}

function bindExport(params: Record<string, string | undefined>): void {
	for (const button of document.querySelectorAll<HTMLElement>('[data-export]')) {
		button.addEventListener('click', () => {
			// A rejected fetch (e.g. an expired session token) must not fail silently
			// as an unhandled promise rejection — the merchant needs to know the
			// export did not happen.
			downloadExport(button.getAttribute('data-export') ?? '', params).catch(() => {
				window.alert('Export failed. Try again, or reload the page if you were signed out.');
			});
		});
	}
}

function setActiveNav(path: string): void {
	const base = '/' + (path.split('/')[1] ?? '');
	for (const link of document.querySelectorAll<HTMLElement>('[data-nav]')) {
		link.toggleAttribute('data-active', (link.getAttribute('data-nav') || '/') === base);
	}
}

// ── summary cache ────────────────────────────────────────────────────────────
// The context strip and the Overview both want the summary and start at the same
// moment, so concurrent callers share one in-flight request rather than issuing
// two. Retry clears the cache, which is what makes the next call refetch.
let summaryCache: { at: number; value: Summary } | null = null;
let summaryInFlight: Promise<Summary> | null = null;
const SUMMARY_TTL_MS = 15_000;

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

// Screens other than the Overview don't otherwise need the summary, so they take
// the context strip best-effort and degrade to the minimal one.
async function strip(): Promise<string> {
	try {
		return contextStrip(await loadSummary(), Date.now());
	} catch {
		return contextStrip(null, Date.now());
	}
}

// ── screens ──────────────────────────────────────────────────────────────────
async function setupScreen(): Promise<void> {
	loading();
	render(setupView(await apiSetup()));
	bindRetry();
}

async function overview(): Promise<void> {
	loading();
	const [summaryResult, flowsResult, unconfirmedResult, setupResult] = await Promise.allSettled([
		loadSummary(),
		apiFlows(),
		apiFindings({ status: 'unconfirmed' }),
		apiSetup(),
	]);
	// The summary is this screen's spine — without it there is nothing honest to
	// render, so its failure is a screen-level error (or auth-expired) upstream.
	if (summaryResult.status === 'rejected') throw summaryResult.reason;
	render(
		overviewView({
			summary: summaryResult.value,
			flows: flowsResult.status === 'fulfilled' ? flowsResult.value : null,
			unconfirmed: unconfirmedResult.status === 'fulfilled' ? unconfirmedResult.value.items : null,
			setup: setupResult.status === 'fulfilled' ? setupResult.value : null,
			now: Date.now(),
		}),
	);
	bindRetry();
}

let eventItems: EventItem[] = [];
let eventCursor: string | undefined;
// The resolved query for the current result set. Held so "Load more" pages
// against the SAME window — recomputing `since` per page would drift the floor
// forward between pages and could skip a boundary row.
let eventQueryActive: Record<string, string> = {};

async function eventsList(params: Record<string, string>): Promise<void> {
	loading();
	eventItems = [];
	eventCursor = undefined;
	eventQueryActive = eventQuery(params, Date.now());
	const contextHtml = await strip();
	const first = await apiEvents(eventQueryActive);
	eventItems = first.items;
	eventCursor = first.nextCursor;
	paintEvents(params, contextHtml);
}

function paintEvents(params: Record<string, string>, contextHtml: string): void {
	render(eventsView(params, eventItems, Boolean(eventCursor), contextHtml));
	bindFilters('eventFilters', () => {
		const q = new URLSearchParams();
		for (const key of EVENT_FILTER_KEYS) {
			const v = fieldValue(`f-${key}`);
			if (v) q.set(key, v);
		}
		location.hash = `#/events${q.toString() ? `?${q}` : ''}`;
	});
	document.getElementById('loadMore')?.addEventListener('click', async () => {
		const next = await apiEvents({ ...eventQueryActive, cursor: eventCursor });
		eventItems.push(...next.items);
		eventCursor = next.nextCursor;
		paintEvents(params, contextHtml);
	});
	bindExport(eventQueryActive);
}

async function eventDetail(id: string): Promise<void> {
	loading();
	const contextHtml = await strip();
	render(eventDetailView(await apiEvent(id), contextHtml));
}

let orderItems: OrderItem[] = [];
let orderCursor: string | undefined;
let orderQueryActive: Record<string, string> = {};

async function ordersList(params: Record<string, string>): Promise<void> {
	loading();
	orderItems = [];
	orderCursor = undefined;
	orderQueryActive = orderQuery(params);
	const contextHtml = await strip();
	const first = await apiOrders(orderQueryActive);
	orderItems = first.items;
	orderCursor = first.nextCursor;
	paintOrders(params, contextHtml);
}

function paintOrders(params: Record<string, string>, contextHtml: string): void {
	render(ordersView(params, orderItems, Boolean(orderCursor), contextHtml));
	bindFilters('orderFilters', () => {
		const q = new URLSearchParams();
		for (const key of ORDER_FILTER_KEYS) {
			const v = fieldValue(`f-${key}`);
			if (v) q.set(key, v);
		}
		location.hash = `#/orders${q.toString() ? `?${q}` : ''}`;
	});
	document.getElementById('loadMore')?.addEventListener('click', async () => {
		const next = await apiOrders({ ...orderQueryActive, cursor: orderCursor });
		orderItems.push(...next.items);
		orderCursor = next.nextCursor;
		paintOrders(params, contextHtml);
	});
	bindExport(orderQueryActive);
}

async function orderDetail(orderId: string): Promise<void> {
	loading();
	const contextHtml = await strip();
	render(orderDetailView(await apiOrder(orderId), contextHtml));
}

async function findingsList(params: Record<string, string>): Promise<void> {
	loading();
	const contextHtml = await strip();
	const listPage = await apiFindings(params);
	render(findingsListView(params, listPage.items, Date.now(), contextHtml));
	bindFilters('findingFilters', () => {
		const q = new URLSearchParams();
		for (const key of ['status', 'detector']) {
			const v = fieldValue(`f-${key}`);
			if (v) q.set(key, v);
		}
		location.hash = `#/findings${q.toString() ? `?${q}` : ''}`;
	});
	bindExport(params);
}

async function findingDetail(id: string): Promise<void> {
	loading();
	const contextHtml = await strip();
	const finding = await apiFinding(id);
	// Last-reconciled is context, not evidence — a failure to read it must not
	// break the finding.
	let lastReconciledAt: number | undefined;
	try {
		lastReconciledAt = (await loadSummary()).reconciliation.lastReconciledAt;
	} catch {
		lastReconciledAt = undefined;
	}
	render(findingDetailView(finding, lastReconciledAt, contextHtml));
}

async function privacy(): Promise<void> {
	loading();
	const contextHtml = await strip();
	render(privacyView(await apiPrivacy(), Date.now(), contextHtml));
}

async function notifications(message?: { tone: string; text: string }): Promise<void> {
	loading();
	const contextHtml = await strip();
	const settings = await apiDigest();
	render(notificationsView(settings, Date.now(), contextHtml, message));
	document.querySelector('[data-save-digest]')?.addEventListener('click', () => {
		void (async () => {
			try {
				await apiSaveDigest({ email: fieldValue('f-email'), cadence: fieldValue('f-cadence') });
				await notifications({ tone: 'success', text: 'Saved.' });
			} catch (err) {
				// A 400 carries the validation reason; show it rather than a bare code.
				const text = String((err as Error).message).replace(/^400\s*/, '') || 'Could not save.';
				await notifications({ tone: 'critical', text });
			}
		})();
	});
}

// ── router ───────────────────────────────────────────────────────────────────
async function route(): Promise<void> {
	const { path, params } = parseHash(location.hash);
	setActiveNav(path);
	try {
		const eventId = path.match(/^\/events\/(.+)$/);
		const findingId = path.match(/^\/findings\/(.+)$/);
		const orderId = path.match(/^\/orders\/(.+)$/);
		if (path === '/' || path === '') await overview();
		else if (path === '/setup') await setupScreen();
		else if (eventId) await eventDetail(decodeURIComponent(eventId[1]));
		else if (orderId) await orderDetail(decodeURIComponent(orderId[1]));
		else if (path === '/orders') await ordersList(params);
		else if (path === '/events') await eventsList(params);
		else if (findingId) await findingDetail(decodeURIComponent(findingId[1]));
		else if (path === '/findings') await findingsList(params);
		else if (path === '/privacy') await privacy();
		else if (path === '/notifications') await notifications();
		else render(notFoundView());
	} catch (err) {
		// api.ts prefixes the thrown message with the HTTP status; a 401 means the
		// short-lived session token expired → show the reauthorization state.
		if (String((err as Error).message).startsWith('401')) render(authExpiredView());
		else {
			render(errorViewMarkup((err as Error).message));
			bindRetry();
		}
	}
}

async function boot(): Promise<void> {
	try {
		const session = window.__SIGHTLINE_SESSION__ ?? (await apiSession());
		// Adopt the store's timezone before the first render, so no screen ever
		// paints timestamps in one zone and then re-paints them in another.
		useShopTimeZone(session.timezone);
		setSupport(session.support);
		setShop(session.shop);
	} catch {
		// Not connected — the screens surface their own auth/error state.
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
