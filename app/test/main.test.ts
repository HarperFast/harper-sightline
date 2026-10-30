import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

// main.ts (`void boot()` at module scope) is the DOM/fetch shell: it fetches,
// writes innerHTML, and binds listeners, while view.ts's `saveErrorAction` is
// the pure decision the click handler consumes. That decision already has
// unit tests (test/view.test.ts) — what this file proves is the wiring: that
// the Notifications save handler actually calls the right render function
// with the right result. A 401 on save once rendered a bare "401" banner
// instead of the reauthorization view because that wiring lived only inside
// main.ts's DOM listener, unreachable by any test until now.
//
// Each test boots a fresh instance of main.ts against a stubbed DOM, App
// Bridge global, and fetch, landing directly on the Notifications screen —
// setting `location.hash` before import puts boot()'s own startup path
// (skip setup-detection whenever the hash is already an explicit route) on
// that screen, with no need to synthesize a hashchange event.
//
// main.ts has no exports, so it cannot be imported and driven as a module —
// it can only be booted and observed through the document it produces. A
// query-string suffix on the import specifier gives each test a fresh module
// instance (a distinct URL, so a distinct entry in Node's ESM cache), which
// resets main.ts's own module-scoped state (e.g. `summaryCache`) between
// tests without depending on import order. api.ts and view.ts resolve to
// their one shared, unsuffixed instance every time, exactly as in
// production, and their state (e.g. the timezone formatters) is reset every
// boot by session-derived calls, so sharing it is harmless.

type StubResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

