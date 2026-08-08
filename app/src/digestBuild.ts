import type { DigestCadence, DigestOutbox, DigestSubscription } from './model.ts';
import type { QueryTable } from './queries.ts';
import { hasSomethingToSay, outboxRow, periodEndFor, periodStartFor, shouldBuild } from './digest.ts';
import { gatherDigestInput } from './digestData.ts';

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
}

export async function runDigestBuild(now: number, deps: DigestBuildDeps): Promise<DigestBuildResult> {
	let built = 0;
	let skippedNotDue = 0;
	let skippedQuiet = 0;
	for await (const row of deps.subscriptions.search({ conditions: [{ attribute: 'status', value: 'active' }] })) {
		const subscription = row as unknown as DigestSubscription;
		const cadence: DigestCadence = subscription.cadence ?? 'daily';
		const periodStart = periodStartFor(cadence, now);
		if (!shouldBuild(subscription, periodStart)) {
			skippedNotDue++;
			continue;
		}
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
	}
	return { built, skippedNotDue, skippedQuiet };
}
