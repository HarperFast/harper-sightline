import { createHmac } from 'node:crypto';

const b64url = (buf: Buffer | string): string => Buffer.from(buf).toString('base64url');

export function mintToken(claims: Record<string, unknown>, opts: { secret: string; alg?: string }): string {
	const header = { alg: opts.alg ?? 'HS256', typ: 'JWT' };
	const h = b64url(JSON.stringify(header));
	const p = b64url(JSON.stringify(claims));
	const sig = createHmac('sha256', opts.secret).update(`${h}.${p}`).digest('base64url');
	return `${h}.${p}.${sig}`;
}

export function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const now = Math.floor(Date.now() / 1000);
	return {
		iss: 'https://demo-shop.myshopify.com/admin',
		dest: 'https://demo-shop.myshopify.com',
		aud: 'e446bda5edb3ee3bae6e0ba280ef8b12',
		sub: '42',
		exp: now + 60,
		nbf: now - 5,
		iat: now - 5,
		jti: 'abc',
		sid: 'sess-1',
		...overrides,
	};
}
