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
} from '../src/digest/digest.ts';

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
		ordersAwaiting: 0,
		failedAttemptsInPeriod: 0,
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
// (src/digest/digestBuild.ts) — already covered above by the '...once per period'
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
	assert.equal(hasSomethingToSay(input({ ordersAwaiting: 1 })), true);
	assert.equal(hasSomethingToSay(input({ failedAttemptsInPeriod: 1 })), true);
	assert.equal(hasSomethingToSay(input({ deliveryGaps: 1 })), true);
	assert.equal(hasSomethingToSay(input({ recorderHealthy: false, deadLettered: 2 })), true);
});

test('the subject leads with the most actionable number and never says failed about an absence', () => {
	assert.match(digestSubject(input({ ordersAwaiting: 3 })), /3 orders? awaiting confirmation/i);
	// ORDERS with a failed attempt, not a count of attempts — one finding per
	// (order, ruleVersion) means two failed attempts on one order are counted once,
	// so the previous "2 fulfillment attempts did not succeed" overstated the measure.
	assert.match(digestSubject(input({ failedAttemptsInPeriod: 2, ordersAwaiting: 3 })), /2 orders? with a failed fulfillment attempt/i);
	// The presence lead must not have quietly become an attempt count again.
	assert.doesNotMatch(digestSubject(input({ failedAttemptsInPeriod: 2 })), /attempts did not succeed|2 fulfillment attempts/i);
	assert.match(digestSubject(input({ recorderHealthy: false, deadLettered: 5 })), /needs attention/i);
	// The ABSENCE lead still carries no failure language at all.
	assert.doesNotMatch(digestSubject(input({ ordersAwaiting: 3 })), /failed/i);
});

