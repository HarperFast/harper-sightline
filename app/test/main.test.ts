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
