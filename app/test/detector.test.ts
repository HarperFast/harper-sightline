import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateOrder, describeFinding, detectorKey, DEFAULT_RULE, FULFILLMENT_DEADLINE_MS } from '../src/detector.ts';
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
