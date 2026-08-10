import type { DigestCadence, DigestOutbox } from './model.ts';

// The digest's pure domain: when a period is, whether to build, and what the
// message says. No table access and no clock of its own — every function takes
// the time it needs — so the whole thing is testable in plain node.
//
// There is deliberately NO SENDER. This renders and returns a message; the job
// persists it to the outbox with status 'pending'. Delivery is a separate
// decision with its own compliance surface (unsubscribe handling, bounce
// handling, a provider relationship) and none of it is in scope here.

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

// Periods are UTC and always CLOSED: the window a digest describes is the last
// complete day or week, never a partial one in progress. A merchant reading a
// window-scoped number for a window still open would have no way to know it will
// move.
//
// Two figures in the message are deliberately CURRENT-STATE rather than
// window-scoped, and both say so where they are rendered: the count of orders
// awaiting fulfillment confirmation, and the longest-waiting list. They answer
// "what is outstanding right now", which is what a merchant reading the message
// can act on, and they are the same population the Overview's awaiting tile shows
// (`isAwaitingConfirmation`, src/orders.ts) — a digest that named a different set
// of orders than the app would be worse than one that mixes tenses. So the rule
// is not "a digest never reports the present": it is that every number states
// which of the two it is, and the closed window is what the WINDOW-scoped numbers
// are scoped to.
//
// UTC rather than the store's timezone is a deliberate simplification: it keeps
// the boundary arithmetic trivial and identical across cluster nodes, and every
// message names its window explicitly AND marks it UTC — including the subject,
// which is often the only part read (inbox list, mobile notification, forward
// preview) — so nothing is ambiguous even when the store's day differs.
export function periodStartFor(cadence: DigestCadence, now: number): number {
	const midnight = Math.floor(now / DAY_MS) * DAY_MS;
	if (cadence === 'weekly') {
		// getUTCDay: 0 = Sunday. Shift so Monday = 0, then step back a full week.
		const dayOfWeek = (new Date(midnight).getUTCDay() + 6) % 7;
		return midnight - dayOfWeek * DAY_MS - WEEK_MS;
	}
	return midnight - DAY_MS;
}

export function periodEndFor(cadence: DigestCadence, periodStart: number): number {
	return periodStart + (cadence === 'weekly' ? WEEK_MS : DAY_MS);
}

// Build when the subscription is usable and this period has not been built yet.
// Keying on the period (not on elapsed time) makes the loop idempotent: several
// ticks, several worker threads, or several cluster nodes all converge on one row.
export function shouldBuild(subscription: { status?: string; email?: string; lastBuiltAt?: number }, periodStart: number): boolean {
	if (subscription.status !== 'active') return false;
	if (!subscription.email) return false;
	return (subscription.lastBuiltAt ?? 0) < periodStart;
}

export interface DigestOrderRef {
	orderName?: string;
	orderId: string;
	ageHours: number;
}

// Field names carry the tense, because these numbers do not share one. `outboxRow`
// copies them onto the row unchanged — the interface and the DigestOutbox column
// have the SAME name on purpose, so there is no translation step in the middle for
// someone to reconnect wrongly later.
export interface DigestInput {
	shopId: string;
	cadence: DigestCadence;
	periodStart: number;
	periodEnd: number;
	// CURRENT-STATE, and a count of ORDERS awaiting fulfillment confirmation
	// (isAwaitingConfirmation, src/orders.ts) — every entry of which is in
	// `topAwaiting` before it is capped. Not `unconfirmed`: that name means a
	// GapFinding status elsewhere in this codebase, and one order can carry two
	// findings, so the two are different populations in different tenses.
	ordersAwaiting: number;
	// Scoped to [periodStart, periodEnd) — named for it, because getSummary's
	// `findings.failedAttempts` is the same population with no time bound. Counts
	// ORDERS with a failed-attempt finding, not attempts: one finding per
	// (order, ruleVersion), so two failed attempts on one order are one.
	failedAttemptsInPeriod: number;
	deliveryGaps: number;
	recorderHealthy: boolean;
	deadLettered: number;
	// Current-state, like `ordersAwaiting`, and drawn from the same iteration.
	topAwaiting: DigestOrderRef[];
}

// A digest with nothing to report is not sent. A recurring "all clear" email
// trains people to ignore the channel, and the app itself is always available for
// a health check.
//
// `ordersAwaiting` is a current-state count of orders awaiting confirmation, not
// a count of findings detected in the window, and that changes WHEN digests
// appear: an order that stays awaiting for a fortnight makes every daily digest in
// that fortnight non-empty. That is the right behavior — an order still waiting is
// an open, actionable item, and the message leads with how long the oldest ones
// have waited, so each digest carries new information (a growing age) rather than
// repeating an all-clear. The failure mode this function guards against is the
// digest that says "nothing is wrong"; it was never "do not mention an unresolved
// problem twice".
export function hasSomethingToSay(input: DigestInput): boolean {
	return input.ordersAwaiting > 0 || input.failedAttemptsInPeriod > 0 || input.deliveryGaps > 0 || !input.recorderHealthy;
}

