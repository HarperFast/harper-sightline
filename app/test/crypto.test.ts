import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptToken, decryptToken } from '../src/secrets/crypto.ts';

// A valid key must be present: an unset SIGHTLINE_TOKEN_KEY throws (secretsPolicy.test.ts
// covers that), and the round-trip properties below just need one.
process.env.SIGHTLINE_TOKEN_KEY ??= 'a'.repeat(64);

test('encrypts and decrypts a token round-trip', () => {
	const env = encryptToken('shpat_secret_value');
	assert.equal(env.v, 1);
	assert.notEqual(env.ct, 'shpat_secret_value');
	assert.equal(decryptToken(env), 'shpat_secret_value');
});

test('detects tampering via the GCM auth tag', () => {
	const env = encryptToken('x');
	const tampered = { ...env, ct: Buffer.from('not-the-ciphertext').toString('base64') };
	assert.throws(() => decryptToken(tampered));
});
