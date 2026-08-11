import { createHmac, timingSafeEqual } from 'node:crypto';

// Verify a Shopify webhook HMAC over the RAW request body (base64 HMAC-SHA256
// with the app secret), constant-time. MUST run on the untouched bytes before
// any JSON parsing — a re-serialized body will not match (plan §12).
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
