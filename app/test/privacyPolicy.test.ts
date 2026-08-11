import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privacyPolicyHtml, POLICY_ENTITY } from '../src/privacy/privacyPolicy.ts';
import { readFileSync } from 'node:fs';
import { supportContact, supportConfigured, DEFAULT_SUPPORT_EMAIL } from '../src/privacy/support.ts';
import { WINDOW_DAYS } from '../src/api/apiContract.ts';
import { EXCLUDED_CUSTOMER_FIELDS } from '../src/api/queries.ts';

// The privacy policy is a PUBLIC, legally-consequential document that must not
// drift from what the code actually does. These tests pin the claims that would
// become false if behavior changed, and the two failure modes that matter most:
// fabricating a support contact, and claiming to store less than we do.

// The granted scopes, read from the actual config Shopify enforces at install —
// NOT retyped here — so this test fails loudly the next time `shopify.app.toml`'s
// scope list changes in either direction (a scope added there but left off the
// policy, as happened with read_products/read_locations; or a scope removed
// there but left dangling in the policy text).
const APP_TOML = readFileSync(new URL('../../shopify.app.toml', import.meta.url), 'utf8');
const GRANTED_SCOPES = APP_TOML.match(/^\s*scopes\s*=\s*"([^"]+)"/m)![1]
	.split(',')
	.map((s) => s.trim());

test('a deployment that configures nothing still has a reachable support contact', () => {
	// The contact is product metadata, identical everywhere, so it ships in code —
	// a production deploy cannot forget it and leave merchants with no recourse.
	assert.deepEqual(supportContact({}), { email: DEFAULT_SUPPORT_EMAIL });
	assert.equal(supportConfigured(supportContact({})), true);
	// A blank override is an accident, not an instruction to unset.
	assert.deepEqual(supportContact({ SIGHTLINE_SUPPORT_EMAIL: '   ' }), { email: DEFAULT_SUPPORT_EMAIL });
});

test('support contact honours an override and trims', () => {
	assert.deepEqual(supportContact({ SIGHTLINE_SUPPORT_EMAIL: ' help@example.com ' }), { email: 'help@example.com' });
	assert.deepEqual(supportContact({ SIGHTLINE_SUPPORT_URL: 'https://example.com/help' }), {
		email: DEFAULT_SUPPORT_EMAIL,
		url: 'https://example.com/help',
	});
	assert.equal(supportConfigured({ url: 'https://example.com/help' }), true);
	assert.equal(supportConfigured({}), false, 'an empty contact is still recognised as unconfigured');
});

test('the policy never fabricates a support contact when none can be resolved', () => {
	// Reachable only by passing an empty contact explicitly — the defensive path
	// for a caller that could not resolve one. It must not invent an address.
	const html = privacyPolicyHtml({});
	assert.ok(html.includes('Support contact is not configured'), 'says so plainly instead of inventing an address');
	assert.ok(!html.includes('mailto:'), 'and offers no broken mailto');
});

test('the policy publishes the default contact end to end', () => {
	const html = privacyPolicyHtml(supportContact({}));
	assert.ok(html.includes(`mailto:${DEFAULT_SUPPORT_EMAIL}`));
	assert.ok(!html.includes('not configured'));
});

test('the policy publishes the configured contact', () => {
	const html = privacyPolicyHtml({ email: 'help@example.com', url: 'https://example.com/help' });
	assert.ok(html.includes('mailto:help@example.com'));
	assert.ok(html.includes('https://example.com/help'));
	assert.ok(!html.includes('not configured'));
});

test('the retention claim tracks the code, not a hardcoded number', () => {
	const html = privacyPolicyHtml({});
	assert.ok(html.includes(`after ${WINDOW_DAYS} days`), 'the stated window comes from WINDOW_DAYS');
	assert.ok(/permanently deleted/i.test(html));
	// ADR-003: this is real deletion, and the policy must not imply mere expiry.
	assert.ok(/deletion, not expiry or cache eviction/i.test(html));
});

test('the policy lists exactly the customer fields the code excludes', () => {
	const html = privacyPolicyHtml({});
	for (const field of EXCLUDED_CUSTOMER_FIELDS) {
		// Compare against the RENDERED form: "shipping & billing address" reaches the
		// page as "shipping &amp; billing address", which is correct output — the
		// escaping is the point, so the assertion has to account for it rather than
		// the policy dropping the escape to satisfy a naive test.
		const rendered = field.replace(/&/g, '&amp;');
		assert.ok(html.includes(rendered), `the exclusion list must name "${field}" — it comes from the same constant the app renders`);
	}
});

test('the policy discloses exactly what IS stored, and no more', () => {
	const html = privacyPolicyHtml({});
	// A substring spot-check would still pass if an item were quietly dropped, or
	// if a stored fact were never added at all — the exact failure mode that
	// under-disclosed order value/currency and product/variant titles before this
	// fix. Extracting and deep-equaling the actual "What we store" list closes
	// that gap: it can only pass if the rendered list matches, item for item.
	const section = html.match(/<h2>What we store<\/h2>\s*<ul>([\s\S]*?)<\/ul>/);
	assert.ok(section, 'the "What we store" section must exist');
	const items = [...section[1].matchAll(/<li>(.*?)<\/li>/g)].map((m) => m[1]);
	assert.deepEqual(items, [
		'Order status and timestamps (paid, cancelled, closed), and order identifiers',
		'Order value and currency',
		'Fulfillment status, the location it shipped from, whether tracking information is present, and which carrier',
		'Inventory levels by inventory item and location',
		'Refund status',
		'SKUs, product and variant titles, and quantities',
		'Your shop domain, the access scopes you granted, and install/uninstall timestamps',
		"Your store's configured timezone, so timestamps display in your local time",
		'An encrypted Shopify access token, used only to read the order data described above',
	]);
});

