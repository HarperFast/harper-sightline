import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	evaluateOrder,
	describeFinding,
	detectorKey,
	DEFAULT_RULE,
	DETECTOR,
	FULFILLMENT_DEADLINE_MS,
	DETECTOR_FAILED,
	FAILED_RULE,
	evaluateFailedFulfillment,
} from '../src/detector.ts';
import type { Expectation, GapFinding, OrderProjection } from '../src/model.ts';

const PAID = 1_000_000_000_000;
const DUE = PAID + FULFILLMENT_DEADLINE_MS; // the moment the deadline is reached
const KEY = detectorKey('s', 'o1');

function projection(over: Partial<OrderProjection> = {}): OrderProjection {
	return { id: 's:o1', shopId: 's', orderId: 'o1', paidAt: PAID, requiresFulfillment: true, ...over };
}

function evaluate(over: Partial<OrderProjection>, now: number, prior?: { expectation?: Expectation; finding?: GapFinding }) {
	return evaluateOrder({ projection: projection(over), now, evidenceEventIds: ['s:wh1', 's:wh2'], prior });
}

test('no expectation for an unpaid order', () => {
	const r = evaluateOrder({ projection: projection({ paidAt: undefined }), now: DUE });
	assert.equal(r.expectation, null);
	assert.equal(r.finding, null);
});

test('no expectation for a paid but fulfillment-ineligible (digital) order', () => {
	const r = evaluateOrder({ projection: projection({ requiresFulfillment: false }), now: DUE });
	assert.equal(r.expectation, null);
});

test('before the deadline a qualifying order is pending, with no finding', () => {
	const r = evaluate({}, PAID + 1000);
	assert.equal(r.expectation?.state, 'pending');
	assert.equal(r.expectation?.deadline, DUE);
	assert.equal(r.expectation?.id, KEY);
	assert.equal(r.finding, null);
});

test('at/after the deadline an unconfirmed finding is created deterministically', () => {
	const r = evaluate({}, DUE);
	assert.equal(r.expectation?.state, 'expired');
	assert.equal(r.finding?.status, 'unconfirmed');
	assert.equal(r.finding?.id, KEY);
	assert.equal(r.finding?.ruleVersion, DEFAULT_RULE.ruleVersion);
	assert.deepEqual(r.finding?.evidenceEventIds, ['s:wh1', 's:wh2']);
	assert.equal(r.finding?.detectedAt, DUE);
	assert.equal(r.finding?.resolvedAt, undefined);
});

test('confirmation before the deadline resolves the expectation with no finding', () => {
	const r = evaluate({ fulfilledAt: PAID + 5000 }, PAID + 6000);
	assert.equal(r.expectation?.state, 'resolved');
	assert.equal(r.finding, null); // never expired → no finding
});

test('confirmation AFTER a finding resolves it without erasing history', () => {
	const expired = evaluate({}, DUE); // creates the finding
	const now = DUE + 10_000;
	const r = evaluate({ fulfilledAt: now }, now, { expectation: expired.expectation ?? undefined, finding: expired.finding ?? undefined });
	assert.equal(r.expectation?.state, 'resolved');
	assert.equal(r.finding?.status, 'resolved');
	assert.equal(r.finding?.detectedAt, DUE, 'original detection time preserved');
	assert.equal(r.finding?.resolvedAt, now);
	assert.deepEqual(r.finding?.evidenceEventIds, ['s:wh1', 's:wh2'], 'evidence preserved');
});

test('cancellation before the deadline suppresses without a finding', () => {
	const r = evaluate({ cancelledAt: PAID + 100 }, PAID + 200);
	assert.equal(r.expectation?.state, 'suppressed');
	assert.equal(r.finding, null);
});

test('full refund after a finding suppresses it, preserving history', () => {
	const expired = evaluate({}, DUE);
	const now = DUE + 5000;
	const r = evaluate({ fullyRefundedAt: now }, now, {
		expectation: expired.expectation ?? undefined,
		finding: expired.finding ?? undefined,
	});
	assert.equal(r.expectation?.state, 'suppressed');
	assert.equal(r.finding?.status, 'suppressed');
	assert.equal(r.finding?.detectedAt, DUE);
	assert.equal(r.finding?.resolvedAt, now);
});

test('confirmation takes precedence over the deadline', () => {
	// Both fulfilled AND past deadline → resolved (confirmation wins).
	const r = evaluate({ fulfilledAt: DUE + 1 }, DUE + 100);
	assert.equal(r.expectation?.state, 'resolved');
});

test('suppression takes precedence over the deadline', () => {
	const r = evaluate({ cancelledAt: DUE + 1 }, DUE + 100);
	assert.equal(r.expectation?.state, 'suppressed');
});

test('re-evaluation is idempotent and preserves createdAt', () => {
	const first = evaluate({}, PAID + 1000);
	const second = evaluate({}, PAID + 2000, { expectation: first.expectation ?? undefined });
	assert.equal(second.expectation?.createdAt, first.expectation?.createdAt);
	assert.equal(second.expectation?.state, 'pending');
});

test('finding copy never claims a downstream vendor failure', () => {
	for (const status of ['unconfirmed', 'resolved', 'suppressed'] as const) {
		const copy = describeFinding({ id: KEY, shopId: 's', orderId: 'o1', status }).toLowerCase();
		assert.ok(!/fail|failure|failed|vendor|blame|fault/.test(copy), `copy for ${status} implies failure: "${copy}"`);
	}
	assert.match(
		describeFinding({ id: KEY, shopId: 's', orderId: 'o1', status: 'unconfirmed' }),
		/no shopify fulfillment confirmation was observed/i,
	);
});

