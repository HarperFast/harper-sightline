import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	digestHtml,
	digestSubject,
	digestText,
	hasSomethingToSay,
	headerSafe,
	outboxRow,
	periodEndFor,
	periodStartFor,
	shouldBuild,
	type DigestInput,
} from '../src/digest.ts';

const DAY = 86_400_000;
// Wednesday 2026-08-05T14:30:00Z — deliberately mid-day and mid-week so period
// flooring is actually exercised.
const NOW = Date.parse('2026-08-05T14:30:00Z');

function input(over: Partial<DigestInput> = {}): DigestInput {
	return {
		shopId: 's1.myshopify.com',
		cadence: 'daily',
		periodStart: Date.parse('2026-08-04T00:00:00Z'),
		periodEnd: Date.parse('2026-08-05T00:00:00Z'),
		unconfirmed: 0,
		failedAttempts: 0,
		deliveryGaps: 0,
		recorderHealthy: true,
		deadLettered: 0,
		topAwaiting: [],
		...over,
	};
}

test('the daily period is the last COMPLETE UTC day', () => {
	const start = periodStartFor('daily', NOW);
	assert.equal(new Date(start).toISOString(), '2026-08-04T00:00:00.000Z');
	assert.equal(new Date(periodEndFor('daily', start)).toISOString(), '2026-08-05T00:00:00.000Z');
});

test('the weekly period is the last complete Monday-to-Monday week', () => {
	const start = periodStartFor('weekly', NOW);
	// The Monday before the Monday of the current week.
	assert.equal(new Date(start).toISOString(), '2026-07-27T00:00:00.000Z');
	assert.equal(new Date(periodEndFor('weekly', start)).toISOString(), '2026-08-03T00:00:00.000Z');
});

test('a period never includes the present, so a digest never reports a partial window', () => {
	assert.ok(periodEndFor('daily', periodStartFor('daily', NOW)) <= NOW);
	assert.ok(periodEndFor('weekly', periodStartFor('weekly', NOW)) <= NOW);
});

test('build only for an active subscription with an address, once per period', () => {
	const periodStart = periodStartFor('daily', NOW);
	assert.equal(shouldBuild({ status: 'active', email: 'a@b.example' }, periodStart), true);
	assert.equal(shouldBuild({ status: 'active', email: 'a@b.example', lastBuiltAt: periodStart }, periodStart), false);
	assert.equal(shouldBuild({ status: 'active', email: 'a@b.example', lastBuiltAt: periodStart - DAY }, periodStart), true);
	assert.equal(shouldBuild({ status: 'paused', email: 'a@b.example' }, periodStart), false);
	assert.equal(shouldBuild({ status: 'active' }, periodStart), false);
	assert.equal(shouldBuild({}, periodStart), false);
});

// Restates shouldBuild across a period boundary for the build loop's benefit
// (src/digestBuild.ts) — already covered above by the '...once per period'
// test, so this pins the behavior explicitly rather than adding new coverage.
test('a period that has already been built is not rebuilt, whatever the clock says', () => {
	const periodStart = periodStartFor('daily', NOW);
	const subscription = { status: 'active', email: 'a@b.example', lastBuiltAt: periodStart };
	assert.equal(shouldBuild(subscription, periodStart), false);
	assert.equal(shouldBuild(subscription, periodStartFor('daily', NOW + DAY)), true);
});

test('a quiet, healthy period has nothing to say', () => {
	assert.equal(hasSomethingToSay(input()), false);
});

test('anything worth acting on means there is something to say', () => {
	assert.equal(hasSomethingToSay(input({ unconfirmed: 1 })), true);
	assert.equal(hasSomethingToSay(input({ failedAttempts: 1 })), true);
	assert.equal(hasSomethingToSay(input({ deliveryGaps: 1 })), true);
	assert.equal(hasSomethingToSay(input({ recorderHealthy: false, deadLettered: 2 })), true);
});

test('the subject leads with the most actionable number and never says failed about an absence', () => {
	assert.match(digestSubject(input({ unconfirmed: 3 })), /3 orders? awaiting confirmation/i);
	assert.match(digestSubject(input({ failedAttempts: 2, unconfirmed: 3 })), /2 fulfillment attempts? did not succeed/i);
	assert.match(digestSubject(input({ recorderHealthy: false, deadLettered: 5 })), /needs attention/i);
	assert.doesNotMatch(digestSubject(input({ unconfirmed: 3 })), /failed/i);
});

test('the subject has no CR or LF, so it can never inject a mail header', () => {
	for (const subject of [
		digestSubject(input({ unconfirmed: 3 })),
		digestSubject(input({ failedAttempts: 1 })),
		digestSubject(input({ recorderHealthy: false, deadLettered: 1 })),
	]) {
		assert.doesNotMatch(subject, /[\r\n]/);
	}
});

