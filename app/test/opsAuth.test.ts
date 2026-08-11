import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opsTokenAccepted, OPS_TOKEN_MIN_LENGTH } from '../src/opsAuth.ts';

// The ops endpoint exposes cross-shop operational counts (backlog, dead letters,
// reconcile staleness). No merchant-identifying data — computeOpsHealth is built
// that way — but it is still operator surface on a public host, so the gate fails
// closed in every ambiguous case rather than defaulting open.

const VALID = 'k'.repeat(OPS_TOKEN_MIN_LENGTH);

test('accepts a caller whose token matches the configured one exactly', () => {
	assert.equal(opsTokenAccepted(VALID, VALID), true);
});

test('rejects a mismatched token', () => {
	assert.equal(opsTokenAccepted(`${'x'.repeat(OPS_TOKEN_MIN_LENGTH)}`, VALID), false);
});

// Fails closed when unconfigured: an environment that never opted in must not be
// reachable by guessing the empty string.
test('rejects everything when no token is configured', () => {
	assert.equal(opsTokenAccepted('', undefined), false);
	assert.equal(opsTokenAccepted('', ''), false);
	assert.equal(opsTokenAccepted(VALID, undefined), false);
	assert.equal(opsTokenAccepted(VALID, ''), false);
});

test('rejects a missing header even when a token is configured', () => {
	assert.equal(opsTokenAccepted(undefined, VALID), false);
	assert.equal(opsTokenAccepted(null, VALID), false);
	assert.equal(opsTokenAccepted('', VALID), false);
});

// A length difference must be a plain false, not the throw node's timingSafeEqual
// raises on unequal buffers — otherwise a short guess becomes a 500 that both
// leaks "wrong length" and looks like a server fault.
test('a length mismatch is a clean rejection, not a thrown error', () => {
	assert.equal(opsTokenAccepted(VALID.slice(0, -1), VALID), false);
	assert.equal(opsTokenAccepted(`${VALID}extra`, VALID), false);
});

// A weak configured token is treated as "not configured": with a gate this simple
// the token's length IS the security, so accepting a 3-character one would be a
// false sense of protection.
test('refuses to honour a configured token shorter than the minimum', () => {
	const weak = 'short';
	assert.ok(weak.length < OPS_TOKEN_MIN_LENGTH);
	assert.equal(opsTokenAccepted(weak, weak), false);
});

test('the minimum length is long enough to be unguessable', () => {
	assert.ok(OPS_TOKEN_MIN_LENGTH >= 32);
});
