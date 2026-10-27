import type { DigestCadence, DigestOutbox } from '../domain/model.ts';

// The digest's pure domain: periods, whether to build, and the message copy. Every
// function takes the time it needs, so it is testable in plain node. There is no
// sender: the job persists the message to the outbox as 'pending'.

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

// Periods are UTC and always closed (the last complete day or week), so a number
// never describes a window still open. Two figures are current-state rather than
// window-scoped and say so where rendered: the awaiting count and the longest-waiting
// list, which are the population the Overview's awaiting tile shows
// (`isAwaitingConfirmation`, src/domain/orders.ts). Every message names its window
// and marks it UTC, including the subject, which is often the only part read.
export function periodStartFor(cadence: DigestCadence, now: number): number {
	const midnight = Math.floor(now / DAY_MS) * DAY_MS;
	if (cadence === 'weekly') {
		// getUTCDay: 0 = Sunday; shift so Monday = 0.
		const dayOfWeek = (new Date(midnight).getUTCDay() + 6) % 7;
		return midnight - dayOfWeek * DAY_MS - WEEK_MS;
	}
	return midnight - DAY_MS;
}

export function periodEndFor(cadence: DigestCadence, periodStart: number): number {
	return periodStart + (cadence === 'weekly' ? WEEK_MS : DAY_MS);
}

// Keying on the period (not elapsed time) makes the loop idempotent across ticks, threads and nodes.
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

// Field names carry the tense; `outboxRow` copies them onto the DigestOutbox column of the same name.
export interface DigestInput {
	shopId: string;
	cadence: DigestCadence;
	periodStart: number;
	periodEnd: number;
	// Current-state count of ORDERS awaiting confirmation; every one is in `topAwaiting`
	// before it is capped. Not `unconfirmed`, which names a GapFinding status (one order
	// can carry two findings).
	ordersAwaiting: number;
	// Scoped to [periodStart, periodEnd), unlike getSummary's `findings.failedAttempts`.
	// Counts ORDERS with a failed-attempt finding (one finding per order and ruleVersion).
	failedAttemptsInPeriod: number;
	deliveryGaps: number;
	recorderHealthy: boolean;
	deadLettered: number;
	// Current-state, drawn from the same iteration as `ordersAwaiting`.
	topAwaiting: DigestOrderRef[];
}

// An all-clear digest is not sent. `ordersAwaiting` is current-state, so an order
// that stays awaiting keeps every daily digest non-empty; that is intended, since
// it is open and actionable and the oldest age grows.
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

// Rounds first so days and hours derive from the same integer, making `age()` total
// for any numeric input.
function age(hours: number): string {
	const whole = Math.round(hours);
	return whole < 24 ? `${whole}h` : `${Math.floor(whole / 24)}d ${whole % 24}h`;
}

// Same rules as the SPA's `esc`; src/ must not depend on web/.
function esc(value: unknown): string {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

// A raw newline in a mail header value is a header-injection vector.
export function headerSafe(value: string): string {
	return value.replace(/[\r\n]+/g, ' ').trim();
}

// Leads with the most actionable fact: a broken recorder outranks a failed attempt
// (direct evidence), which outranks an absence, because other numbers may be
// incomplete while the recorder is unhealthy. The window is marked UTC and the
// awaiting lead says "now" because the subject is read on its own and that lead is current-state.
export function digestSubject(input: DigestInput): string {
	const window = input.cadence === 'weekly' ? `week of ${day(input.periodStart)} UTC` : `${day(input.periodStart)} UTC`;
	let lead: string;
	if (!input.recorderHealthy) lead = 'Sightline needs attention';
	else if (input.failedAttemptsInPeriod > 0)
		// Counts ORDERS, matching the Overview tile; attributes nothing to a warehouse or
		// carrier, since Shopify's own record says the attempt failed.
		lead = `${plural(input.failedAttemptsInPeriod, 'order', 'orders')} with a failed fulfillment attempt`;
	else if (input.ordersAwaiting > 0) lead = `${plural(input.ordersAwaiting, 'order', 'orders')} awaiting confirmation now`;
	else if (input.deliveryGaps > 0) lead = `${plural(input.deliveryGaps, 'change', 'changes')} found by direct check`;
	else lead = 'Nothing to report';
	return headerSafe(`Sightline: ${lead} (${window})`);
}

// The product-truth boundary travels with the message, which is read outside the app.
const BOUNDARY =
	'These are observations of your Shopify data. An order with no observed confirmation does not prove that a warehouse or carrier failed — it means Shopify has not shown the expected fulfillment confirmation yet.';

// Uncalled outside tests: `outboxRow` stores no body (a stored message naming orders
// must not outlive the seven-day ledger). A future sender renders it fresh from a
// DigestInput. Its tests keep the copy from rotting; do not delete as dead code.
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
	// Each line states its tense: the first is current-state, the other two are scoped
	// to the window above. Orders awaiting is an absence, failed attempts a presence;
	// an order can be in both.
	lines.push(`Orders awaiting fulfillment confirmation, as of now: ${input.ordersAwaiting}`);
	lines.push(`Orders with a fulfillment attempt Shopify recorded as unsuccessful, in this window: ${input.failedAttemptsInPeriod}`);
	lines.push(`Changes found by direct check rather than webhook, in this window: ${input.deliveryGaps}`);
	if (input.topAwaiting.length > 0) {
		lines.push('');
		// Current-state, like the first line, so it is labelled "as of now".
		lines.push('Longest waiting, as of now:');
		for (const order of input.topAwaiting) lines.push(`  ${label(order)} — waiting ${age(order.ageHours)}`);
	}
	lines.push('');
	lines.push(BOUNDARY);
	lines.push('');
	lines.push('Sightline is read-only and never sits in your fulfillment path.');
	return lines.join('\n');
}

// Uncalled outside tests, like `digestText`; do not delete as dead code.
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
		// Same tense labels as digestText.
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

// One row per shop per period, so a rebuild upserts. It takes no address and
// renders no body: the address lives only on DigestSubscription (so uninstall
// deletion holds), and `subject` plus counts name no order or customer, which lets
// the row outlive the seven-day ledger.
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
