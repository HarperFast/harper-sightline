import type { OrderProjection } from './model.ts';

// The single definition of where an order sits and how old it is.
//
// Before this module, "paid and fulfillment-eligible and not fulfilled and not
// cancelled and not fully refunded" was copy-pasted into getSummary, computeFlows,
// and the detector's eligibility rule. Three copies of a five-clause predicate is
// three chances for the Overview tile, the flow lane, and the finding list to
// disagree about the same order. Everything derives from here now.

export type OrderLane = 'unpaid' | 'awaiting' | 'fulfilled' | 'cancelled' | 'refunded';

// Awaiting = Shopify has shown payment for an order that needs shipping, and has
// not yet shown a fulfillment confirmation, and the order has not been called off.
export function isAwaitingConfirmation(p: OrderProjection): boolean {
	return (
		p.paidAt !== undefined &&
		p.requiresFulfillment === true &&
		p.fulfilledAt === undefined &&
		p.cancelledAt === undefined &&
		p.fullyRefundedAt === undefined
	);
}

// Lanes are ordered by finality: a cancelled order is cancelled even if it was
// fulfilled first, and an unpaid order is unpaid regardless of anything else.
//
// A failed fulfillment attempt deliberately does NOT get its own lane. The lane
// answers "where is this order in the flow"; a failed attempt is a FINDING about
// an order that is still awaiting confirmation. Giving it a lane would quietly
// remove those orders from the awaiting worklist — the one list where a merchant
// most needs to see them.
export function deriveOrderLane(p: OrderProjection): OrderLane {
	if (p.paidAt === undefined) return 'unpaid';
	if (p.cancelledAt !== undefined) return 'cancelled';
	if (p.fullyRefundedAt !== undefined) return 'refunded';
	if (isAwaitingConfirmation(p)) return 'awaiting';
	return 'fulfilled';
}

const HOUR_MS = 3_600_000;

export function ageHours(paidAt: number | undefined, now: number): number | undefined {
	if (paidAt === undefined) return undefined;
	return Math.max(0, Math.floor((now - paidAt) / HOUR_MS));
}

// Aging buckets for the Overview. The 72-hour boundary is the confirmation
// detector's deadline (FULFILLMENT_DEADLINE_MS), so "over72" is exactly the set
// that has already produced findings and the earlier buckets are the ones a
// merchant can still act on before the deadline bites.
export const AGE_BUCKETS: ReadonlyArray<{ key: string; label: string; minHours: number; maxHours?: number }> = [
	{ key: 'under24', label: 'Under 24h', minHours: 0, maxHours: 24 },
	{ key: 'h24to48', label: '24–48h', minHours: 24, maxHours: 48 },
	{ key: 'h48to72', label: '48–72h', minHours: 48, maxHours: 72 },
	{ key: 'over72', label: 'Over 72h', minHours: 72 },
];

// Half-open intervals [min, max), so every age lands in exactly one bucket.
export function ageBucketKey(paidAt: number | undefined, now: number): string | undefined {
	const hours = ageHours(paidAt, now);
	if (hours === undefined) return undefined;
	for (const bucket of AGE_BUCKETS) {
		if (hours >= bucket.minHours && (bucket.maxHours === undefined || hours < bucket.maxHours)) return bucket.key;
	}
	return AGE_BUCKETS[AGE_BUCKETS.length - 1].key;
}
