import { test } from 'node:test';
import assert from 'node:assert/strict';
import { httpError, parseUrl, trailingId, numParam } from '../src/resources/http.ts';

// These helpers used to live inside resources.ts, which cannot be imported under
// `node --test` (it imports the `harper` runtime). Splitting the resources into
// src/resources/ put them in a module free of that import, so the parsing every
// route depends on is now directly testable.

test('parseUrl falls back to a root URL for a missing or unparseable url', () => {
	assert.equal(parseUrl('/api/v1/events?limit=5').pathname, '/api/v1/events');
	assert.equal(parseUrl('/api/v1/events?limit=5').searchParams.get('limit'), '5');
	assert.equal(parseUrl(undefined).pathname, '/');
	assert.equal(parseUrl('http://[').pathname, '/');
});

test('trailingId returns the single decoded segment after the base, else undefined', () => {
	assert.equal(trailingId('/api/v1/events/abc', '/api/v1/events'), 'abc');
	assert.equal(trailingId('/api/v1/events/gid%3A%2F%2Fshopify%2FOrder%2F1', '/api/v1/events'), 'gid://shopify/Order/1');
	// The collection itself, a deeper path, and a different base are all "no id".
	assert.equal(trailingId('/api/v1/events', '/api/v1/events'), undefined);
	assert.equal(trailingId('/api/v1/events/', '/api/v1/events'), undefined);
	assert.equal(trailingId('/api/v1/events/a/b', '/api/v1/events'), undefined);
	assert.equal(trailingId('/api/v1/findings/abc', '/api/v1/events'), undefined);
	// An invalid escape must not throw — the raw segment is used instead.
	assert.equal(trailingId('/api/v1/events/%E0%A4%A', '/api/v1/events'), '%E0%A4%A');
});

test('numParam accepts only finite numbers, so a junk filter is dropped not NaN', () => {
	const p = new URLSearchParams({ since: '1700000000000', bad: 'abc', empty: '', zero: '0', inf: 'Infinity' });
	assert.equal(numParam(p, 'since'), 1700000000000);
	assert.equal(numParam(p, 'zero'), 0);
	assert.equal(numParam(p, 'missing'), undefined);
	assert.equal(numParam(p, 'bad'), undefined);
	assert.equal(numParam(p, 'inf'), undefined);
	// An empty value coerces to 0 in JS; documented here because a filter of 0 and
	// an absent filter are different queries.
	assert.equal(numParam(p, 'empty'), 0);
});

test('httpError carries the statusCode Harper maps to the response', () => {
	const e = httpError('event not found', 404);
	assert.equal(e.message, 'event not found');
	assert.equal(e.statusCode, 404);
	assert.ok(e instanceof Error);
});
