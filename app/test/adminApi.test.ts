import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	adminGraphql,
	isPermanentAdminError,
	isThrottledAdminError,
	PermanentAdminApiError,
	ThrottledAdminApiError,
} from '../src/shopify/adminApi.ts';

// C1: read_products/read_locations were added to the Admin API's scopes, but a
// scope mismatch must never look like an ordinary transient failure — it can
// never resolve on retry, unlike a rate limit or an upstream hiccup, and needs
// to be loud (error, not warn) so an operator actually sees it.

function fakeFetch(body: unknown, status = 200): typeof fetch {
	return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

test('a GraphQL access-denied error (missing scope) is permanent — no retry can ever succeed', async () => {
	const fetchImpl = fakeFetch({
		errors: [{ message: 'Access denied for inventoryItems field. Required access: `read_products` access scope or higher.' }],
	});
	await assert.rejects(
		() => adminGraphql('s.myshopify.com', 'tok', '{x}', {}, fetchImpl),
		(err: unknown) => {
			assert.ok(err instanceof PermanentAdminApiError, 'thrown as the permanent error class');
			assert.ok(isPermanentAdminError(err), 'and detectable via the duck-typed flag');
			return true;
		},
	);
});

test('a non-scope GraphQL error stays transient, not permanent', async () => {
	const fetchImpl = fakeFetch({ errors: [{ message: 'Throttled, please retry' }] });
	await assert.rejects(
		() => adminGraphql('s.myshopify.com', 'tok', '{x}', {}, fetchImpl),
		(err: unknown) => {
			assert.ok(!(err instanceof PermanentAdminApiError));
			assert.equal(isPermanentAdminError(err), false, 'a rate-limit-style error must still be retried, not treated as permanent');
			return true;
		},
	);
});

test('isPermanentAdminError is duck-typed like PermanentNormalizeError, decoupled from the class itself', () => {
	assert.equal(isPermanentAdminError({ permanent: true }), true);
	assert.equal(isPermanentAdminError(new Error('boom')), false);
	assert.equal(isPermanentAdminError(null), false);
	assert.equal(isPermanentAdminError(undefined), false);
});

// Shopify throttling is transient like any upstream blip, but it is the ONE
// transient cause the operator needs to tell apart: a throttled reconcile means
// "we are asking for more than the shop's quota allows", which is a capacity
// signal, whereas a generic error is a fault. Without a distinct class every
// throttle looked identical to a 500 in ops.snapshot's reconcile.error count.
test('an HTTP 429 is classified as throttled — transient, never permanent', async () => {
	const fetchImpl = (async () => new Response('', { status: 429 })) as unknown as typeof fetch;
	await assert.rejects(
		() => adminGraphql('s.myshopify.com', 'tok', '{x}', {}, fetchImpl),
		(err: unknown) => {
			assert.ok(err instanceof ThrottledAdminApiError, 'thrown as the throttled error class');
			assert.equal(isThrottledAdminError(err), true);
			assert.equal(isPermanentAdminError(err), false, 'a throttle always resolves on retry');
			assert.equal((err as { statusCode?: number }).statusCode, 429, 'statusCode preserved so isAuthError still declines to rotate');
			return true;
		},
	);
});

// Shopify's GraphQL throttle is an HTTP 200 carrying errors[].extensions.code,
// so the status code alone cannot see it.
test('a GraphQL THROTTLED extension code is classified as throttled despite the HTTP 200', async () => {
	const fetchImpl = fakeFetch({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] });
	await assert.rejects(
		() => adminGraphql('s.myshopify.com', 'tok', '{x}', {}, fetchImpl),
		(err: unknown) => {
			assert.equal(isThrottledAdminError(err), true);
			assert.equal(isPermanentAdminError(err), false);
			return true;
		},
	);
});

test('isThrottledAdminError is duck-typed, like the permanent-error check', () => {
	assert.equal(isThrottledAdminError({ throttled: true }), true);
	assert.equal(isThrottledAdminError(new Error('boom')), false);
	assert.equal(isThrottledAdminError(null), false);
	assert.equal(isThrottledAdminError(undefined), false);
});

test('a non-throttle GraphQL error is not misclassified as throttled', async () => {
	const fetchImpl = fakeFetch({ errors: [{ message: 'Internal error', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] });
	await assert.rejects(
		() => adminGraphql('s.myshopify.com', 'tok', '{x}', {}, fetchImpl),
		(err: unknown) => {
			assert.equal(isThrottledAdminError(err), false);
			return true;
		},
	);
});

test('an HTTP-level failure (statusCode) is unaffected — it is not routed through the GraphQL-error path', async () => {
	const fetchImpl = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
	await assert.rejects(
		() => adminGraphql('s.myshopify.com', 'tok', '{x}', {}, fetchImpl),
		(err: unknown) => {
			assert.equal(isPermanentAdminError(err), false);
			assert.equal((err as { statusCode?: number }).statusCode, 500);
			return true;
		},
	);
});
