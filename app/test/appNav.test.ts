import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRoute } from '../web/src/view.ts';

// Admin's own sidebar is `s-app-nav`, and it is only verifiable inside real Admin —
// which is how six dead links shipped: the entries rendered in the sidebar and
// clicking them did nothing, while the identical routes in the in-page nav worked.
// The cause was the href format. `s-app-nav` requires "a relative path within your
// app" (`/orders`) and navigates to it client-side; ours were fragments (`#/orders`),
// which that contract does not cover.
//
// Nothing offline can click a link Admin renders outside our iframe, so this pins
// the two halves that were wrong instead: the hrefs in the document, and that every
// one of them resolves to a screen the router knows.

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const appNav = /<s-app-nav>([\s\S]*?)<\/s-app-nav>/.exec(html)?.[1] ?? '';
const hrefs = [...appNav.matchAll(/<s-link href="([^"]+)"([^>]*)>/g)].map(([, href, rest]) => ({ href, rest }));

// Routes the SPA answers to. `/setup` is deliberately absent: it is a first-open
// state the app routes to itself, not a destination in the sidebar.
const ROUTES = ['/', '/orders', '/events', '/findings', '/notifications', '/privacy'];

test('the Admin sidebar is populated', () => {
	assert.ok(appNav.trim(), 's-app-nav is what renders navigation inside Admin');
	assert.ok(hrefs.length >= ROUTES.length, `expected at least ${ROUTES.length} links, found ${hrefs.length}`);
});

test('every sidebar href is an app PATH, never a fragment', () => {
	for (const { href } of hrefs) {
		assert.doesNotMatch(href, /^#/, `s-app-nav does not navigate fragment hrefs — "${href}" would be a dead link in Admin`);
		assert.match(href, /^\//, `"${href}" must be a relative path within the app`);
	}
});

test('exactly one sidebar link is the home route', () => {
	const home = hrefs.filter((link) => /rel="home"/.test(link.rest));
	assert.equal(home.length, 1, 'rel="home" sets the app landing route');
	assert.equal(home[0]?.href, '/');
});

test('every sidebar path resolves to a screen the router serves', () => {
	// A path the router does not know renders "That page doesn't exist" — a link that
	// navigates and lands nowhere, which is only marginally better than one that does
	// not navigate at all.
	for (const { href } of hrefs) {
		const { path } = parseRoute({ pathname: href, search: '', hash: '' });
		assert.ok(ROUTES.includes(path), `no screen for sidebar path "${href}" (parsed as "${path}")`);
	}
});

test('the sidebar covers every routed screen', () => {
	const linked = new Set(hrefs.map(({ href }) => parseRoute({ pathname: href, search: '', hash: '' }).path));
	for (const route of ROUTES) {
		assert.ok(linked.has(route), `${route} has a screen but no way to reach it from Admin's sidebar`);
	}
});
