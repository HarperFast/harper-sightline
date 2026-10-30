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
	exportErrorMessage,
	findingDetailView,
	findingsListView,
	FINDING_FILTER_KEYS,
	notFoundView,
	notificationsView,
	orderDetailView,
	orderQuery,
	ordersView,
	ORDER_FILTER_KEYS,
	overviewView,
	parseRoute,
	privacyView,
	saveErrorAction,
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

// Every screen awaits the network and then paints. route() takes a new token on
// each navigation and hands it to the screen, which drops its paint when the token
// is no longer current — otherwise a slow answer for a screen the merchant already
// left lands after the one they moved to and paints over it. The check belongs
// after the LAST await before each render: anything earlier still leaves a gap.
let currentNav = 0;

function stale(nav: number): boolean {
	return nav !== currentNav;
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

function setFieldValue(id: string, value: string): void {
	const el = document.getElementById(id) as (HTMLElement & { value?: unknown }) | null;
	if (!el) return;
	el.value = value;
	if (value === '') el.removeAttribute('value');
	else el.setAttribute('value', value);
}

// Submit a filter group on its button click and on Enter anywhere within it.
function bindFilters(containerId: string, submit: () => void): void {
	const container = document.getElementById(containerId);
	if (!container) return;
	container.querySelector('[data-submit]')?.addEventListener('click', submit);
	container.addEventListener('keydown', (ev) => {
		if ((ev as KeyboardEvent).key !== 'Enter') return;
		// A <summary> (the Events screen's filter disclosure) opens and closes on
		// Enter. Treating that as "submit the filters" would make the disclosure
		// impossible to open from the keyboard — the group is INSIDE it, so the
		// keydown bubbles here either way.
		if ((ev.target as HTMLElement | null)?.closest?.('summary')) return;
		ev.preventDefault();
		submit();
	});
}

// Build the hash for a filter group by reading its controls. Shared by every list
// screen so "which keys does this view carry" is stated once per screen and read
// the same way.
function submitFilters(path: string, keys: readonly string[]): void {
	const query = new URLSearchParams();
	for (const key of keys) {
		const value = fieldValue(`f-${key}`);
		if (value) query.set(key, value);
	}
	location.hash = `#${path}${query.toString() ? `?${query}` : ''}`;
}

// Each active-filter chip is a link to the same view without that filter, so a
// plain click already does the right thing. `removable` chips also fire their own
// `remove` event for the × — which is NOT a click — so it is bound to the same
// destination rather than left as an affordance that does nothing.
function bindChips(): void {
	for (const chip of document.querySelectorAll<HTMLElement>('[data-remove-filter]')) {
		chip.addEventListener('remove', () => {
			const href = chip.getAttribute('href');
			if (href) location.hash = href;
		});
	}
}

// The relative preset and the explicit From/To dates are two ways to say the same
// thing, so setting either clears the other. Without this, a merchant who picked
// "Last hour" over an existing date range would get the dates (which win in
// eventQuery) and no visible reason why.
function bindTimeControls(): void {
	document.getElementById('f-range')?.addEventListener('change', () => {
		if (!fieldValue('f-range')) return;
		setFieldValue('f-from', '');
		setFieldValue('f-to', '');
	});
	for (const id of ['f-from', 'f-to']) {
		document.getElementById(id)?.addEventListener('change', () => {
			if (fieldValue(id)) setFieldValue('f-range', '');
		});
	}
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
			downloadExport(button.getAttribute('data-export') ?? '', params).catch((err) => {
				window.alert(exportErrorMessage(String((err as Error).message)));
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
async function setupScreen(nav: number): Promise<void> {
	loading();
	const setup = await apiSetup();
	if (stale(nav)) return;
	render(setupView(setup));
	bindRetry();
}

async function overview(nav: number): Promise<void> {
	loading();
	const [summaryResult, flowsResult, unconfirmedResult, setupResult] = await Promise.allSettled([
		loadSummary(),
		apiFlows(),
		apiFindings({ status: 'unconfirmed' }),
		apiSetup(),
	]);
	if (stale(nav)) return;
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

// "Load more" asks for one page at a time: the button is disabled while its
// request is out and a click on a disabled button is ignored, so a double click
// cannot fetch the same cursor twice and append that page twice. The page is
// dropped if the merchant navigated while it was in flight.
function bindLoadMore<T>(nav: number, fetchNext: () => Promise<T>, append: (page: T) => void): void {
	const button = document.getElementById('loadMore');
	button?.addEventListener('click', async () => {
		if (button.hasAttribute('disabled')) return;
		button.setAttribute('disabled', '');
		try {
			const page = await fetchNext();
			if (!stale(nav)) append(page);
		} finally {
			// A successful append repaints with a fresh button; this re-enables the
			// old one after a failure so the merchant can try again.
			button.removeAttribute('disabled');
		}
	});
}

async function eventsList(nav: number, params: Record<string, string>): Promise<void> {
	loading();
	eventItems = [];
	eventCursor = undefined;
	eventQueryActive = eventQuery(params, Date.now());
	const contextHtml = await strip();
	const first = await apiEvents(eventQueryActive);
	if (stale(nav)) return;
	eventItems = first.items;
	eventCursor = first.nextCursor;
	paintEvents(nav, params, contextHtml);
}

function paintEvents(nav: number, params: Record<string, string>, contextHtml: string): void {
	render(eventsView(params, eventItems, Boolean(eventCursor), contextHtml));
	bindFilters('eventFilters', () => submitFilters('/events', EVENT_FILTER_KEYS));
	bindTimeControls();
	bindChips();
	bindLoadMore(
		nav,
		() => apiEvents({ ...eventQueryActive, cursor: eventCursor }),
		(next) => {
			eventItems.push(...next.items);
			eventCursor = next.nextCursor;
			paintEvents(nav, params, contextHtml);
		},
	);
	bindExport(eventQueryActive);
}

async function eventDetail(nav: number, id: string): Promise<void> {
	loading();
	const contextHtml = await strip();
	const event = await apiEvent(id);
	if (stale(nav)) return;
	render(eventDetailView(event, contextHtml));
}

let orderItems: OrderItem[] = [];
let orderCursor: string | undefined;
let orderQueryActive: Record<string, string> = {};

async function ordersList(nav: number, params: Record<string, string>): Promise<void> {
	loading();
	orderItems = [];
	orderCursor = undefined;
	orderQueryActive = orderQuery(params);
	const contextHtml = await strip();
	const first = await apiOrders(orderQueryActive);
	if (stale(nav)) return;
	orderItems = first.items;
	orderCursor = first.nextCursor;
	paintOrders(nav, params, contextHtml);
}

function paintOrders(nav: number, params: Record<string, string>, contextHtml: string): void {
	render(ordersView(params, orderItems, Boolean(orderCursor), contextHtml));
	// `maxAgeHours` has no control of its own — it arrives from an aging-bucket link
	// — so reading the controls deliberately drops it: changing the Age select must
	// not silently keep a bucket's upper bound. Its chip is how it stays visible and
	// removable in the meantime.
	bindFilters('orderFilters', () =>
		submitFilters(
			'/orders',
			ORDER_FILTER_KEYS.filter((key) => key !== 'maxAgeHours'),
		),
	);
	bindChips();
	bindLoadMore(
		nav,
		() => apiOrders({ ...orderQueryActive, cursor: orderCursor }),
		(next) => {
			orderItems.push(...next.items);
			orderCursor = next.nextCursor;
			paintOrders(nav, params, contextHtml);
		},
	);
	bindExport(orderQueryActive);
}

async function orderDetail(nav: number, orderId: string): Promise<void> {
	loading();
	const contextHtml = await strip();
	const order = await apiOrder(orderId);
	if (stale(nav)) return;
	render(orderDetailView(order, contextHtml));
}

async function findingsList(nav: number, params: Record<string, string>): Promise<void> {
	loading();
	const contextHtml = await strip();
	const listPage = await apiFindings(params);
	if (stale(nav)) return;
	render(findingsListView(params, listPage.items, Date.now(), contextHtml));
	bindFilters('findingFilters', () => submitFilters('/findings', FINDING_FILTER_KEYS));
	bindChips();
	bindExport(params);
}

async function findingDetail(nav: number, id: string): Promise<void> {
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
	if (stale(nav)) return;
	render(findingDetailView(finding, lastReconciledAt, contextHtml));
}

async function privacy(nav: number): Promise<void> {
	loading();
	const contextHtml = await strip();
	const report = await apiPrivacy();
	if (stale(nav)) return;
	render(privacyView(report, Date.now(), contextHtml));
}

async function notifications(nav: number, message?: { tone: string; text: string }): Promise<void> {
	loading();
	const contextHtml = await strip();
	const settings = await apiDigest();
	if (stale(nav)) return;
	render(notificationsView(settings, Date.now(), contextHtml, message));
	document.querySelector('[data-save-digest]')?.addEventListener('click', () => {
		void (async () => {
			try {
				await apiSaveDigest({ email: fieldValue('f-email'), cadence: fieldValue('f-cadence') });
				// Checked before notifications() rather than left to it: its spinner
				// paints synchronously, before any check of its own could run.
				if (stale(nav)) return;
				await notifications(nav, { tone: 'success', text: 'Saved.' });
			} catch (err) {
				if (stale(nav)) return;
				const action = saveErrorAction(String((err as Error).message));
				// A click handler never goes through route(), so it doesn't get that
				// function's 401 → authExpiredView() handling for free — ask for the same
				// decision explicitly rather than showing the merchant a bare "401".
				if (action.kind === 'reauthorize') render(authExpiredView());
				else await notifications(nav, { tone: 'critical', text: action.text });
			}
		})();
	});
}

// ── router ───────────────────────────────────────────────────────────────────
async function route(): Promise<void> {
	const nav = ++currentNav;
	const { path, params } = parseRoute(location);
	setActiveNav(path);
	try {
		const eventId = path.match(/^\/events\/(.+)$/);
		const findingId = path.match(/^\/findings\/(.+)$/);
		const orderId = path.match(/^\/orders\/(.+)$/);
		if (path === '/' || path === '') await overview(nav);
		else if (path === '/setup') await setupScreen(nav);
		else if (eventId) await eventDetail(nav, decodeURIComponent(eventId[1]));
		else if (orderId) await orderDetail(nav, decodeURIComponent(orderId[1]));
		else if (path === '/orders') await ordersList(nav, params);
		else if (path === '/events') await eventsList(nav, params);
		else if (findingId) await findingDetail(nav, decodeURIComponent(findingId[1]));
		else if (path === '/findings') await findingsList(nav, params);
		else if (path === '/privacy') await privacy(nav);
		else if (path === '/notifications') await notifications(nav);
		else render(notFoundView());
	} catch (err) {
		// A failure for a screen the merchant already left is not theirs to see.
		if (stale(nav)) return;
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
	// Admin's sidebar (`s-app-nav`) navigates client-side to a real path, so the
	// router has to hear about History-API navigation too — a hashchange listener
	// alone is why those links appeared inert.
	//
	// `popstate` covers browser back/forward and any navigation that dispatches it.
	// A `pushState` does NOT fire popstate, so it is wrapped to announce itself:
	// without that, a sidebar click that pushes '/orders' would change the URL and
	// leave the screen untouched — the same silent no-op, one layer down. Only
	// pushState is wrapped, deliberately: this module's own replaceState (below) must
	// stay silent, since route() is called explicitly right after it.
	window.addEventListener('popstate', () => void route());
	const pushState = history.pushState.bind(history);
	history.pushState = (...args: Parameters<typeof history.pushState>) => {
		pushState(...args);
		void route();
	};

	// First open lands on the setup screen while the initial check runs, so the app
	// explains itself instead of showing an empty overview that looks like "no
	// gaps" (screen spec §1). Any explicit route wins — this never traps the user.
	// "Explicit" now includes a real path: a sidebar link to /orders must not be
	// hijacked to the setup screen.
	if (parseRoute(location).path === '/') {
		const nav = currentNav;
		let setup: Setup | null = null;
		try {
			setup = await apiSetup();
		} catch {
			setup = null;
		}
		// The listeners above are live while the check runs: if the merchant already
		// navigated, route() has rendered where they went, and redirecting them to
		// setup now would undo that.
		if (stale(nav)) return;
		// replaceState (not location.hash =) so this does NOT fire hashchange and
		// double-render — route() below does the single render.
		if (setup && !setup.complete) history.replaceState(null, '', '#/setup');
	}
	void route();
}

void boot();
