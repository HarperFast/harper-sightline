import type { OperationalEvent } from './model.ts';

// The kinds of real-world order change this app can recognize regardless of
// which path observed them. Deliberately smaller than EventDomain: 'inventory'
// has no reconciliation-side equivalent (synthesizeEvents never emits it), so it
// is not a kind here — an inventory event simply never matches anything below.
export type EventKind = 'paid' | 'refunded' | 'cancelled' | 'fulfilled';

// The subset of an OperationalEvent this function reads. Pinned to exactly
// domain/state/topic (never `source`, never `eventId`) so the "does not depend
// on source" and "does not parse the id" requirements are structural, not just
// promises kept by the implementation.
export type EventKindFields = Pick<OperationalEvent, 'domain' | 'state' | 'topic'>;

// Webhook delivery and the reconciliation sweep are two independent paths that
// can both observe the SAME real change to the SAME order — a webhook firing
// normally, followed by the next sweep re-confirming it from the Admin API.
// Counting one path's events (`source: 'reconciliation'`) and calling that
// "missed by webhook" is not evidence of anything: it is only evidence that a
// resync happened, which it always does. Telling the two paths' events apart
// from the SAME change requires a "kind" that means the same thing on both
// sides, and the two sides do not share a field that already does that —
// synthesizeEvents (src/shopify/reconcile.ts) sets `topic` on only two of its four
// kinds, and normalize.ts's webhook `state` is read straight off the Shopify
// payload, not written to agree with reconciliation's literals by convention.
// This function is that shared mapping, so a caller can build a
// (resourceId, kind) key from EITHER source and have it collide for the same
// real change.
//
// SAFETY BIAS: this product's whole claim is that it reports only what it
// observed. Guessing a kind when the fields don't clearly say so risks the
// worse failure — telling a merchant a webhook never arrived when it did,
// which is an accusation about their own infrastructure they will go verify.
// Missing a real match only under-counts a capture gap, which is silence, not
// a false alarm. So every branch below is a field combination this codebase
// writes ONLY for that one kind; anything else returns undefined rather than
// a best guess.
export function eventKind(event: EventKindFields): EventKind | undefined {
	// Cancellation cannot be read from `state` on the webhook side: normalizeOrder
	// sets state from financial_status/fulfillment_status, and neither vocabulary
	// contains "cancelled" — a cancelled order's financial_status is whatever it
	// was at cancellation (paid, voided, refunded, ...). `topic` is the one field
	// both normalizeOrder (webhook, topic = the delivery's own topic) and
	// synthesizeEvents (reconciliation, topic set literally to 'orders/cancelled')
	// write specifically and only for this kind.
	if (event.topic === 'orders/cancelled') return 'cancelled';

	// Fulfillment success. Shopify's fulfillment status vocabulary (pending, open,
	// success, cancelled, error, failure — normalizeFulfillment's comment) and
	// synthesizeEvents' literal 'success' agree exactly, and no other domain's
	// state vocabulary contains "success".
	if (event.domain === 'fulfillment' && event.state === 'success') return 'fulfilled';

	// A refund. Written verbatim as state 'refunded' by normalizeRefund (webhook,
	// domain 'refund') AND by synthesizeEvents (reconciliation, domain 'order') —
	// the two sources disagree about domain for this kind, which is exactly why
	// domain is not tested here. 'partially_refunded' is a different
	// financial_status and is deliberately NOT treated as the same kind: it is not
	// the claim 'refunded' makes, and the safety bias means an unclear case falls
	// through rather than being folded into the nearest label.
	if (event.state === 'refunded') return 'refunded';

	// A payment. financial_status 'paid' is order-only vocabulary on both sides,
	// and Shopify fires the 'orders/paid' topic (mirrored literally by
	// synthesizeEvents) only for this transition — either field alone is a
	// confident signal, so either is accepted.
	if (event.topic === 'orders/paid' || event.state === 'paid') return 'paid';

	return undefined;
}

// How far outside a webhook/reconciliation comparison window to look for the
// OTHER side of a match. Both callers below build a (resourceId, kind) key from
// this function's output to decide whether a webhook row and a reconciliation
// row describe the same real change; this is the tolerance on WHEN, once that
// decision needs one. One day: large enough to cover the ordinary near-boundary
// case (an order created late one day and paid early the next — see the two
// call sites for why the two paths never share an `occurredAt` field for the
// same change), small enough that the extra rows scanned stay proportional to a
// day of traffic. This only ever widens MATCHING; it never widens what either
// caller reports as this window's own activity.
//
// The two callers apply it asymmetrically, and that asymmetry is a property of
// each caller's window shape, not an inconsistency:
//   - src/digest/digestData.ts's gatherDigestInput describes a CLOSED period —
//     `periodStart` and `periodEnd` are both real elapsed instants a matching
//     event could land just outside of — so it widens both edges.
//   - src/api/queries.ts's getSummary describes a window whose upper edge is `now`,
//     the instant the query itself runs. An event's `occurredAt` cannot be in
//     the future, so there is no twin to find past that edge; only the lower
//     edge (`windowStart`) is ever widened.
export const MATCH_MARGIN_MS = 86_400_000;
