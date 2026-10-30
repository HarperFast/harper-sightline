import type { OrderProjection } from './model.ts';

// The single definition of where an order sits and how old it is, shared by
// getSummary, computeFlows and the detector so the Overview tile, flow lane and
// finding list cannot disagree about one order.

// The lane set; model.ts aliases ProjectionState to this so the stored `state` and
// the derived lane cannot drift. 'no_fulfillment_expected' exists because
// 'fulfilled' must mean a fulfillment was observed: a digital order never latches
// `requiresFulfillment` and must not render as "Fulfilled".
export type OrderLane = 'unpaid' | 'awaiting' | 'fulfilled' | 'no_fulfillment_expected' | 'cancelled' | 'refunded';

// Shopify has shown payment for an order that needs shipping, no fulfillment
// confirmation, and the order has not been called off.
export function isAwaitingConfirmation(p: OrderProjection): boolean {
	return (
		p.paidAt !== undefined &&
		p.requiresFulfillment === true &&
		p.fulfilledAt === undefined &&
		p.cancelledAt === undefined &&
		p.fullyRefundedAt === undefined
	);
}

// Ordered by finality: a cancelled order is cancelled even if fulfilled first. A
// failed attempt has no lane of its own: it is a finding about an order still
// awaiting confirmation, and a lane would drop it from the awaiting worklist.
// 'fulfilled' requires an observed `fulfilledAt`. Other paid, live, non-awaiting
// orders are 'no_fulfillment_expected': `requiresFulfillment` is only ever latched
// true, so `undefined` covers both "zero fulfillable units" and "no line items
// observed". Neither licenses "fulfilled" or "needs no shipping", so the lane is
// named for our expectation, not the order's nature.
export function deriveOrderLane(p: OrderProjection): OrderLane {
	if (p.paidAt === undefined) return 'unpaid';
	if (p.cancelledAt !== undefined) return 'cancelled';
	if (p.fullyRefundedAt !== undefined) return 'refunded';
	if (isAwaitingConfirmation(p)) return 'awaiting';
	if (p.fulfilledAt !== undefined) return 'fulfilled';
	return 'no_fulfillment_expected';
}

const HOUR_MS = 3_600_000;

export function ageHours(paidAt: number | undefined, now: number): number | undefined {
	if (paidAt === undefined) return undefined;
	return Math.max(0, Math.floor((now - paidAt) / HOUR_MS));
}

// The 72-hour boundary is the confirmation detector's deadline, so "over72" is
// exactly the set that already has findings.
export const AGE_BUCKETS: ReadonlyArray<{ key: string; label: string; minHours: number; maxHours?: number }> = [
	{ key: 'under24', label: 'Under 24h', minHours: 0, maxHours: 24 },
	{ key: 'h24to48', label: '24–48h', minHours: 24, maxHours: 48 },
	{ key: 'h48to72', label: '48–72h', minHours: 48, maxHours: 72 },
	{ key: 'over72', label: 'Over 72h', minHours: 72 },
];

// Half-open [min, max): every age lands in exactly one bucket.
export function ageBucketKey(paidAt: number | undefined, now: number): string | undefined {
	const hours = ageHours(paidAt, now);
	if (hours === undefined) return undefined;
	for (const bucket of AGE_BUCKETS) {
		if (hours >= bucket.minHours && (bucket.maxHours === undefined || hours < bucket.maxHours)) return bucket.key;
	}
	return AGE_BUCKETS[AGE_BUCKETS.length - 1].key;
}
