import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventKind } from '../src/domain/eventKind.ts';

// Every case below is derived from what src/shopify/reconcile.ts and src/ingest/normalize.ts
// actually write, not copied from a brief:
//   reconciliation (src/shopify/reconcile.ts synthesizeEvents):
//     paid      → domain 'order',       topic 'orders/paid',      state 'paid'
//     refunded  → domain 'order',       topic (none),             state 'refunded'
//     cancelled → domain 'order',       topic 'orders/cancelled', state 'cancelled'
//     fulfilled → domain 'fulfillment', topic (none),             state 'success'
//   webhook (src/ingest/normalize.ts):
//     normalizeOrder (orders/paid topic, financial_status 'paid'):
//                 domain 'order', topic 'orders/paid', state 'paid'
//     normalizeRefund (refunds/create topic):
//                 domain 'refund', topic 'refunds/create', state 'refunded'
//     normalizeOrder (orders/cancelled topic; financial_status is whatever it
//     was at cancellation, e.g. 'voided' — NOT the literal 'cancelled'):
//                 domain 'order', topic 'orders/cancelled', state 'voided'
//     normalizeFulfillment (fulfillments/update topic, status 'success'):
//                 domain 'fulfillment', topic 'fulfillments/update', state 'success'

test('each reconciliation kind maps to its own kind string', () => {
	assert.equal(eventKind({ domain: 'order', topic: 'orders/paid', state: 'paid' }), 'paid');
	assert.equal(eventKind({ domain: 'order', topic: undefined, state: 'refunded' }), 'refunded');
	assert.equal(eventKind({ domain: 'order', topic: 'orders/cancelled', state: 'cancelled' }), 'cancelled');
	assert.equal(eventKind({ domain: 'fulfillment', topic: undefined, state: 'success' }), 'fulfilled');
});

test('the webhook equivalent of each reconciliation kind collapses to the SAME kind string', () => {
	// A webhook 'paid' and a reconciliation 'paid' for the same order must
	// produce one key — that collapse is the entire point of this helper.
	assert.equal(eventKind({ domain: 'order', topic: 'orders/paid', state: 'paid' }), 'paid');
	// normalizeRefund's domain is 'refund', not reconciliation's 'order' — the
	// two sources disagree about domain for this kind, so the match must not
	// depend on domain.
	assert.equal(eventKind({ domain: 'refund', topic: 'refunds/create', state: 'refunded' }), 'refunded');
	// normalizeOrder cannot set state to 'cancelled' (financial_status has no
	// such value) — only `topic` distinguishes a cancellation webhook, so the
	// state carried is a real, unrelated financial_status.
	assert.equal(eventKind({ domain: 'order', topic: 'orders/cancelled', state: 'voided' }), 'cancelled');
	assert.equal(eventKind({ domain: 'fulfillment', topic: 'fulfillments/update', state: 'success' }), 'fulfilled');
});

test('an order updated to paid via orders/updated (no orders/paid topic) still maps to paid', () => {
	// Shopify does not exclusively use the orders/paid topic for a payment
	// transition; a routine orders/updated delivery carrying financial_status
	// 'paid' is the same real change and must match on `state` alone.
	assert.equal(eventKind({ domain: 'order', topic: 'orders/updated', state: 'paid' }), 'paid');
});

test('an event with no field this function recognizes returns undefined, never a fallback string', () => {
	assert.equal(eventKind({ domain: 'inventory', topic: 'inventory_levels/update', state: undefined }), undefined);
	assert.equal(eventKind({ domain: 'order', topic: 'orders/updated', state: 'pending' }), undefined);
	assert.equal(eventKind({ domain: 'order', topic: 'orders/updated', state: undefined }), undefined);
});

test('partially_refunded is not the same claim as refunded and is not matched', () => {
	// The safety bias: an unclear or lesser state must fall through to
	// undefined rather than being folded into the nearest label.
	assert.equal(eventKind({ domain: 'order', topic: 'orders/updated', state: 'partially_refunded' }), undefined);
});

test('a cancelled fulfillment attempt (domain fulfillment, state cancelled) is not mistaken for a cancelled order', () => {
	// Fulfillment status vocabulary also contains 'cancelled', but that is a
	// cancelled fulfillment ATTEMPT, not the order-cancellation kind — only
	// `topic === 'orders/cancelled'` may set that kind.
	assert.equal(eventKind({ domain: 'fulfillment', topic: undefined, state: 'cancelled' }), undefined);
});

test('the function does not depend on `source` — feeding the same fields with either source value yields the same kind', () => {
	const webhookFields = { domain: 'order', topic: 'orders/paid', state: 'paid', source: 'webhook' } as const;
	const reconciliationFields = { domain: 'order', topic: 'orders/paid', state: 'paid', source: 'reconciliation' } as const;
	assert.equal(eventKind(webhookFields), eventKind(reconciliationFields));
	assert.equal(eventKind(webhookFields), 'paid');
});
