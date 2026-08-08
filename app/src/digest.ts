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

// Periods are UTC and always CLOSED: the digest describes the last complete day
// or week, never a partial one in progress. A merchant reading "3 orders awaiting"
// for a window that is still open would have no way to know the number will move.
//
// UTC rather than the store's timezone is a deliberate simplification: it keeps
// the boundary arithmetic trivial and identical across cluster nodes, and every
// message names its window explicitly, so nothing is ambiguous even when the
// store's day differs.
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

export interface DigestInput {
	shopId: string;
	cadence: DigestCadence;
	periodStart: number;
	periodEnd: number;
	unconfirmed: number;
	failedAttempts: number;
	deliveryGaps: number;
	recorderHealthy: boolean;
	deadLettered: number;
	topAwaiting: DigestOrderRef[];
}

// A digest with nothing to report is not sent. A recurring "all clear" email
// trains people to ignore the channel, and the app itself is always available for
// a health check.
export function hasSomethingToSay(input: DigestInput): boolean {
	return input.unconfirmed > 0 || input.failedAttempts > 0 || input.deliveryGaps > 0 || !input.recorderHealthy;
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
// parts are derived from the SAME integer. `src/orders.ts`'s `ageHours()`
// currently floors to an integer already, but nothing here should assume that
// stays true — Task 3 feeds this whatever a future ageHours() computation
// produces, and a fractional hour must not leak into the rendered string
// (`3d 8.5h` is not an age a merchant can act on).
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
// while the recorder is unhealthy the other numbers may be incomplete.
export function digestSubject(input: DigestInput): string {
	const window = input.cadence === 'weekly' ? `week of ${day(input.periodStart)}` : day(input.periodStart);
	let lead: string;
	if (!input.recorderHealthy) lead = 'Sightline needs attention';
	else if (input.failedAttempts > 0)
		lead = `${plural(input.failedAttempts, 'fulfillment attempt', 'fulfillment attempts')} did not succeed`;
	else if (input.unconfirmed > 0) lead = `${plural(input.unconfirmed, 'order', 'orders')} awaiting confirmation`;
	else if (input.deliveryGaps > 0) lead = `${plural(input.deliveryGaps, 'change', 'changes')} found by direct check`;
	else lead = 'Nothing to report';
	return headerSafe(`Sightline: ${lead} (${window})`);
}

// The product-truth boundary travels WITH the message. A digest is read outside
// the app, often forwarded, so it cannot rely on a screen to carry the caveat.
const BOUNDARY =
	'These are observations of your Shopify data. An order with no observed confirmation does not prove that a warehouse or carrier failed — it means Shopify has not shown the expected fulfillment confirmation yet.';

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
	lines.push(`Orders awaiting fulfillment confirmation: ${input.unconfirmed}`);
	lines.push(`Fulfillment attempts that did not succeed: ${input.failedAttempts}`);
	lines.push(`Changes found by direct check rather than webhook: ${input.deliveryGaps}`);
	if (input.topAwaiting.length > 0) {
		lines.push('');
		lines.push('Longest waiting:');
		for (const order of input.topAwaiting) lines.push(`  ${label(order)} — waiting ${age(order.ageHours)}`);
	}
	lines.push('');
	lines.push(BOUNDARY);
	lines.push('');
	lines.push('Sightline is read-only and never sits in your fulfillment path.');
	return lines.join('\n');
}

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
		`<li>Orders awaiting fulfillment confirmation: ${input.unconfirmed}</li>`,
		`<li>Fulfillment attempts that did not succeed: ${input.failedAttempts}</li>`,
		`<li>Changes found by direct check rather than webhook: ${input.deliveryGaps}</li>`,
		'</ul>',
		rows ? `<h3>Longest waiting</h3><table>${rows}</table>` : '',
		`<p>${esc(BOUNDARY)}</p>`,
		'<p>Sightline is read-only and never sits in your fulfillment path.</p>',
	]
		.filter(Boolean)
		.join('\n');
}

// One row per shop per period — a rebuild of the same period upserts rather than
// duplicating, which is what makes the loop safe to run from several threads.
export function outboxRow(input: DigestInput, email: string, now: number): DigestOutbox {
	return {
		id: `${input.shopId}:${input.periodStart}`,
		shopId: input.shopId,
		email,
		cadence: input.cadence,
		periodStart: input.periodStart,
		periodEnd: input.periodEnd,
		subject: digestSubject(input),
		bodyText: digestText(input),
		bodyHtml: digestHtml(input),
		unconfirmed: input.unconfirmed,
		failedAttempts: input.failedAttempts,
		deliveryGaps: input.deliveryGaps,
		recorderHealthy: input.recorderHealthy,
		status: 'pending',
		createdAt: now,
	};
}
