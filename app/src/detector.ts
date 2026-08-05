import type { Expectation, ExpectationState, GapFinding, OrderProjection } from './model.ts';

// ── Fulfillment-confirmation detector (ruleVersion 1) ────────────────────────
//
// Identifies paid, fulfillment-eligible orders with no observed Shopify
// fulfillment confirmation by a deadline. It NEVER asserts a downstream vendor
// failure — absence of confirmation is not proof of failure (see describeFinding).
//
// Decision table — inputs are the order projection's latches (all monotonic, so
// evaluation is deterministic and order-independent). `due` ≡ now ≥ paidAt+deadline.
//
//   paidAt & requiresFulfillment | fulfilledAt | cancelled/refunded | due  | expectation | finding
//   ─────────────────────────────┼─────────────┼────────────────────┼──────┼─────────────┼──────────
//   no (unpaid or ineligible)     |      –      |         –          |  –   |   (none)    | (none)
//   yes                           |    set      |         –          |  –   |  resolved   | resolved*
//   yes                           |   unset     |        set         |  –   |  suppressed | suppressed*
//   yes                           |   unset     |       unset        | no   |  pending    | (none)
//   yes                           |   unset     |       unset        | yes  |  expired    | unconfirmed
//
//   * A finding exists only if the expectation had already EXPIRED; a later
//     confirmation/suppression transitions that finding (history preserved),
//     never deletes it. Orders resolved/suppressed before expiry get no finding.

export const DETECTOR = 'fulfillment_confirmation';
export const RULE_VERSION = 1;
// Conservative product constant (not a merchant setting) — calibrate from pilot
// evidence. 3 days from paid to an expected fulfillment confirmation.
export const FULFILLMENT_DEADLINE_MS = 72 * 60 * 60 * 1000;

export interface DetectorRule {
	detector: string;
	ruleVersion: number;
	deadlineMs: number;
}

export const DEFAULT_RULE: DetectorRule = {
	detector: DETECTOR,
	ruleVersion: RULE_VERSION,
	deadlineMs: FULFILLMENT_DEADLINE_MS,
};

// Deterministic key shared by an order's expectation and its finding. Namespaced
// by shopId (like every other table key: WebhookDelivery, OrderProjection) so two
// tenants that ever share an order id cannot collide on one finding/expectation
// row — a tenant-isolation invariant, not merely a convenience (#23).
export function detectorKey(shopId: string, orderId: string, rule: DetectorRule = DEFAULT_RULE): string {
	return `${rule.detector}:${shopId}:${orderId}:${rule.ruleVersion}`;
}

export interface EvaluateInput {
	projection: OrderProjection;
	now: number;
	evidenceEventIds?: string[];
	prior?: { expectation?: Expectation; finding?: GapFinding };
	rule?: DetectorRule;
}

export interface EvaluateResult {
	expectation: Expectation | null;
	finding: GapFinding | null;
}

// Pure evaluation of one order against the rule. Returns the desired expectation
// and finding records (deterministic, idempotent — re-evaluating yields the same
// records, preserving createdAt/detectedAt/evidence from `prior`).
export function evaluateOrder(input: EvaluateInput): EvaluateResult {
	const rule = input.rule ?? DEFAULT_RULE;
	const p = input.projection;
	const prior = input.prior ?? {};

	const qualifies = p.paidAt !== undefined && p.requiresFulfillment === true;
	if (!qualifies) {
		// An order cannot un-pay or lose eligibility (latches), so a qualifying
		// order never reaches here; if it did, leave any prior finding untouched.
		return { expectation: null, finding: prior.finding ?? null };
	}

	const deadline = (p.paidAt as number) + rule.deadlineMs;
	let state: ExpectationState;
	if (p.fulfilledAt !== undefined) state = 'resolved';
	else if (p.cancelledAt !== undefined || p.fullyRefundedAt !== undefined) state = 'suppressed';
	else if (input.now >= deadline) state = 'expired';
	else state = 'pending';

	const id = detectorKey(p.shopId, p.orderId, rule);
	const terminal = state === 'resolved' || state === 'suppressed';
	const expectation: Expectation = {
		id,
		shopId: p.shopId,
		orderId: p.orderId,
		detector: rule.detector,
		ruleVersion: rule.ruleVersion,
		state,
		deadline,
		createdAt: prior.expectation?.createdAt ?? input.now,
		resolvedAt: terminal ? (prior.expectation?.resolvedAt ?? input.now) : undefined,
	};

	let finding: GapFinding | null = prior.finding ?? null;
	if (state === 'expired') {
		// Create (or keep) the finding; evidence + detectedAt are stable once set.
		finding = {
			id,
			shopId: p.shopId,
			orderId: p.orderId,
			ruleVersion: rule.ruleVersion,
			status: 'unconfirmed',
			detectedAt: prior.finding?.detectedAt ?? input.now,
			resolvedAt: undefined,
			evidenceEventIds: prior.finding?.evidenceEventIds ?? input.evidenceEventIds ?? [],
		};
	} else if (finding) {
		// Later evidence transitions an existing (previously expired) finding —
		// history preserved (detectedAt + evidence kept), never erased.
		if (state === 'resolved') finding = { ...finding, status: 'resolved', resolvedAt: finding.resolvedAt ?? input.now };
		else if (state === 'suppressed') finding = { ...finding, status: 'suppressed', resolvedAt: finding.resolvedAt ?? input.now };
	}

	return { expectation, finding };
}

// Approved, non-accusatory finding copy. Absence of a confirmation signal is not
// proof of a downstream failure, so the wording never claims a vendor failed.
export function describeFinding(finding: GapFinding): string {
	switch (finding.status) {
		case 'unconfirmed':
			return 'No Shopify fulfillment confirmation was observed for this paid, fulfillment-eligible order by the expected time.';
		case 'resolved':
			return 'A fulfillment confirmation was later observed; this order no longer lacks confirmation.';
		case 'suppressed':
			return 'This order was cancelled or fully refunded, so fulfillment confirmation is no longer expected.';
		default:
			return 'This order is awaiting evaluation.';
	}
}