function day(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

function plural(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

function label(order: DigestOrderRef): string {
	return order.orderName ?? order.orderId;
}

// Rounds to the nearest whole hour before splitting into days/hours, so both
// parts are derived from the SAME integer. `DigestOrderRef.ageHours` is typed as
// a plain `number`, not constrained to integers, so this makes `age()` total for
// any numeric input rather than relying on every caller to pre-round. (Today's
// only caller, `ageHours()` in src/orders.ts, already floors to an integer, so
// this is defensive rather than a fix for a live fractional source — but a
// function that renders `3d 8.5h` for a legal input is still a latent defect.)
function age(hours: number): string {
	const whole = Math.round(hours);
	return whole < 24 ? `${whole}h` : `${Math.floor(whole / 24)}d ${whole % 24}h`;
}

// Escaping for the HTML body. Same rules as the SPA's `esc`, duplicated here
// rather than imported because src/ must not depend on web/.
function esc(value: unknown): string {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

// A subject line eventually becomes a mail header value, where a raw newline is a
// header-injection vector. Nothing that reaches digestSubject today is attacker-
// controlled, but the sanitizer is the reason that stays true as the copy changes.
export function headerSafe(value: string): string {
	return value.replace(/[\r\n]+/g, ' ').trim();
}

// The subject leads with the most actionable fact. A failed attempt outranks an
// absence (it is direct evidence), and a broken recorder outranks both, because
// while the recorder is unhealthy the other numbers may be incomplete. The ladder
// is unchanged by the awaiting recount: it orders by kind of evidence, not by
// which tense a number is in, and `hasSomethingToSay` still fires on exactly the
// complement of the "Nothing to report" branch.
//
// The parenthetical names the digest's WINDOW, marked UTC because a subject line
// is read on its own — in an inbox list, a notification, a forwarded preview —
// where a bare date would read as the reader's own calendar day. The awaiting lead
// says "now" for the same reason: it is the one lead whose number is current-state
// rather than scoped to that window, and the subject is exactly where the two
// would otherwise be conflated.
export function digestSubject(input: DigestInput): string {
	const window = input.cadence === 'weekly' ? `week of ${day(input.periodStart)} UTC` : `${day(input.periodStart)} UTC`;
	let lead: string;
	if (!input.recorderHealthy) lead = 'Sightline needs attention';
	else if (input.failedAttemptsInPeriod > 0)
		// ORDERS, not attempts — the count is one finding per order, and DETECTOR_FAILED
		// writes one finding per (order, ruleVersion), so two failed attempts on one
		// order are counted once. "N fulfillment attempts did not succeed" overstated
		// that. Wording matches the Overview's tile for the same number, so the two
		// surfaces read as one claim. Still a presence, still attributes nothing to a
		// warehouse or carrier: Shopify's own record is what says the attempt failed.
		lead = `${plural(input.failedAttemptsInPeriod, 'order', 'orders')} with a failed fulfillment attempt`;
	else if (input.ordersAwaiting > 0) lead = `${plural(input.ordersAwaiting, 'order', 'orders')} awaiting confirmation now`;
	else if (input.deliveryGaps > 0) lead = `${plural(input.deliveryGaps, 'change', 'changes')} found by direct check`;
	else lead = 'Nothing to report';
	return headerSafe(`Sightline: ${lead} (${window})`);
}

// The product-truth boundary travels WITH the message. A digest is read outside
// the app, often forwarded, so it cannot rely on a screen to carry the caveat.
const BOUNDARY =
	'These are observations of your Shopify data. An order with no observed confirmation does not prove that a warehouse or carrier failed — it means Shopify has not shown the expected fulfillment confirmation yet.';

// Intentionally uncalled outside its own tests. `outboxRow` (below) stores only
// `subject` and the count columns — never a rendered body: the ledger
// purges at seven days, so a stored digest outliving that window is worth
// keeping, but a stored MESSAGE naming orders for 30 days is not. This
// function's caller is the sender that does not exist yet; when one ships, it
// renders the body fresh from a `DigestInput` rather than reading one back from
// a row. Its tests in test/digest.test.ts are what keep this copy — the
// boundary paragraph, the presence/absence split, the escaping — from rotting
// while it waits for that caller. Do not delete it as dead code.
export function digestText(input: DigestInput): string {
	const lines: string[] = [];
	lines.push(`Sightline digest for ${input.shopId}`);
	lines.push(`Window: ${day(input.periodStart)} to ${day(input.periodEnd)} (UTC)`);
	lines.push('');
	if (!input.recorderHealthy) {
		lines.push(
			`RECORDER NEEDS ATTENTION: ${plural(input.deadLettered, 'delivery', 'deliveries')} could not be processed, so the numbers below may be incomplete.`,
		);
		lines.push('');
	}
	// Each line states its own tense. The first is current-state and matches the
	// Overview's awaiting tile and the list below it; the other two are scoped to
	// the window named above. Without the labels a reader would take all three for
	// the same period, which is how a findings count came to be read as an orders
	// count in the first place.
	//
	// Both of the first two lines count ORDERS, and say so. They are still different
	// claims: the first is an absence (no confirmation observed yet) and current-state,
	// the second a presence (Shopify recorded an attempt that did not succeed) scoped
	// to the window. An order can legitimately be in both.
	lines.push(`Orders awaiting fulfillment confirmation, as of now: ${input.ordersAwaiting}`);
	lines.push(`Orders with a fulfillment attempt Shopify recorded as unsuccessful, in this window: ${input.failedAttemptsInPeriod}`);
	lines.push(`Changes found by direct check rather than webhook, in this window: ${input.deliveryGaps}`);
	if (input.topAwaiting.length > 0) {
		lines.push('');
		// "as of now" again, because this list is the same current-state population
		// as the first line — not the window's — and a heading under a
		// window-stamped message would otherwise be read as window-scoped.
		lines.push('Longest waiting, as of now:');
		for (const order of input.topAwaiting) lines.push(`  ${label(order)} — waiting ${age(order.ageHours)}`);
	}
	lines.push('');
	lines.push(BOUNDARY);
	lines.push('');
	lines.push('Sightline is read-only and never sits in your fulfillment path.');
	return lines.join('\n');
}

// Intentionally uncalled outside its own tests, for the same reason as
// `digestText` immediately above: `outboxRow` stores no body, so this is the
// HTML half of the copy waiting for a sender that does not exist yet. Do not
// delete it as dead code — its tests are what keep the escaping and the copy
// from rotting until that caller arrives.
export function digestHtml(input: DigestInput): string {
	const rows = input.topAwaiting
		.map((order) => `<tr><td>${esc(label(order))}</td><td>waiting ${esc(age(order.ageHours))}</td></tr>`)
		.join('');
	return [
		`<h2>Sightline digest for ${esc(input.shopId)}</h2>`,
		`<p>Window: ${esc(day(input.periodStart))} to ${esc(day(input.periodEnd))} (UTC)</p>`,
		input.recorderHealthy
			? ''
			: `<p><strong>Recorder needs attention:</strong> ${esc(plural(input.deadLettered, 'delivery', 'deliveries'))} could not be processed, so the numbers below may be incomplete.</p>`,
		'<ul>',
		// Same tense labels as the text body — see digestText.
		`<li>Orders awaiting fulfillment confirmation, as of now: ${input.ordersAwaiting}</li>`,
		`<li>Orders with a fulfillment attempt Shopify recorded as unsuccessful, in this window: ${input.failedAttemptsInPeriod}</li>`,
		`<li>Changes found by direct check rather than webhook, in this window: ${input.deliveryGaps}</li>`,
		'</ul>',
		rows ? `<h3>Longest waiting, as of now</h3><table>${rows}</table>` : '',
		`<p>${esc(BOUNDARY)}</p>`,
		'<p>Sightline is read-only and never sits in your fulfillment path.</p>',
	]
		.filter(Boolean)
		.join('\n');
}

// One row per shop per period — a rebuild of the same period upserts rather than
// duplicating, which is what makes the loop safe to run from several threads.
//
// Takes NO address, and writes none. A digest row is addressed by shop, and the
// address itself lives only on DigestSubscription, which is what makes the
// policy's "deleted as soon as you clear it or uninstall" true: uninstallShop
// deletes the subscription, and copies on outbox rows would have outlived that
// promise until the 30-day purge. A sender, when one exists, reads the address
// from the subscription at the moment it sends — the only moment it needs it.
//
// Also renders NO body, by design. `subject` and the counts below are the whole
// row: they are derived from the period and its counts only, so the row can
// outlive the seven-day ledger for 30 days without naming an order or holding
// customer data. `digestText`/`digestHtml` still exist for a future sender to
// call at send time — see the comments above them.
export function outboxRow(input: DigestInput, now: number): DigestOutbox {
	return {
		id: `${input.shopId}:${input.periodStart}`,
		shopId: input.shopId,
		cadence: input.cadence,
		periodStart: input.periodStart,
		periodEnd: input.periodEnd,
		subject: digestSubject(input),
		ordersAwaiting: input.ordersAwaiting,
		failedAttemptsInPeriod: input.failedAttemptsInPeriod,
		deliveryGaps: input.deliveryGaps,
		recorderHealthy: input.recorderHealthy,
		status: 'pending',
		createdAt: now,
	};
}
