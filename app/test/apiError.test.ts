import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorDetail } from '../web/src/api.ts';

// A failed read has to say something: Harper reports `{type, code, title, status,
// instance}` and our own resources throw a plain message that serializes as a bare
// JSON string, and the client must read both.

test('a Harper error body surfaces its title', () => {
	assert.equal(
		errorDetail({
			type: 'error:Error',
			code: 'Error',
			title: 'An "or" operator requires at least two conditions',
			status: 500,
			instance: '/api/v1/events/shop.myshopify.com%3Aseed-1',
		}),
		'An "or" operator requires at least two conditions',
	);
});

test('a bare string body, an {error} body, and a {message} body all read through', () => {
	assert.equal(errorDetail('Error: event not found'), 'Error: event not found');
	assert.equal(errorDetail({ error: 'event not found' }), 'event not found');
	assert.equal(errorDetail({ message: 'event not found' }), 'event not found');
	assert.equal(errorDetail({ title: 'first', error: 'second' }), 'first', 'title wins — it is what Harper populates');
});

test('an unreadable body yields nothing, so the status alone is still shown', () => {
	for (const body of [undefined, null, {}, [], 42, { title: '' }, { title: '   ' }, { title: 7 }]) {
		assert.equal(errorDetail(body), '', `expected no detail from ${JSON.stringify(body)}`);
	}
});
