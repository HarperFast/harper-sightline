import type { DigestCadence, GapFinding, OrderProjection } from './model.ts';
import type { QueryTable } from './queries.ts';
import type { DigestInput, DigestOrderRef } from './digest.ts';
import { DETECTOR_FAILED } from './detector.ts';
import { ageHours, isAwaitingConfirmation } from './orders.ts';

// Gathering the digest's inputs. Split from digest.ts because rendering changes
// for editorial reasons and gathering changes for schema reasons.
//
// Every search is constrained by shopId — a digest is the one artifact that
// leaves the app, so cross-tenant bleed here would be the worst possible place
// for it. The adversarial tests in test/digestData.test.ts pin that.

// How many orders to name. Enough to be actionable, few enough that the message
// stays readable and does not become a data export.
export const TOP_AWAITING = 5;

export async function gatherDigestInput(
	tables: { projections: QueryTable; findings: QueryTable; events: QueryTable; deliveries: QueryTable },
	shopId: string,
	cadence: DigestCadence,
	periodStart: number,
	periodEnd: number,
	now: number,
): Promise<DigestInput> {
	// Findings DETECTED in the period. Counting by detection time (rather than
	// current state) is what makes the digest a report about that window instead of
	// a snapshot that happens to be sent on a schedule.
	let unconfirmed = 0;
	let failedAttempts = 0;
	for await (const row of tables.findings.search({ conditions: [{ attribute: 'shopId', value: shopId }] })) {
		const finding = row as unknown as GapFinding;
		const detectedAt = finding.detectedAt ?? 0;
		if (detectedAt < periodStart || detectedAt >= periodEnd) continue;
		if (finding.status !== 'unconfirmed') continue;
		unconfirmed++;
		if (finding.detector === DETECTOR_FAILED) failedAttempts++;
	}

	// Changes that reached us only through a direct Admin API check — the webhook
	// never arrived. Evidence about OUR capture path only (see the integrity copy).
	let deliveryGaps = 0;
	for await (const _row of tables.events.search({
		conditions: [
			{ attribute: 'shopId', value: shopId },
			{ attribute: 'source', value: 'reconciliation' },
			{ attribute: 'occurredAt', value: periodStart, comparator: 'greater_than_equal' },
			{ attribute: 'occurredAt', value: periodEnd, comparator: 'less_than' },
		],
		operator: 'and',
		select: ['eventId'],
	})) {
		deliveryGaps++;
	}

	// Recorder health, so a digest can never report "all quiet" from an incomplete
	// pipeline. Same signal the Overview uses.
	let deadLettered = 0;
	for await (const _row of tables.deliveries.search({
		conditions: [
			{ attribute: 'shopId', value: shopId },
			{ attribute: 'status', value: 'dead_letter' },
		],
		operator: 'and',
		select: ['id'],
	})) {
		deadLettered++;
	}

	// The orders that have been waiting longest, as of NOW rather than as of the
	// period end: a merchant acting on this message needs the current wait.
	// `isAwaitingConfirmation` / `ageHours` come from src/orders.ts — the single
	// definition the Overview and the worklist also use, so a digest can never
	// name a different set of orders, or a different age for one, than the app.
	const awaiting: DigestOrderRef[] = [];
	for await (const row of tables.projections.search({ conditions: [{ attribute: 'shopId', value: shopId }] })) {
		const p = row as unknown as OrderProjection;
		if (!isAwaitingConfirmation(p)) continue;
		const hours = ageHours(p.paidAt, now);
		// isAwaitingConfirmation already requires p.paidAt !== undefined, so this is
		// always defined here; the check keeps the `number | undefined` honest
		// without a cast, rather than asserting past it.
		if (hours === undefined) continue;
		awaiting.push({ orderName: p.orderName, orderId: p.orderId, ageHours: hours });
	}
	awaiting.sort((a, b) => b.ageHours - a.ageHours);

	return {
		shopId,
		cadence,
		periodStart,
		periodEnd,
		unconfirmed,
		failedAttempts,
		deliveryGaps,
		recorderHealthy: deadLettered === 0,
		deadLettered,
		topAwaiting: awaiting.slice(0, TOP_AWAITING),
	};
}
