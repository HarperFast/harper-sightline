import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	applySubscriptionUpdate,
	MAX_EMAIL_LENGTH,
	normalizeCadence,
	normalizeEmail,
	toSubscriptionView,
} from '../src/digest/digestSubscription.ts';

const NOW = 1_775_000_000_000;

test('a plain address is trimmed and lowercased', () => {
	assert.equal(normalizeEmail('  Ops@Merchant.Example '), 'ops@merchant.example');
});

test('addresses that could inject a mail header are rejected', () => {
	// Newlines terminate a header; a rejected address is far better than a
	// sanitized one that silently differs from what the merchant typed.
	assert.equal(normalizeEmail('ops@merchant.example\nBcc: attacker@evil.example'), undefined);
	assert.equal(normalizeEmail('ops@merchant.example\r\nSubject: x'), undefined);
	assert.equal(normalizeEmail('ops@merchant.example\u0000'), undefined);
});

// C1 controls, not just C0. U+009B is the single-byte ANSI escape introducer, so
// this address renders as a colour-changing escape sequence in a raw terminal
// (a support CLI, a future admin tool) while looking ordinary in a mail header.
// The ASCII two-byte `ESC[` form was already rejected by the C0 range; this is
// the same attack spelled with one byte instead of two.
test('an address carrying a C1 control character is rejected, not just C0', () => {
	assert.equal(normalizeEmail('ops@merchant.example\u009b31mRED'), undefined);
	assert.equal(normalizeEmail('ops@merchant.example\u0080'), undefined);
	assert.equal(normalizeEmail('ops@merchant.example\u009f'), undefined);
	// Where the widened range deliberately STOPS. U+00A0 (the next code point up)
	// is NOT rejected, and the reason is worth pinning: it is not a control
	// character, and `.trim()` treats it as whitespace, so an address pasted with
	// a non-breaking space still saves as the clean address the merchant meant.
	// Asserted as ACCEPTED-AND-TRIMMED rather than rejected, so nobody widens the
	// range past \u009f believing this case requires it.
	assert.equal(normalizeEmail('ops@merchant.example\u00a0'), 'ops@merchant.example');
});

test('structurally invalid addresses are rejected', () => {
	for (const bad of ['', '   ', 'nope', 'a@', '@b.example', 'a b@c.example', 'a@b', 'a@@b.example']) {
		assert.equal(normalizeEmail(bad), undefined, `${JSON.stringify(bad)} must be rejected`);
	}
});

test('oversized addresses are rejected', () => {
	assert.equal(normalizeEmail(`${'a'.repeat(MAX_EMAIL_LENGTH)}@b.example`), undefined);
});

test('non-string input is rejected rather than coerced', () => {
	for (const bad of [undefined, null, 42, {}, ['a@b.example']]) {
		assert.equal(normalizeEmail(bad), undefined);
	}
});

test('cadence accepts only the two known values', () => {
	assert.equal(normalizeCadence('daily'), 'daily');
	assert.equal(normalizeCadence('weekly'), 'weekly');
	assert.equal(normalizeCadence('hourly'), undefined);
	assert.equal(normalizeCadence(undefined), undefined);
});

test('an absent subscription views as paused with a daily default', () => {
	assert.deepEqual(toSubscriptionView(undefined), { cadence: 'daily', status: 'paused' });
});

test('a view never exposes anything beyond the four subscription facts', () => {
	const view = toSubscriptionView({
		shopId: 's1',
		email: 'ops@merchant.example',
		cadence: 'weekly',
		status: 'active',
		createdAt: 1,
		updatedAt: 2,
		lastBuiltAt: 3,
	});
	assert.deepEqual(Object.keys(view).sort(), ['cadence', 'email', 'lastBuiltAt', 'status']);
});

test('subscribing sets the address, activates, and stamps the times', () => {
	const row = applySubscriptionUpdate(undefined, 's1', { email: 'Ops@Merchant.example', cadence: 'weekly' }, NOW);
	assert.equal(row.shopId, 's1');
	assert.equal(row.email, 'ops@merchant.example');
	assert.equal(row.cadence, 'weekly');
	assert.equal(row.status, 'active');
	assert.equal(row.createdAt, NOW);
	assert.equal(row.updatedAt, NOW);
});

test('an update preserves createdAt and the last-built marker', () => {
	const existing = {
		shopId: 's1',
		email: 'old@merchant.example',
		cadence: 'daily' as const,
		status: 'active' as const,
		createdAt: 1,
		updatedAt: 1,
		lastBuiltAt: 500,
	};
	const row = applySubscriptionUpdate(existing, 's1', { email: 'new@merchant.example' }, NOW);
	assert.equal(row.email, 'new@merchant.example');
	assert.equal(row.createdAt, 1);
	assert.equal(row.lastBuiltAt, 500);
	assert.equal(row.updatedAt, NOW);
});

test('an invalid address throws rather than silently storing nothing', () => {
	assert.throws(() => applySubscriptionUpdate(undefined, 's1', { email: 'nope' }, NOW), /email/i);
});

test('pausing keeps the address so it can be resumed without retyping', () => {
	const existing = {
		shopId: 's1',
		email: 'ops@merchant.example',
		cadence: 'daily' as const,
		status: 'active' as const,
		createdAt: 1,
		updatedAt: 1,
	};
	const row = applySubscriptionUpdate(existing, 's1', { status: 'paused' }, NOW);
	assert.equal(row.status, 'paused');
	assert.equal(row.email, 'ops@merchant.example');
});

test('an empty address explicitly unsubscribes and clears the stored address', () => {
	const existing = {
		shopId: 's1',
		email: 'ops@merchant.example',
		cadence: 'daily' as const,
		status: 'active' as const,
		createdAt: 1,
		updatedAt: 1,
	};
	const row = applySubscriptionUpdate(existing, 's1', { email: '' }, NOW);
	assert.equal(row.email, undefined);
	assert.equal(row.status, 'paused');
});

test('the shopId always comes from the caller argument, never the body', () => {
	const row = applySubscriptionUpdate(
		undefined,
		's1',
		{ email: 'a@b.example', shopId: 'victim.myshopify.com' } as Record<string, unknown>,
		NOW,
	);
	assert.equal(row.shopId, 's1');
});
