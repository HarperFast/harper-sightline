import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { requiredSecret, MissingSecretError } from './secretsPolicy.ts';

// Envelope encryption for Shopify tokens at rest (ADR-001, plan §12). AES-256-GCM
// with a versioned key, read from `SIGHTLINE_TOKEN_KEY` — a scoped Harper secret
// in production, `process.env` in dev/CI (see secretsPolicy.ts for the read order
// and why the store comes first).
//
// This was the worst of the two dev fallbacks and the one that was not using the
// secrets manager at all: the key was read from `process.env` only, and anything
// else fell back to `sha256('sightline-dev-token-key')` — a key any reader of
// this file can regenerate — while still encrypting real Shopify offline tokens.
// Ciphertext under a publicly derivable key is plaintext with extra steps, so
// there is now no fallback: no key means no token encryption and no token
// decryption, loudly.
//
// KEY_VERSION is stamped into every envelope precisely so the key CAN be rotated
// later. Note that rotation is a data migration, not a config change: this reader
// resolves exactly one key, so re-keying needs a dual-key decrypt path (try v2,
// fall back to v1) plus a re-encrypt sweep over the credential table. That does
// not exist yet — rotating SIGHTLINE_TOKEN_KEY today makes every stored token
// undecryptable, forcing a reauthorization for every shop.
const KEY_VERSION = 1;

function key(): Buffer {
	const hex = requiredSecret('SIGHTLINE_TOKEN_KEY');
	// A wrong-shaped key is reported as its own failure rather than being ignored.
	// The old reader tested the format inline and silently fell through on a
	// mismatch, so a typo'd or truncated key — the realistic mistake when pasting
	// 64 hex characters — quietly produced tokens encrypted under the dev key
	// instead of telling anyone the configured key was never used.
	if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
		throw new MissingSecretError('SIGHTLINE_TOKEN_KEY', `expected 64 hex characters (32 bytes), got ${hex.length}`);
	}
	return Buffer.from(hex, 'hex');
}

export interface Envelope {
	v: number;
	iv: string;
	tag: string;
	ct: string;
}

export function encryptToken(plaintext: string): Envelope {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key(), iv);
	const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	return {
		v: KEY_VERSION,
		iv: iv.toString('base64'),
		tag: cipher.getAuthTag().toString('base64'),
		ct: ct.toString('base64'),
	};
}

export function decryptToken(env: Envelope): string {
	const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(env.iv, 'base64'));
	decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
	return Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]).toString('utf8');
}