function jsonResponse(status: number, body: unknown): StubResponse {
	return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out waiting for a DOM condition');
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

// Every save-error outcome (reauthorize, validation banner, success banner)
// renders a NEW <s-banner> that is never tone="info" — the one banner already
// on screen before any click, from notificationsView()'s permanent "digests
// are being prepared" notice. So "a non-info banner exists" is true the
// instant ANY of the three outcomes lands, regardless of which one — unlike
// polling for the specific tone a test expects, which cannot tell a slow
// correct render from a wrong one and degrades a tone regression (the exact
// bug class this harness exists for) into a silent multi-second timeout
// instead of a fast, readable diff. The strength belongs in the assertion
// that follows, not in what the poll waits for.
async function waitForOutcomeBanner(win: Window): Promise<Element> {
	await waitFor(() => Boolean(win.document.querySelector('s-banner:not([tone="info"])')));
	return win.document.querySelector('s-banner:not([tone="info"])') as unknown as Element;
}

let instanceCounter = 0;

// Boots main.ts on the Notifications screen. `putDigestResponse` stands in for
// whatever the save (PUT /api/v1/digest) call returns; every other request
// (the summary that feeds the context strip, the digest GET that seeds the
// form) gets a fixed, boring answer, since the decision under test never
// depends on them.
async function bootNotifications(putDigestResponse: () => StubResponse): Promise<Window> {
	const win = new Window({ url: 'https://sightline.test/' });
	win.document.body.innerHTML = '<div id="app"></div>';
	win.location.hash = '#/notifications';

	(globalThis as unknown as { window: unknown }).window = win;
	(globalThis as unknown as { document: unknown }).document = win.document;
	(globalThis as unknown as { location: unknown }).location = win.location;
	(globalThis as unknown as { history: unknown }).history = win.history;
	// api.ts's `declare const shopify` — the App Bridge global main.ts's data
	// client reads a fresh session token from on every request.
	(globalThis as unknown as { shopify: unknown }).shopify = { idToken: async () => 'test-id-token' };

	win.fetch = (async (path: unknown, init?: { method?: string }) => {
		const p = String(path);
		const method = init?.method ?? 'GET';
		if (p.startsWith('/api/v1/digest') && method === 'PUT') return putDigestResponse();
		if (p.startsWith('/api/v1/digest')) return jsonResponse(200, { cadence: 'daily', status: 'active' });
		// The summary fetch backing the context strip (and anything else this
		// screen doesn't need): every screen tolerates its failure, so a fixed
		// 500 keeps every test from having to shape a full Summary object.
		return jsonResponse(500, {});
	}) as unknown as Window['fetch'];

	const specifier = `../web/src/main.ts?instance=${instanceCounter++}`;
	await import(specifier);
	await waitFor(() => Boolean(win.document.querySelector('[data-save-digest]')));
	return win;
}

function click(win: Window, el: Element): void {
	el.dispatchEvent(new win.Event('click') as unknown as Event);
}

test('a save that 401s renders the reauthorization view, not a banner containing "401"', async () => {
	const win = await bootNotifications(() => jsonResponse(401, {}));

	click(win, win.document.querySelector('[data-save-digest]') as unknown as Element);
	const banner = await waitForOutcomeBanner(win);

	assert.equal(banner.getAttribute('tone'), 'warning', `expected the reauthorization banner but got: ${banner.outerHTML}`);
	assert.equal(banner.getAttribute('heading'), 'Session expired');
	assert.equal(
		banner.querySelector('s-paragraph')?.textContent?.trim(),
		'Your Shopify session timed out. Reload Sightline in Shopify Admin to reconnect — recording continued in the background the whole time.',
	);
	// The bug this harness exists to catch: a banner reading the bare status
	// code, rendered by notificationsView() instead of authExpiredView(). Once
	// the reauthorization view is up, the digest form (and any critical
	// banner) is gone — there is exactly one screen on show.
	assert.equal(win.document.querySelector('[data-save-digest]'), null);
	assert.equal(win.document.querySelector('s-banner[tone="critical"]'), null);
});

test('a save that 400s with a validation reason shows that reason', async () => {
	const win = await bootNotifications(() => jsonResponse(400, { error: 'Enter a valid email address.' }));

	click(win, win.document.querySelector('[data-save-digest]') as unknown as Element);
	const banner = await waitForOutcomeBanner(win);

	assert.equal(banner.getAttribute('tone'), 'critical', `expected the validation banner but got: ${banner.outerHTML}`);
	assert.equal(banner.querySelector('s-paragraph')?.textContent?.trim(), 'Enter a valid email address.');
	// The screen re-rendered the form, not the reauthorization view.
	assert.ok(win.document.querySelector('[data-save-digest]'));
});

test('a successful save re-renders with the confirmation', async () => {
	const win = await bootNotifications(() => jsonResponse(200, { cadence: 'daily', status: 'active' }));

	click(win, win.document.querySelector('[data-save-digest]') as unknown as Element);
	const banner = await waitForOutcomeBanner(win);

	assert.equal(banner.getAttribute('tone'), 'success', `expected the confirmation banner but got: ${banner.outerHTML}`);
	assert.equal(banner.querySelector('s-paragraph')?.textContent?.trim(), 'Saved.');
	assert.ok(win.document.querySelector('[data-save-digest]'));
});

// ── routing ──────────────────────────────────────────────────────────────────
// Admin's own sidebar (`s-app-nav`) requires each link to be a real path within
// the app and navigates to it client-side. Our links were fragments and the
// router only listened for `hashchange`, so every sidebar entry rendered and did
// nothing when clicked while the identical in-page links worked. Both halves of
// that failure live in main.ts's wiring — the router's input and the events it
// listens to — so both are exercised here through a real boot.

const PRIVACY = {
	shop: 's.myshopify.com',
	retentionDays: 7,
	storesCustomerPii: false,
	scopes: ['read_orders'],
	dataCategories: ['order ids'],
	excludedFields: ['email'],
	deletion: { shop: 'purged on uninstall' },
	footprint: { events: 1, orders: 1, findings: 0 },
	webhooks: { received: 1, processed: 1, deadLettered: 0, healthy: true },
	reconciliation: { ageMs: 0, stale: false, state: 'ready' },
};

async function bootAt(url: string): Promise<Window> {
	const win = new Window({ url });
	win.document.body.innerHTML = '<div id="app"></div>';
	(globalThis as unknown as { window: unknown }).window = win;
	(globalThis as unknown as { document: unknown }).document = win.document;
	(globalThis as unknown as { location: unknown }).location = win.location;
	(globalThis as unknown as { history: unknown }).history = win.history;
	(globalThis as unknown as { shopify: unknown }).shopify = { idToken: async () => 'test-id-token' };

	win.fetch = (async (path: unknown) => {
		const p = String(path);
		if (p.startsWith('/api/v1/privacy')) return jsonResponse(200, PRIVACY);
		if (p.startsWith('/api/v1/orders')) return jsonResponse(200, { items: [] });
		if (p.startsWith('/api/v1/setup')) {
			return jsonResponse(200, { shop: 's', complete: true, steps: [], eventsObserved: true, action: 'none' });
		}
		return jsonResponse(500, {});
	}) as unknown as Window['fetch'];

	await import(`../web/src/main.ts?instance=${instanceCounter++}`);
	return win;
}

const heading = (win: Window): string | null | undefined => win.document.querySelector('s-page')?.getAttribute('heading');

test('a real path renders that screen — what an Admin sidebar link actually loads', async () => {
	// Admin appends its own embed params; they must not be mistaken for filters, and
	// the path alone must decide the screen.
	const win = await bootAt('https://sightline.test/privacy?shop=acme.myshopify.com&embedded=1&id_token=x');
	await waitFor(() => heading(win) === 'Privacy and app health');
	assert.equal(heading(win), 'Privacy and app health');
});

test('a client-side pushState — what the sidebar does on click — re-routes', async () => {
	const win = await bootAt('https://sightline.test/');
	await waitFor(() => Boolean(heading(win)));
	// pushState fires no popstate event, so a router listening only for navigation
	// events sees nothing: the URL changes and the screen does not. That is exactly
	// how the sidebar links read as dead.
	win.history.pushState({}, '', '/orders');
	await waitFor(() => heading(win) === 'Orders');
	assert.equal(heading(win), 'Orders');
});

test('a path route does not get hijacked to the setup screen', async () => {
	// boot() lands first-time visitors on /setup while the initial check runs; it must
	// test the path, not `location.hash`, or every sidebar link would be swallowed.
	const win = new Window({ url: 'https://sightline.test/orders' });
	win.document.body.innerHTML = '<div id="app"></div>';
	(globalThis as unknown as { window: unknown }).window = win;
	(globalThis as unknown as { document: unknown }).document = win.document;
	(globalThis as unknown as { location: unknown }).location = win.location;
	(globalThis as unknown as { history: unknown }).history = win.history;
	(globalThis as unknown as { shopify: unknown }).shopify = { idToken: async () => 'test-id-token' };
	win.fetch = (async (path: unknown) => {
		const p = String(path);
		if (p.startsWith('/api/v1/orders')) return jsonResponse(200, { items: [] });
		// An INCOMPLETE setup — the condition that triggers the redirect.
		if (p.startsWith('/api/v1/setup')) {
			return jsonResponse(200, { shop: 's', complete: false, steps: [], eventsObserved: false, action: 'none' });
		}
		return jsonResponse(500, {});
	}) as unknown as Window['fetch'];

	await import(`../web/src/main.ts?instance=${instanceCounter++}`);
	await waitFor(() => heading(win) === 'Orders');
	assert.equal(heading(win), 'Orders');
	assert.equal(win.location.pathname, '/orders', 'and the URL was not rewritten');
});

// ── races ────────────────────────────────────────────────────────────────────
// Every screen awaits the network and then writes innerHTML, so each write must
// belong to the navigation that asked for it. These boot the real main.ts and hold
// chosen responses open, so the interleaving is fixed rather than timed.

type Deferred = { promise: Promise<StubResponse>; resolve: (res: StubResponse) => void };

function deferred(): Deferred {
	let resolve!: (res: StubResponse) => void;
	const promise = new Promise<StubResponse>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

// A macrotask boundary: every promise continuation a resolved response sets off
// (json(), the screen's await, its render) has run by the time this returns.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

async function bootWith(
	url: string,
	handler: (path: string, method: string) => Promise<StubResponse> | StubResponse,
): Promise<{ win: Window; calls: string[] }> {
	const win = new Window({ url });
	win.document.body.innerHTML = '<div id="app"></div>';
	(globalThis as unknown as { window: unknown }).window = win;
	(globalThis as unknown as { document: unknown }).document = win.document;
	(globalThis as unknown as { location: unknown }).location = win.location;
	(globalThis as unknown as { history: unknown }).history = win.history;
	(globalThis as unknown as { shopify: unknown }).shopify = { idToken: async () => 'test-id-token' };
	const calls: string[] = [];
	win.fetch = (async (path: unknown, init?: { method?: string }) => {
		calls.push(String(path));
		return handler(String(path), init?.method ?? 'GET');
	}) as unknown as Window['fetch'];
	await import(`../web/src/main.ts?instance=${instanceCounter++}`);
	return { win, calls };
}

function navigate(win: Window, hash: string): void {
	win.location.hash = hash;
	win.dispatchEvent(new win.Event('hashchange'));
}

const byId = (win: Window, id: string): Element | null => win.document.getElementById(id) as unknown as Element | null;
const rowCount = (win: Window): number => win.document.querySelectorAll('s-table-body s-table-row').length;

const eventRow = (eventId: string) => ({
	eventId,
	domain: 'order',
	topic: 'orders/paid',
	resourceId: '1',
	source: 'webhook',
	occurredAt: Date.now() - 1000,
	receivedAt: Date.now() - 1000,
});
const orderRow = (orderId: string) => ({ orderId, orderName: `#${orderId}`, state: 'awaiting', lastEventAt: Date.now() - 1000 });

test('a slow response for a screen the merchant already left does not paint over the new one', async () => {
	const slowEvents = deferred();
	const { win } = await bootWith('https://sightline.test/#/events', (p) => {
		if (p.startsWith('/api/v1/events')) return slowEvents.promise;
		if (p.startsWith('/api/v1/orders')) return jsonResponse(200, { items: [orderRow('ORD-FAST')] });
		return jsonResponse(500, {});
	});
	await settle();
	navigate(win, '#/orders');
	await waitFor(() => Boolean(byId(win, 'orderFilters')));

	slowEvents.resolve(jsonResponse(200, { items: [eventRow('EVT-SLOW')] }));
	await settle();

	assert.ok(byId(win, 'orderFilters'), 'the Orders screen is still on show');
	assert.equal(byId(win, 'eventFilters'), null);
	assert.ok(!win.document.getElementById('app')!.innerHTML.includes('EVT-SLOW'));
});

test('a screen the merchant left while its context strip loaded never requests its own data', async () => {
	const summary = deferred();
	const { win, calls } = await bootWith('https://sightline.test/#/events', (p) => {
		if (p.startsWith('/api/v1/summary')) return summary.promise;
		if (p.startsWith('/api/v1/privacy')) return jsonResponse(500, {});
		return jsonResponse(200, { items: [] });
	});
	await settle();
	navigate(win, '#/privacy');
	await settle();
	summary.resolve(jsonResponse(500, {}));
	await settle();
	assert.ok(
		calls.some((c) => c.startsWith('/api/v1/privacy')),
		'the screen the merchant is on loads',
	);
	assert.deepEqual(
		calls.filter((c) => c.startsWith('/api/v1/events')),
		[],
	);
});

test('a finding the merchant left while it loaded does not go on to request the summary', async () => {
	const finding = deferred();
	const { win, calls } = await bootWith('https://sightline.test/#/findings/F1', (p) => {
		if (p.startsWith('/api/v1/findings/')) return finding.promise;
		if (p.startsWith('/api/v1/summary')) return jsonResponse(500, {});
		return jsonResponse(200, { items: [] });
	});
	await settle();
	navigate(win, '#/orders');
	await waitFor(() => Boolean(byId(win, 'orderFilters')));
	const summaries = calls.filter((c) => c.startsWith('/api/v1/summary')).length;
	finding.resolve(jsonResponse(200, { id: 'F1', orderId: '1', status: 'unconfirmed' }));
	await settle();
	assert.equal(calls.filter((c) => c.startsWith('/api/v1/summary')).length, summaries);
});

test('a second click on "Load more" while a page is in flight fetches and appends that page once', async () => {
	const page2 = deferred();
	const { win, calls } = await bootWith('https://sightline.test/#/events', (p) => {
		if (p.startsWith('/api/v1/events') && p.includes('cursor=')) return page2.promise;
		if (p.startsWith('/api/v1/events')) return jsonResponse(200, { items: [eventRow('EVT-PAGE1')], nextCursor: 'c1' });
		return jsonResponse(500, {});
	});
	await waitFor(() => Boolean(byId(win, 'loadMore')));
	const button = byId(win, 'loadMore')!;

	click(win, button);
	await settle();
	assert.ok(button.hasAttribute('disabled'), 'the button is disabled while its page is in flight');
	click(win, button);
	await settle();
	assert.equal(calls.filter((c) => c.includes('cursor=c1')).length, 1, 'the second click did not request the page again');

	page2.resolve(jsonResponse(200, { items: [eventRow('EVT-PAGE2')] }));
	await waitFor(() => win.document.getElementById('app')!.innerHTML.includes('EVT-PAGE2'));
	await settle();
	assert.equal(rowCount(win), 2, 'one row per event: page 1, then page 2 once');
});

test('a "Load more" page that lands after the merchant moved on does not repaint the old list', async () => {
	const page2 = deferred();
	const { win } = await bootWith('https://sightline.test/#/orders', (p) => {
		if (p.startsWith('/api/v1/orders') && p.includes('cursor=')) return page2.promise;
		if (p.startsWith('/api/v1/orders')) return jsonResponse(200, { items: [orderRow('ORD-PAGE1')], nextCursor: 'c1' });
		if (p.startsWith('/api/v1/findings')) return jsonResponse(200, { items: [] });
		return jsonResponse(500, {});
	});
	await waitFor(() => Boolean(byId(win, 'loadMore')));
	click(win, byId(win, 'loadMore')!);
	await settle();
	navigate(win, '#/findings');
	await waitFor(() => Boolean(byId(win, 'findingFilters')));

	page2.resolve(jsonResponse(200, { items: [orderRow('ORD-PAGE2')] }));
	await settle();

	assert.ok(byId(win, 'findingFilters'), 'the Findings screen is still on show');
	assert.equal(byId(win, 'orderFilters'), null);
	assert.ok(!win.document.getElementById('app')!.innerHTML.includes('ORD-PAGE2'));
});

test('a digest save that finishes after the merchant moved on does not bring Notifications back', async () => {
	const save = deferred();
	const { win } = await bootWith('https://sightline.test/#/notifications', (p, method) => {
		if (p.startsWith('/api/v1/digest') && method === 'PUT') return save.promise;
		if (p.startsWith('/api/v1/digest')) return jsonResponse(200, { cadence: 'daily', status: 'active' });
		if (p.startsWith('/api/v1/orders')) return jsonResponse(200, { items: [] });
		return jsonResponse(500, {});
	});
	await waitFor(() => Boolean(win.document.querySelector('[data-save-digest]')));
	click(win, win.document.querySelector('[data-save-digest]') as unknown as Element);
	await settle();
	navigate(win, '#/orders');
	await waitFor(() => Boolean(byId(win, 'orderFilters')));

	save.resolve(jsonResponse(200, { cadence: 'daily', status: 'active' }));
	await settle();

	assert.ok(byId(win, 'orderFilters'), 'the Orders screen is still on show');
	assert.equal(win.document.querySelector('[data-save-digest]'), null);
});

test('the first-open setup check does not redirect a merchant who already navigated', async () => {
	const setup = deferred();
	const { win } = await bootWith('https://sightline.test/', (p) => {
		if (p.startsWith('/api/v1/setup')) return setup.promise;
		if (p.startsWith('/api/v1/orders')) return jsonResponse(200, { items: [] });
		return jsonResponse(500, {});
	});
	await settle();
	// The sidebar navigates by pushState while boot() is still waiting on the check.
	win.history.pushState({}, '', '/orders');
	await waitFor(() => Boolean(byId(win, 'orderFilters')));

	setup.resolve(jsonResponse(200, { shop: 's', complete: false, steps: [], eventsObserved: false, action: 'none' }));
	await settle();

	assert.ok(byId(win, 'orderFilters'), 'the Orders screen is still on show');
	assert.equal(win.location.pathname, '/orders');
	assert.equal(win.location.hash, '', 'and the URL was not rewritten to #/setup');
});
