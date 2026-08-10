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
	await waitFor(() => Boolean(win.document.querySelector('s-banner[tone="warning"]')));

	const banner = win.document.querySelector('s-banner[tone="warning"]');
	assert.equal(banner?.getAttribute('heading'), 'Session expired');
	assert.equal(
		banner?.querySelector('s-paragraph')?.textContent?.trim(),
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
	await waitFor(() => Boolean(win.document.querySelector('s-banner[tone="critical"]')));

	const banner = win.document.querySelector('s-banner[tone="critical"]');
	assert.equal(banner?.querySelector('s-paragraph')?.textContent?.trim(), 'Enter a valid email address.');
	// The screen re-rendered the form, not the reauthorization view.
	assert.ok(win.document.querySelector('[data-save-digest]'));
});

test('a successful save re-renders with the confirmation', async () => {
	const win = await bootNotifications(() => jsonResponse(200, { cadence: 'daily', status: 'active' }));

	click(win, win.document.querySelector('[data-save-digest]') as unknown as Element);
	await waitFor(() => Boolean(win.document.querySelector('s-banner[tone="success"]')));

	const banner = win.document.querySelector('s-banner[tone="success"]');
	assert.equal(banner?.querySelector('s-paragraph')?.textContent?.trim(), 'Saved.');
	assert.ok(win.document.querySelector('[data-save-digest]'));
});
