import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privacyPolicyHtml, POLICY_ENTITY } from '../src/privacyPolicy.ts';
import { supportContact, supportConfigured } from '../src/support.ts';
import { WINDOW_DAYS } from '../src/apiContract.ts';
import { EXCLUDED_CUSTOMER_FIELDS } from '../src/queries.ts';

// The privacy policy is a PUBLIC, legally-consequential document that must not
// drift from what the code actually does. These tests pin the claims that would
// become false if behavior changed, and the two failure modes that matter most:
// fabricating a support contact, and claiming to store less than we do.

test('support contact has no default — an unset deployment is unconfigured, not fake', () => {
	assert.deepEqual(supportContact({}), {});
	assert.equal(supportConfigured(supportContact({})), false);
	// Blank/whitespace env vars must not count as configured.
	assert.deepEqual(supportContact({ SIGHTLINE_SUPPORT_EMAIL: '', SIGHTLINE_SUPPORT_URL: '   ' }), {});
	assert.equal(supportConfigured(supportContact({ SIGHTLINE_SUPPORT_EMAIL: '  ' })), false);
});

test('support contact reads either channel and trims', () => {
	assert.deepEqual(supportContact({ SIGHTLINE_SUPPORT_EMAIL: ' help@example.com ' }), { email: 'help@example.com' });
	assert.deepEqual(supportContact({ SIGHTLINE_SUPPORT_URL: 'https://example.com/help' }), { url: 'https://example.com/help' });
	assert.equal(supportConfigured({ url: 'https://example.com/help' }), true);
	assert.equal(supportConfigured({ email: 'help@example.com' }), true);
});

test('the policy never fabricates a support contact', () => {
	const html = privacyPolicyHtml({});
	assert.ok(html.includes('Support contact is not configured'), 'says so plainly instead of inventing an address');
	assert.ok(!html.includes('mailto:'), 'and offers no broken mailto');
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

test('the policy discloses what IS stored, including the less obvious items', () => {
	const html = privacyPolicyHtml({});
	// Under-disclosure is the dangerous direction: each of these is really stored.
	for (const claim of [
		/SKUs and quantities/i,
		/inventory levels/i,
		/encrypted Shopify access token/i,
		/shop domain/i,
		/access scopes/i,
		/timezone/i,
	]) {
		assert.match(html, claim);
	}
});

test('the policy states the no-PII headline and the operating entity', () => {
	const html = privacyPolicyHtml({});
	assert.match(html, /does not collect or store your customers' personal information/i);
	assert.ok(html.includes(POLICY_ENTITY));
	assert.match(html, /United States/, 'processing location is disclosed');
	assert.match(html, /read_orders/, 'the granted scopes are named');
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
