import { createHmac, timingSafeEqual } from 'node:crypto';

// Verifies a Shopify webhook HMAC (base64 HMAC-SHA256, app secret) in constant time.
// It must run on the untouched raw bytes: a re-serialized body will not match.
export function verifyWebhookHmac(rawBody: Buffer | string, hmacHeader: string | null, secret: string): boolean {
	if (!hmacHeader) return false;
	const bytes = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
	const expected = createHmac('sha256', secret).update(bytes).digest();
	let provided: Buffer;
	try {
		provided = Buffer.from(hmacHeader, 'base64');
	} catch {
		return false;
	}
	return provided.length === expected.length && timingSafeEqual(provided, expected);
}