test('a failed fulfillment attempt yields an unconfirmed finding immediately — no deadline', () => {
	const projection = { id: 's1:o1', shopId: 's1', orderId: 'o1', paidAt: 100, requiresFulfillment: true, fulfillmentFailedAt: 200 };
	const { finding } = evaluateFailedFulfillment({ projection, now: 250, evidenceEventIds: ['s1:e2'] });
	assert.equal(finding?.status, 'unconfirmed');
	assert.equal(finding?.detector, DETECTOR_FAILED);
	assert.equal(finding?.detectedAt, 200, 'detected when the failure occurred, not when we noticed');
	assert.equal(finding?.id, detectorKey('s1', 'o1', FAILED_RULE));
	assert.deepEqual(finding?.evidenceEventIds, ['s1:e2']);
});

test('no failed attempt yields no finding', () => {
	const projection = { id: 's1:o1', shopId: 's1', orderId: 'o1', paidAt: 100, requiresFulfillment: true };
	assert.equal(evaluateFailedFulfillment({ projection, now: 250 }).finding, null);
});

test('a later success resolves the failed-attempt finding but keeps its history', () => {
	const projection = {
		id: 's1:o1',
		shopId: 's1',
		orderId: 'o1',
		paidAt: 100,
		requiresFulfillment: true,
		fulfillmentFailedAt: 200,
		fulfilledAt: 400,
	};
	const prior = {
		finding: {
			id: detectorKey('s1', 'o1', FAILED_RULE),
			shopId: 's1',
			orderId: 'o1',
			detector: DETECTOR_FAILED,
			status: 'unconfirmed' as const,
			detectedAt: 200,
			evidenceEventIds: ['s1:e2'],
		},
	};
	const { finding } = evaluateFailedFulfillment({ projection, now: 500, prior });
	assert.equal(finding?.status, 'resolved');
	assert.equal(finding?.detectedAt, 200);
	assert.deepEqual(finding?.evidenceEventIds, ['s1:e2']);
});

test('cancellation suppresses a failed-attempt finding', () => {
	const projection = {
		id: 's1:o1',
		shopId: 's1',
		orderId: 'o1',
		paidAt: 100,
		requiresFulfillment: true,
		fulfillmentFailedAt: 200,
		cancelledAt: 300,
	};
	const { finding } = evaluateFailedFulfillment({ projection, now: 400 });
	assert.equal(finding?.status, 'suppressed');
});

test('evaluating twice is idempotent', () => {
	const projection = { id: 's1:o1', shopId: 's1', orderId: 'o1', paidAt: 100, requiresFulfillment: true, fulfillmentFailedAt: 200 };
	const first = evaluateFailedFulfillment({ projection, now: 250, evidenceEventIds: ['s1:e2'] }).finding;
	const second = evaluateFailedFulfillment({ projection, now: 999, evidenceEventIds: ['s1:e2'], prior: { finding: first! } }).finding;
	assert.deepEqual(second, first);
});

test('the failed-attempt description states the observation without blaming a party, for every status', () => {
	// Widened beyond the original four terms, and checked across all three
	// statuses (not just 'unconfirmed'), so a future copy edit to the resolved/
	// suppressed strings cannot silently reintroduce a named downstream party.
	const PARTY_RE = /warehouse|carrier|vendor|3PL|supplier|logistics|partner|3rd party/i;
	for (const status of ['unconfirmed', 'resolved', 'suppressed'] as const) {
		const text = describeFinding({ id: 'x', shopId: 's1', orderId: 'o1', detector: DETECTOR_FAILED, status });
		assert.doesNotMatch(text, PARTY_RE, `copy for ${status} names a downstream party: "${text}"`);
	}
	const unconfirmed = describeFinding({ id: 'x', shopId: 's1', orderId: 'o1', detector: DETECTOR_FAILED, status: 'unconfirmed' });
	assert.match(unconfirmed, /fulfillment attempt/i);
	assert.match(unconfirmed, /Shopify/);
	// It is direct evidence, so it must NOT hedge as an absence finding does.
	assert.doesNotMatch(unconfirmed, /has not shown/i);
});

test('the absence detector description is unchanged', () => {
	const text = describeFinding({ id: 'x', shopId: 's1', orderId: 'o1', detector: DETECTOR, status: 'unconfirmed' });
	assert.equal(text, 'No Shopify fulfillment confirmation was observed for this paid, fulfillment-eligible order by the expected time.');
});

test('a finding with no detector field defaults to the absence detector copy', () => {
	const text = describeFinding({ id: 'x', shopId: 's1', orderId: 'o1', status: 'unconfirmed' });
	assert.match(text, /No Shopify fulfillment confirmation/);
});

test('the absence detector stamps its own name on what it writes', () => {
	const projection = { id: 's1:o1', shopId: 's1', orderId: 'o1', paidAt: 100, requiresFulfillment: true };
	const result = evaluateOrder({ projection, now: 100 + FULFILLMENT_DEADLINE_MS });
	assert.equal(result.finding?.detector, DETECTOR);
	assert.equal(result.expectation?.detector, DETECTOR);
});
