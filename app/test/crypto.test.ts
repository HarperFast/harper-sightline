import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptToken, decryptToken } from '../src/secrets/crypto.ts';

// These tests must now supply a key. They used to pass with none configured
// because crypto.ts fell back to sha256('sightline-dev-token-key') — the exact
// behaviour that made a misconfigured production deploy encrypt real Shopify
// tokens under a publicly derivable key. With the fallback gone, an unset
// SIGHTLINE_TOKEN_KEY throws; secretsPolicy.test.ts covers that path, and the
// round-trip properties below just need a valid key present.
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
