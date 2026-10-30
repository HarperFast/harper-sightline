import type { Expectation, ExpectationState, GapFinding, OrderProjection } from './model.ts';

// ── Fulfillment-confirmation detector (ruleVersion 1) ────────────────────────
//
// Flags paid, fulfillment-eligible orders with no observed fulfillment confirmation
// by a deadline. It never asserts a downstream failure (see describeFinding).
//
// Decision table over the projection's monotonic latches, so evaluation is
// deterministic and order-independent. `due` = now >= paidAt + deadline.
//
//   paidAt & requiresFulfillment | fulfilledAt | cancelled/refunded | due  | expectation | finding
//   ─────────────────────────────┼─────────────┼────────────────────┼──────┼─────────────┼──────────
//   no (unpaid or ineligible)     |      –      |         –          |  –   |   (none)    | (none)
//   yes                           |    set      |         –          |  –   |  resolved   | resolved*
//   yes                           |   unset     |        set         |  –   |  suppressed | suppressed*
//   yes                           |   unset     |       unset        | no   |  pending    | (none)
//   yes                           |   unset     |       unset        | yes  |  expired    | unconfirmed
//
//   * A finding exists only if the expectation had already expired; later
//     confirmation or suppression transitions it (history kept), never deletes it.

export const DETECTOR = 'fulfillment_confirmation';
export const RULE_VERSION = 1;
// Product constant: 3 days from paid to an expected fulfillment confirmation.
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

// ── Failed-fulfillment-attempt detector (ruleVersion 1) ──────────────────────
//
// A presence detector: it fires on a fulfillment Shopify recorded as `error` or
// `failure`, needs no deadline, and may state that an attempt failed. It never
// names or blames a downstream party.
//
//   fulfillmentFailedAt | fulfilledAt (later) | cancelled/refunded | finding
//   ────────────────────┼─────────────────────┼────────────────────┼──────────────
//   unset               |          –          |         –          | (none)
//   set                 |        unset        |       unset        | unconfirmed
//   set                 |         set         |         –          | resolved
//   set                 |        unset        |        set         | suppressed
export const DETECTOR_FAILED = 'fulfillment_attempt_failed';

// 0: this detector has no waiting period; DetectorRule is the shared shape that keys and versions it.
export const FAILED_RULE: DetectorRule = {
	detector: DETECTOR_FAILED,
	ruleVersion: 1,
	deadlineMs: 0,
};

// Every rule that writes findings. Order detail reads an order's findings by these
// keys (GapFinding.orderId is not indexed), so a new rule or version must be listed
// here or its findings will not show there.
export const DETECTOR_RULES: readonly DetectorRule[] = [DEFAULT_RULE, FAILED_RULE];

export interface FailedEvaluateInput {
	projection: OrderProjection;
	now: number;
	evidenceEventIds?: string[];
	prior?: { finding?: GapFinding };
	rule?: DetectorRule;
}

export function evaluateFailedFulfillment(input: FailedEvaluateInput): { finding: GapFinding | null } {
	const rule = input.rule ?? FAILED_RULE;
	const p = input.projection;
	const prior = input.prior ?? {};
	if (p.fulfillmentFailedAt === undefined) return { finding: prior.finding ?? null };

	// The failure's own timestamp, not when the sweep noticed; stable across re-evaluation.
	const detectedAt = prior.finding?.detectedAt ?? p.fulfillmentFailedAt;
	let status: GapFinding['status'] = 'unconfirmed';
	if (p.fulfilledAt !== undefined) status = 'resolved';
	else if (p.cancelledAt !== undefined || p.fullyRefundedAt !== undefined) status = 'suppressed';

	const terminal = status !== 'unconfirmed';
	return {
		finding: {
			id: detectorKey(p.shopId, p.orderId, rule),
			shopId: p.shopId,
			orderId: p.orderId,
			detector: rule.detector,
			ruleVersion: rule.ruleVersion,
			status,
			detectedAt,
			resolvedAt: terminal ? (prior.finding?.resolvedAt ?? input.now) : undefined,
			evidenceEventIds: prior.finding?.evidenceEventIds ?? input.evidenceEventIds ?? [],
		},
	};
}

// Shared by an order's expectation and finding. Namespaced by shopId so two tenants
// sharing an order id cannot collide (tenant isolation).
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

// Pure and idempotent: re-evaluating yields the same records, keeping createdAt,
// detectedAt and evidence from `prior`.
export function evaluateOrder(input: EvaluateInput): EvaluateResult {
	const rule = input.rule ?? DEFAULT_RULE;
	const p = input.projection;
	const prior = input.prior ?? {};

	const qualifies = p.paidAt !== undefined && p.requiresFulfillment === true;
	if (!qualifies) {
		// Unreachable for a qualifying order (the latches cannot un-pay); leave any prior finding.
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
		finding = {
			id,
			shopId: p.shopId,
			orderId: p.orderId,
			detector: rule.detector,
			ruleVersion: rule.ruleVersion,
			status: 'unconfirmed',
			detectedAt: prior.finding?.detectedAt ?? input.now,
			resolvedAt: undefined,
			evidenceEventIds: prior.finding?.evidenceEventIds ?? input.evidenceEventIds ?? [],
		};
	} else if (finding) {
		// Later evidence transitions a previously expired finding, keeping detectedAt and evidence.
		if (state === 'resolved') finding = { ...finding, status: 'resolved', resolvedAt: finding.resolvedAt ?? input.now };
		else if (state === 'suppressed') finding = { ...finding, status: 'suppressed', resolvedAt: finding.resolvedAt ?? input.now };
	}

	return { expectation, finding };
}

// Approved, non-accusatory copy. The absence detector must hedge. The presence
// detector must not: a fulfillment Shopify recorded as `error` did fail. Neither
// names a warehouse, carrier or vendor.
export function describeFinding(finding: GapFinding): string {
	if (finding.detector === DETECTOR_FAILED) {
		switch (finding.status) {
			case 'unconfirmed':
				return 'Shopify recorded a fulfillment attempt for this order that did not succeed.';
			case 'resolved':
				return 'A later fulfillment succeeded; this order is now fulfilled in Shopify.';
			case 'suppressed':
				return 'This order was cancelled or fully refunded, so the failed attempt no longer needs action.';
			default:
				return 'This order is awaiting evaluation.';
		}
	}
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
