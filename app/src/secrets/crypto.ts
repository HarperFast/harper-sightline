import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { requiredSecret, MissingSecretError } from './secretsPolicy.ts';

// Envelope encryption for Shopify tokens at rest (ADR-001): AES-256-GCM with a
// versioned key from `SIGHTLINE_TOKEN_KEY` (see secretsPolicy.ts for the read order).
// There is no fallback key: no key means no encryption and no decryption.
//
// KEY_VERSION is stamped into every envelope so the key can be rotated, but rotation
// is a data migration: this reader resolves one key, so re-keying needs a dual-key
// decrypt path and a re-encrypt sweep that do not exist yet. Rotating the key today
// makes every stored token undecryptable and forces reauthorization for every shop.
const KEY_VERSION = 1;

function key(): Buffer {
	const hex = requiredSecret('SIGHTLINE_TOKEN_KEY');
	// A wrong-shaped key (a typo'd or truncated paste) is its own failure, never ignored.
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
