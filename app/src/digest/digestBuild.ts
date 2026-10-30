import type { DigestCadence, DigestOutbox, DigestSubscription } from '../domain/model.ts';
import type { QueryTable } from '../api/queries.ts';
import { hasSomethingToSay, outboxRow, periodEndFor, periodStartFor, shouldBuild } from './digest.ts';
import { gatherDigestInput } from './digestData.ts';
import { log } from '../observability/observe.ts';

// Builds each active subscriber's digest for the last complete period and writes it
// to the outbox as 'pending'; nothing here marks a row 'sent'. Deps-injected and free
// of `./db.ts` / `harper` imports so it runs in plain node with FakeTables.
//
// Idempotent: the outbox id is `${shopId}:${periodStart}` (outboxRow) and the build
// keys on lastBuiltAt (shouldBuild), so overlapping ticks converge on one row per period.

// Minimal search/patch surface the loop needs; satisfied by a Harper Table and by FakeTable.
export interface DigestBuildSubscriptionsTable {
	search(spec: {
		conditions: Array<{ attribute: string; value: unknown; comparator?: string }>;
		operator?: 'and' | 'or';
	}): AsyncIterable<Record<string, unknown>>;
	patch(shopId: string, partial: Record<string, unknown>): Promise<void>;
}

// Injected side effects: real tables (jobs.ts) or FakeTables in tests.
export interface DigestBuildDeps {
	subscriptions: DigestBuildSubscriptionsTable;
	outboxes: { put(row: DigestOutbox): Promise<void> };
	projections: QueryTable;
	findings: QueryTable;
	events: QueryTable;
	deliveries: QueryTable;
}

export interface DigestBuildResult {
	built: number;
	// Not due this period: status or address gate failed, or already built.
	skippedNotDue: number;
	// Gathered but nothing actionable: no outbox row is written (an all-clear digest
	// trains people to ignore the channel), yet the period is marked built.
	skippedQuiet: number;
	// Gather or write threw; contained to that subscription and counted apart from the skips.
	failed: number;
}

// The subscription row carries the merchant's address, which could reach a log line
// through an error message that echoes the value it choked on. `redactFields` only
// redacts by key name, so these two scrubbers are a value-level second defense.

// Builds a RegExp from a literal, so `+` and `.` in an address are not metacharacters.
function escapeRegExp(literal: string): string {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Removes every case-insensitive occurrence of the known address. Case-insensitive
// because normalizeEmail lowercases on write but an error may quote the original casing.
export function scrubKnownAddress(message: string, address: string | undefined): string {
	if (!address) return message;
	return message.replace(new RegExp(escapeRegExp(address), 'gi'), '[address]');
}

// For catches too far from any subscription to know the address: scrubs anything
// email-shaped. `/` is excluded so a module path such as `node_modules/@scope/pkg/index.js`
// is not mistaken for an address.
const EMAIL_SHAPED = /[^\s@/]+@[^\s@/]+\.[^\s@/]+/g;
export function scrubEmailShaped(message: string): string {
	return message.replace(EMAIL_SHAPED, '[address]');
}

export async function runDigestBuild(now: number, deps: DigestBuildDeps): Promise<DigestBuildResult> {
	let built = 0;
	let skippedNotDue = 0;
	let skippedQuiet = 0;
	let failed = 0;
	// Read out before any build: a live iterator holds a Harper read snapshot that expires after
	// maxTransactionOpenTime (30 s), and the next advance would then throw and skip the rest.
	const rows: Array<Record<string, unknown>> = [];
	for await (const row of deps.subscriptions.search({ conditions: [{ attribute: 'status', value: 'active' }] })) rows.push(row);
	for (const row of rows) {
		const subscription = row as unknown as DigestSubscription;
		const cadence: DigestCadence = subscription.cadence ?? 'daily';
		const periodStart = periodStartFor(cadence, now);
		if (!shouldBuild(subscription, periodStart)) {
			skippedNotDue++;
			continue;
		}
		// One bad subscription must not abort the sweep and starve the shops after it.
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

			// A quiet period writes no digest but is still marked built. The address is required
			// to build but is not written into the row (outboxRow takes none).
			if (hasSomethingToSay(input) && subscription.email) {
				await deps.outboxes.put(outboxRow(input, now));
				built++;
			} else {
				skippedQuiet++;
			}
			await deps.subscriptions.patch(subscription.shopId, { lastBuiltAt: periodStart, updatedAt: now });
		} catch (e: unknown) {
			failed++;
			// The address must never reach this line, so it is scrubbed from `message`, which is not a redacted key.
			log('error', 'digest.build.subscription.failed', {
				shopId: subscription.shopId,
				message: scrubKnownAddress(e instanceof Error ? e.message : String(e), subscription.email),
			});
		}
	}
	return { built, skippedNotDue, skippedQuiet, failed };
}
