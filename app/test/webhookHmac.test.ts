import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyWebhookHmac } from '../src/shopify/webhookHmac.ts';

const SECRET = 'shpss_test';
const body = '{"id":123,"topic":"orders/paid"}';
const goodHmac = createHmac('sha256', SECRET).update(Buffer.from(body, 'utf8')).digest('base64');

test('accepts a valid HMAC', () => {
	assert.equal(verifyWebhookHmac(body, goodHmac, SECRET), true);
});

test('rejects a wrong HMAC', () => {
	assert.equal(verifyWebhookHmac(body, Buffer.from('nope').toString('base64'), SECRET), false);
});

test('rejects a tampered body', () => {
	assert.equal(verifyWebhookHmac(body + 'x', goodHmac, SECRET), false);
});

test('rejects a missing header', () => {
	assert.equal(verifyWebhookHmac(body, null, SECRET), false);
});

test('rejects the wrong secret', () => {
	assert.equal(verifyWebhookHmac(body, goodHmac, 'other-secret'), false);
});