// digestSubject is built from a cadence enum, two integers, and an ISO date, so
// nothing attacker-controlled reaches it today. headerSafe is the reason that
// stays true as the copy changes — test it directly against a genuinely hostile
// string rather than only against the real subjects above, which can never
// exercise the sanitizer's replace branch.
test('headerSafe collapses a hostile CRLF payload onto one line rather than dropping it', () => {
	const hostile = '3 orders\r\nBcc: attacker@evil.example';
	const safe = headerSafe(hostile);
	assert.doesNotMatch(safe, /[\r\n]/);
	assert.equal(safe, '3 orders Bcc: attacker@evil.example');
});

test('the text body states the window, the counts, and the claim boundary', () => {
	const body = digestText(input({ unconfirmed: 2, topAwaiting: [{ orderName: '#1001', orderId: '7518851989809', ageHours: 80 }] }));
	assert.match(body, /2026-08-04/);
	assert.match(body, /#1001/);
	assert.match(body, /3d 8h/);
	// The load-bearing boundary must travel with the message.
	assert.match(body, /does not prove that a warehouse or carrier failed/i);
});

// age(80.5) must round to a single whole-hour figure before splitting into days
// and hours, rather than leaking a fractional hour (`3d 8.5h`) into the render.
// Math.round(80.5) = 81 (JS rounds .5 away from zero), so 81 hours = 3d 9h.
test('a fractional age hour is rounded before rendering, never leaked as a decimal', () => {
	const body = digestText(input({ unconfirmed: 1, topAwaiting: [{ orderName: '#2002', orderId: 'o2', ageHours: 80.5 }] }));
	assert.match(body, /3d 9h/);
	assert.doesNotMatch(body, /\d+\.\d+h/);
});

test('the body never contains customer data', () => {
	const body = digestText(input({ unconfirmed: 1, topAwaiting: [{ orderName: '#1001', orderId: 'o1', ageHours: 10 }] }));
	for (const forbidden of ['@gmail', 'customer', 'phone', 'address', 'shipping_address']) {
		assert.equal(body.toLowerCase().includes(forbidden), false, `digest must not contain ${forbidden}`);
	}
});

test('the html body escapes hostile order names', () => {
	const html = digestHtml(input({ unconfirmed: 1, topAwaiting: [{ orderName: '<script>alert(1)</script>', orderId: 'o1', ageHours: 5 }] }));
	assert.doesNotMatch(html, /<script>alert/);
	assert.match(html, /&lt;script&gt;/);
});

test('an outbox row is keyed by shop and period so a rebuild upserts', () => {
	const row = outboxRow(input({ unconfirmed: 2, failedAttempts: 1, deliveryGaps: 3 }), NOW);
	assert.equal(row.id, `s1.myshopify.com:${Date.parse('2026-08-04T00:00:00Z')}`);
	assert.equal(row.status, 'pending');
	assert.equal(row.unconfirmed, 2);
	assert.equal(row.failedAttempts, 1);
	assert.equal(row.deliveryGaps, 3);
	assert.equal(row.createdAt, NOW);
	assert.ok((row.bodyText ?? '').length > 0);
	assert.ok((row.bodyHtml ?? '').length > 0);
});

// The row previously carried an `email` column, and this test previously asserted
// its value. That copy is what made the privacy policy's and the Notifications
// screen's "deleted as soon as you clear it or uninstall" untrue: uninstallShop
// deletes only DigestSubscriptions, so every outbox row's copy survived until the
// 30-day purge. The assertion is now the opposite one — no key, not merely an
// empty value — because a row shape is the only thing that can guarantee it.
test('an outbox row carries no address anywhere in it, so clearing or uninstalling really does erase it', () => {
	const row = outboxRow(input({ unconfirmed: 2, topAwaiting: [{ orderName: '#1001', orderId: 'o1', ageHours: 30 }] }), NOW);
	assert.equal(Object.hasOwn(row, 'email'), false);
	// Nothing address-shaped anywhere in the row, including the rendered bodies and
	// the subject — an `@`-bearing order name is the realistic way one could return
	// by the back door.
	assert.doesNotMatch(JSON.stringify(row), /[^\s"@]+@[^\s"@]+\.[^\s"@]+/);
});

// Restates the id's determinism for the build loop's benefit (src/digestBuild.ts):
// this is what makes an overlapping tick/thread/node upsert rather than duplicate.
// Already implied by the previous test's `row.id` assertion.
test('an outbox id is stable for a period, so a rebuild overwrites rather than duplicating', () => {
	const first = outboxRow(input({ unconfirmed: 1 }), NOW);
	const second = outboxRow(input({ unconfirmed: 5 }), NOW + 1000);
	assert.equal(first.id, second.id);
	assert.notEqual(first.unconfirmed, second.unconfirmed);
});