// The weekly branch had no coverage at all — every other subject test passes
// cadence: 'daily', so `week of ${day(periodStart)}` was rendered by nothing.
test('a weekly subject names the week, not the day, and marks it UTC', () => {
	const weekStart = Date.parse('2026-07-27T00:00:00Z');
	const subject = digestSubject(
		input({ cadence: 'weekly', periodStart: weekStart, periodEnd: Date.parse('2026-08-03T00:00:00Z'), ordersAwaiting: 3 }),
	);
	assert.match(subject, /\(week of 2026-07-27 UTC\)/);
	assert.doesNotMatch(subject, /\(2026-07-27/);
});

// A subject is read on its own — an inbox list, a mobile notification, a forwarded
// preview — where a bare date reads as the reader's own calendar day. The bodies
// have always tagged their window (UTC); the subject did not, which made the UTC
// claim in this module's header comment false for the one surface most often read
// without the rest of the message.
test('a daily subject marks its window UTC, and separates it from the current-state count', () => {
	const subject = digestSubject(input({ ordersAwaiting: 3 }));
	assert.match(subject, /\(2026-08-04 UTC\)/);
	// "now" belongs to the count, which is current-state; the parenthetical is the
	// window. Without the marker a reader takes the 3 for the window's total.
	assert.match(subject, /3 orders awaiting confirmation now \(/);
});

test('the subject has no CR or LF, so it can never inject a mail header', () => {
	for (const subject of [
		digestSubject(input({ ordersAwaiting: 3 })),
		digestSubject(input({ failedAttemptsInPeriod: 1 })),
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
	const body = digestText(input({ ordersAwaiting: 2, topAwaiting: [{ orderName: '#1001', orderId: '7518851989809', ageHours: 80 }] }));
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
	const body = digestText(input({ ordersAwaiting: 1, topAwaiting: [{ orderName: '#2002', orderId: 'o2', ageHours: 80.5 }] }));
	assert.match(body, /3d 9h/);
	assert.doesNotMatch(body, /\d+\.\d+h/);
});

// Three numbers, two tenses. The awaiting count is current-state (it is the
// Overview's tile and the population the list below it is drawn from); the other
// two are scoped to the closed window named at the top. Each line must say which,
// in BOTH bodies — a reader who takes the awaiting count for a window total is
// reading exactly the wrong thing the old label invited.
test('each rendered number says whether it is current-state or scoped to the window', () => {
	const filled = input({
		ordersAwaiting: 4,
		failedAttemptsInPeriod: 2,
		deliveryGaps: 1,
		topAwaiting: [{ orderName: '#1001', orderId: 'o1', ageHours: 80 }],
	});
	for (const body of [digestText(filled), digestHtml(filled)]) {
		assert.match(body, /Orders awaiting fulfillment confirmation, as of now: 4/);
		// "Orders with a fulfillment attempt …", not "Fulfillment attempts …": the
		// number is one finding per order, so an attempts label overstated it.
		assert.match(body, /Orders with a fulfillment attempt Shopify recorded as unsuccessful, in this window: 2/);
		assert.match(body, /Changes found by direct check rather than webhook, in this window: 1/);
		// Both order counts must stay distinguishable — an absence and a presence about
		// the same kind of thing, which is exactly why each names its own condition.
		assert.doesNotMatch(body, /^Fulfillment attempts/m);
		// The list is the same current-state population as the first number, so its
		// heading must not read as window-scoped either.
		assert.match(body, /Longest waiting, as of now/);
	}
	// And the relabelled lines blame nobody. Checked against the reported numbers
	// only, not the whole body: the boundary paragraph says the words "warehouse or
	// carrier failed" on purpose, inside the sentence that DENIES the inference, and
	// it is asserted separately below.
	const text = digestText(filled);
	const reported = text.slice(0, text.indexOf('These are observations'));
	assert.ok(reported.includes('as of now: 4'), 'the slice must actually contain the reported numbers');
	assert.doesNotMatch(reported, /warehouse|carrier|3pl|vendor|supplier/i);
	assert.match(text, /does not prove that a warehouse or carrier failed/i);
});

test('the body never contains customer data', () => {
	const body = digestText(input({ ordersAwaiting: 1, topAwaiting: [{ orderName: '#1001', orderId: 'o1', ageHours: 10 }] }));
	for (const forbidden of ['@gmail', 'customer', 'phone', 'address', 'shipping_address']) {
		assert.equal(body.toLowerCase().includes(forbidden), false, `digest must not contain ${forbidden}`);
	}
});

test('the html body escapes hostile order names', () => {
	const html = digestHtml(
		input({ ordersAwaiting: 1, topAwaiting: [{ orderName: '<script>alert(1)</script>', orderId: 'o1', ageHours: 5 }] }),
	);
	assert.doesNotMatch(html, /<script>alert/);
	assert.match(html, /&lt;script&gt;/);
});

// The row renders no body: subject and counts are the whole row, a 30-day record of
// the period, never the message. Absence of the columns is the correct shape.
test('an outbox row is keyed by shop and period so a rebuild upserts', () => {
	const row = outboxRow(
		input({
			ordersAwaiting: 2,
			failedAttemptsInPeriod: 1,
			deliveryGaps: 3,
			topAwaiting: [{ orderName: '#1001', orderId: 'o1', ageHours: 30 }],
		}),
		NOW,
	);
	assert.equal(row.id, `s1.myshopify.com:${Date.parse('2026-08-04T00:00:00Z')}`);
	assert.equal(row.status, 'pending');
	assert.equal(row.ordersAwaiting, 2);
	assert.equal(row.failedAttemptsInPeriod, 1);
	assert.equal(row.deliveryGaps, 3);
	assert.equal(row.createdAt, NOW);
	assert.ok((row.subject ?? '').length > 0);
	assert.equal(Object.hasOwn(row, 'bodyText'), false);
	assert.equal(Object.hasOwn(row, 'bodyHtml'), false);
	// Guard the serialized row directly so a body sneaking back in by any route is caught.
	assert.doesNotMatch(JSON.stringify(row), /#1001/);
});

// The row must carry no address: uninstallShop deletes only DigestSubscriptions, so
// a copy on outbox rows would survive the "deleted when you clear it or uninstall"
// promise. Asserts no key, not an empty value.
test('an outbox row carries no address anywhere in it, so clearing or uninstalling really does erase it', () => {
	const row = outboxRow(input({ ordersAwaiting: 2, topAwaiting: [{ orderName: '#1001', orderId: 'o1', ageHours: 30 }] }), NOW);
	assert.equal(Object.hasOwn(row, 'email'), false);
	// Nothing address-shaped anywhere in the row, including the rendered bodies and
	// the subject — an `@`-bearing order name is the realistic way one could return
	// by the back door.
	assert.doesNotMatch(JSON.stringify(row), /[^\s"@]+@[^\s"@]+\.[^\s"@]+/);
});

// Restates the id's determinism for the build loop's benefit (src/digest/digestBuild.ts):
// this is what makes an overlapping tick/thread/node upsert rather than duplicate.
// Already implied by the previous test's `row.id` assertion.
test('an outbox id is stable for a period, so a rebuild overwrites rather than duplicating', () => {
	const first = outboxRow(input({ ordersAwaiting: 1 }), NOW);
	const second = outboxRow(input({ ordersAwaiting: 5 }), NOW + 1000);
	assert.equal(first.id, second.id);
	assert.notEqual(first.ordersAwaiting, second.ordersAwaiting);
});
