import type { DigestCadence, DigestOutbox, DigestSubscription } from './model.ts';
import type { QueryTable } from './queries.ts';
import { hasSomethingToSay, outboxRow, periodEndFor, periodStartFor, shouldBuild } from './digest.ts';
import { gatherDigestInput } from './digestData.ts';
import { log } from './observe.ts';

// The digest build loop's orchestration, deps-injected — the same split
// src/inventoryEnrich.ts and src/stateBackfill.ts already use, and for the same
// reason: this module never imports ./db.ts or the `harper` package, so it is
// unit-testable in plain node with FakeTables. jobs.ts wires the real Harper
// tables and the ticker/schedule.
//
// THERE IS NO SENDER. This builds each active subscriber's digest for the last
// complete period and writes it to the outbox with status 'pending'. Delivery is
// a separate decision with its own compliance surface, so this stops at a
// persisted, ready-to-send message — nothing here ever marks a row 'sent'.
//
// Idempotent by construction: the outbox id is `${shopId}:${periodStart}`
// (src/digest.ts's outboxRow), and the build decision keys on the
// subscription's lastBuiltAt against the period start (shouldBuild), so
// overlapping ticks across threads and cluster nodes converge on one row per
// period rather than duplicating or racing.

// The minimal search/patch surface the loop needs from the subscriptions table
// — structurally satisfied by a Harper Table<DigestSubscription> (cast at the
// call site, as elsewhere in this codebase) and directly by a FakeTable in tests.
export interface DigestBuildSubscriptionsTable {
	search(spec: {
		conditions: Array<{ attribute: string; value: unknown; comparator?: string }>;
		operator?: 'and' | 'or';
	}): AsyncIterable<Record<string, unknown>>;
	patch(shopId: string, partial: Record<string, unknown>): Promise<void>;
}

// Injected side effects: the real Harper tables in the component (jobs.ts wires
// them), FakeTables + FakeTable-backed query tables in tests.
export interface DigestBuildDeps {
	subscriptions: DigestBuildSubscriptionsTable;
	outboxes: { put(row: DigestOutbox): Promise<void> };
	projections: QueryTable;
	findings: QueryTable;
	events: QueryTable;
	deliveries: QueryTable;
}

export interface DigestBuildResult {
	// Digests actually written to the outbox this pass.
	built: number;
	// Subscriptions not due this period — status/address gate failed, or this
	// period was already built (shouldBuild returned false). Distinct from
	// skippedQuiet below: this answers "were digests even attempted?".
	skippedNotDue: number;
	// Subscriptions that WERE gathered for this period but had nothing
	// actionable to report — a quiet, healthy period writes no outbox row (a
	// recurring "all clear" trains people to ignore the channel), but the period
	// is still marked built so the next tick does not re-gather it. Distinct
	// from skippedNotDue: this answers "did digests build but decide not to send?".
	skippedQuiet: number;
	// Subscriptions whose gather/write threw. Contained to that one subscription
	// (see the per-subscription try/catch below) — it does not stop the sweep,
	// but it also does not silently vanish into skippedNotDue/skippedQuiet.
	failed: number;
}

// The address is the only merchant-identifying string this app stores, and
// this is the first background loop whose per-item data (the subscription's
// email, embedded in the outbox row by outboxRow) is at risk of reaching a log
// line through something OTHER than a field named `email` — namely an error
// message that happens to echo the value it choked on, which is ordinary
// behavior for many data layers. `redactFields` (src/observe.ts) only redacts
// by KEY name, so a `message` field is not covered by it at all. These two
// scrubbers are a second, value-level line of defense scoped to this loop,
// not a change to that shared, key-based mechanism.

// Used where the address at risk is known (the per-subscription catch below):
// remove that exact string. A message with no occurrence of it, or no address
// argument at all, passes through byte-for-byte.
export function scrubKnownAddress(message: string, address: string | undefined): string {
	if (!address) return message;
	return message.split(address).join('[address]');
}

// Used where the failure is caught too far from any specific subscription to
// know which address (if any) was involved — jobs.ts's outer tick catch. Scans
// for anything email-shaped rather than a specific string. An ordinary message
// with nothing email-shaped in it passes through unchanged.
const EMAIL_SHAPED = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
export function scrubEmailShaped(message: string): string {
	return message.replace(EMAIL_SHAPED, '[address]');
}

export async function runDigestBuild(now: number, deps: DigestBuildDeps): Promise<DigestBuildResult> {
	let built = 0;
	let skippedNotDue = 0;
	let skippedQuiet = 0;
	let failed = 0;
	for await (const row of deps.subscriptions.search({ conditions: [{ attribute: 'status', value: 'active' }] })) {
		const subscription = row as unknown as DigestSubscription;
		const cadence: DigestCadence = subscription.cadence ?? 'daily';
		const periodStart = periodStartFor(cadence, now);
		if (!shouldBuild(subscription, periodStart)) {
			skippedNotDue++;
			continue;
		}
		// One bad subscription (a malformed row, a table hiccup on this shop's
		// write) must not abort the sweep and starve every shop after it in
		// iteration order — matching the isolation src/inventoryEnrich.ts already
		// applies around its own per-shop Admin API calls.
		try {
			const periodEnd = periodEndFor(cadence, periodStart);
			const input = await gatherDigestInput(
				{ projections: deps.projections, findings: deps.findings, events: deps.events, deliveries: deps.deliveries },
				subscription.shopId,
				cadence,
				periodStart,
				periodEnd,
				now,
			);

			// A quiet, healthy period produces no digest, but the period is still
			// marked built below so the next tick does not re-gather it.
			if (hasSomethingToSay(input) && subscription.email) {
				await deps.outboxes.put(outboxRow(input, subscription.email, now));
				built++;
			} else {
				skippedQuiet++;
			}
			await deps.subscriptions.patch(subscription.shopId, { lastBuiltAt: periodStart, updatedAt: now });
		} catch (e: unknown) {
			failed++;
			// shopId is not merchant-identifying (it is the storefront's own
			// domain-derived id, already logged elsewhere) — the address is what
			// must never reach this line, so it is scrubbed from the message even
			// though `message` itself is not a redacted key.
			log('error', 'digest.build.subscription.failed', {
				shopId: subscription.shopId,
				message: scrubKnownAddress((e as Error).message, subscription.email),
			});
		}
	}
	return { built, skippedNotDue, skippedQuiet, failed };
}