test('the policy names exactly the scopes shopify.app.toml actually grants — no more, no fewer', () => {
	// A substring/single-scope check (e.g. just `read_orders`) would still pass if
	// a scope were added to shopify.app.toml and never added here — precisely the
	// gap that let read_products/read_locations go undisclosed. Extracting every
	// `<code>read_*</code>` token from the "Shopify's role" section and
	// deep-equaling it against the actual config closes that gap in both
	// directions: it fails if a granted scope is missing from the policy, and it
	// fails if the policy names a scope that was removed from the config.
	assert.ok(GRANTED_SCOPES.length > 0, 'sanity: the scopes regex actually matched shopify.app.toml');
	const html = privacyPolicyHtml({});
	const section = html.match(/<h2>Shopify's role<\/h2>\s*<p>([\s\S]*?)<\/p>/);
	assert.ok(section, 'the "Shopify\'s role" section must exist');
	const namedScopes = [...section[1].matchAll(/<code>(read_[a-z_]+)<\/code>/g)].map((m) => m[1]);
	assert.deepEqual(new Set(namedScopes), new Set(GRANTED_SCOPES));
});

test('the policy states the no-PII headline and the operating entity', () => {
	const html = privacyPolicyHtml({});
	assert.match(html, /does not collect or store your customers' personal information/i);
	assert.ok(html.includes(POLICY_ENTITY));
	assert.match(html, /United States/, 'processing location is disclosed');
	assert.match(html, /no write access/i);
});

test('the policy makes no claim of tracking, profiling, or selling data', () => {
	const html = privacyPolicyHtml({});
	assert.match(html, /do not use cookies or tracking pixels/i);
	assert.match(html, /do not sell or rent data/i);
});

test('a hostile support value cannot inject markup into a public page', () => {
	const html = privacyPolicyHtml({ email: '"><script>alert(1)</script>', url: '"><img src=x onerror=alert(1)>' });
	assert.ok(!html.includes('<script>alert(1)</script>'), 'script tag must be escaped');
	assert.ok(!html.includes('<img src=x'), 'img tag must be escaped');
	assert.ok(html.includes('&lt;script&gt;'));
});

test('the public policy discloses the notification address, its purpose, and its own deletion claim', () => {
	const html = privacyPolicyHtml({ email: 'support@harperdb.io' }, '2026-08-07');
	// Pinned to the notification-email section itself, not "appears anywhere on
	// the page": /uninstall/i already matches twice today (install/uninstall
	// timestamps in "What we store"; the Uninstall bullet under "Deletion and
	// your rights"), so a bare page-wide match would pass even if this new
	// section shipped with no deletion promise of its own.
	const section = html.match(/<h2>Notification email<\/h2>\s*<p>([\s\S]*?)<\/p>/);
	assert.ok(section, 'the "Notification email" section must exist');
	const paragraph = section[1];
	assert.match(paragraph, /notification email/i);
	assert.match(paragraph, /not customer data/i);
	// The deletion claim must live IN this paragraph — removing it here (leaving
	// it only in the page's other, pre-existing uninstall bullets) must fail.
	assert.match(paragraph, /deleted|removed|purged/i);
	assert.match(paragraph, /clear|uninstall/i);
});

test('the notification-email retention figure matches the digest outbox retention stated elsewhere on the page', () => {
	const html = privacyPolicyHtml({});
	const section = html.match(/<h2>Notification email<\/h2>\s*<p>([\s\S]*?)<\/p>/);
	assert.ok(section, 'the "Notification email" section must exist');
	// "30 days" is Notifications screen wording (web/src/view.ts's "stores it for
	// 30 days, then removes it") — the policy must agree with it in substance and
	// in number, not just gesture at "a while". privacyPolicy.ts renders both
	// mentions from the same imported OUTBOX_RETENTION_DAYS (src/retention/retention.ts), so
	// there is one real number behind both, not two literals that could drift
	// apart independently.
	assert.match(section[1], /30 days/);
	assert.match(html, /30 days/, 'the "How long we keep it" section states the same figure');
});

test('the policy is a standalone document, not the embedded app shell', () => {
	const html = privacyPolicyHtml({ email: 'help@example.com' });
	assert.ok(html.startsWith('<!doctype html>'));
	assert.ok(html.includes('<title>Privacy Policy'));
	// A reviewer opens this in a normal tab — it must not depend on App Bridge or
	// carry the app's frame-ancestors assumptions.
	assert.ok(!html.includes('app-bridge'), 'no App Bridge dependency');
	assert.ok(!html.includes('shopify-api-key'), 'no api key meta');
	assert.ok(!html.includes('__SIGHTLINE_SESSION__'), 'no session injection');
});
