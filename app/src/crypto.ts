import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { requireRealSecrets, InsecureSecretError } from './secretsPolicy.ts';

// Envelope encryption for Shopify tokens at rest (ADR-001, plan §12). AES-256-GCM
// with a versioned key. The key comes from deployment secret management in prod
// (SIGHTLINE_TOKEN_KEY = 32-byte hex); a deterministic DEV key is used otherwise.
// With SIGHTLINE_REQUIRE_SECRETS=1 the deterministic dev key is refused, so tokens
// are never encrypted at rest under a publicly-derivable key (fails closed).
const KEY_VERSION = 1;

function key(): Buffer {
	const hex = process.env.SIGHTLINE_TOKEN_KEY;
	if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
	if (requireRealSecrets()) throw new InsecureSecretError('token encryption key (SIGHTLINE_TOKEN_KEY)');
	// DEV fallback — REMOVE BEFORE PROD (see readSecret.ts custody note).
	return createHash('sha256').update('sightline-dev-token-key').digest();
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
