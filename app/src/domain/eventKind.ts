import type { OperationalEvent } from './model.ts';

// Order changes recognizable from either observation path. Smaller than EventDomain:
// 'inventory' has no reconciliation equivalent, so it never matches anything below.
export type EventKind = 'paid' | 'refunded' | 'cancelled' | 'fulfilled';

// Pinned to domain/state/topic (never `source` or `eventId`), so the result is
// structurally independent of source and does not parse the id.
export type EventKindFields = Pick<OperationalEvent, 'domain' | 'state' | 'topic'>;

// Webhooks and the reconciliation sweep can both observe the same change, so counting
// `source: 'reconciliation'` events as "missed by webhook" proves nothing. This is the
// shared (resourceId, kind) mapping that collides for the same change from either
// source; neither side has a field that already means that (synthesizeEvents sets
// `topic` on only two of four kinds, and webhook `state` comes straight off the payload).
//
// Safety bias: a wrong guess tells a merchant a webhook never arrived when it did,
// while a missed match only under-counts a gap. Every branch below is a field
// combination written only for that kind; anything else returns undefined.
export function eventKind(event: EventKindFields): EventKind | undefined {
	// `state` cannot signal cancellation on the webhook side (a cancelled order keeps
	// its financial_status). `topic` is written only for this kind by both normalizeOrder
	// and synthesizeEvents ('orders/cancelled').
	if (event.topic === 'orders/cancelled') return 'cancelled';

	// Shopify's fulfillment status 'success' matches synthesizeEvents' literal; no other
	// domain's state vocabulary contains it.
	if (event.domain === 'fulfillment' && event.state === 'success') return 'fulfilled';

	// normalizeRefund (domain 'refund') and synthesizeEvents (domain 'order') both write
	// state 'refunded', so domain is not tested. 'partially_refunded' is a different
	// claim and deliberately falls through.
	if (event.state === 'refunded') return 'refunded';

	// financial_status 'paid' is order-only vocabulary and 'orders/paid' fires only for
	// this transition, so either field alone is a confident signal.
	if (event.topic === 'orders/paid' || event.state === 'paid') return 'paid';

	return undefined;
}

// How far outside a comparison window to look for the other side of a match; the
// two paths never share an `occurredAt` field for the same change. One day covers
// the ordinary near-boundary case. It only widens matching, never what a caller
// reports as the window's own activity.
//
// Callers apply it by window shape: digestData's gatherDigestInput has a closed
// period and widens both edges; queries.ts's getSummary ends at `now`, where no
// twin can be in the future, so it widens only the lower edge.
export const MATCH_MARGIN_MS = 86_400_000;
