import { createHmac, timingSafeEqual } from 'node:crypto';
import { AuthError } from './AuthError.ts';
import type { Principal } from './principal.ts';

type VerifyOpts = {
	apiKey: string;
	secret: string;
	leewaySeconds?: number;
	nowSeconds?: number;
};

function decodeSegment(seg: string): Record<string, unknown> {
	try {
		return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
	} catch (cause) {
		throw new AuthError('malformed token segment', cause);
	}
}

function hostOf(url: unknown): string {
	if (typeof url !== 'string') throw new AuthError('missing host claim');
	try {
		return new URL(url).host;
	} catch (cause) {
		throw new AuthError('invalid host claim', cause);
	}
}

// A Shopify session token is a compact JWT with a handful of small claims — real
// ones are well under 1KB. The cap bounds the work an UNAUTHENTICATED caller can
// ask for before any of it is trusted: without it, a multi-megabyte header would be
// split, base64-decoded and JSON-parsed before the signature check could reject it
// (security review F7 — the request limiter itself keys on the verified shop, so it
// cannot bound this).
export const MAX_TOKEN_CHARS = 4096;

// Verify a Shopify App Bridge session token (HS256, signed with the app secret)
// and derive the tenant principal. See ADR-001.
export function verifySessionToken(token: string, opts: VerifyOpts): Principal {
	const leeway = opts.leewaySeconds ?? 5;
	const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);

	if (token.length > MAX_TOKEN_CHARS) throw new AuthError('token too large');
	const parts = token.split('.');
	if (parts.length !== 3) throw new AuthError('malformed token');
	const [h, p, sig] = parts;

	const header = decodeSegment(h);
	if (header.alg !== 'HS256') throw new AuthError(`unsupported alg: ${String(header.alg)}`);

	const expected = createHmac('sha256', opts.secret).update(`${h}.${p}`).digest();
	const provided = Buffer.from(sig, 'base64url');
	if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
		throw new AuthError('invalid signature');
	}

	const claims = decodeSegment(p);
	if (claims.aud !== opts.apiKey) throw new AuthError('aud mismatch');

	const issHost = hostOf(claims.iss);
	const destHost = hostOf(claims.dest);
	if (issHost !== destHost) throw new AuthError('iss/dest host mismatch');

	const exp = Number(claims.exp);
	const nbf = Number(claims.nbf);
	if (!Number.isFinite(exp) || now >= exp) throw new AuthError('token expired');
	if (Number.isFinite(nbf) && now + leeway < nbf) throw new AuthError('token not yet valid');

	if (typeof claims.sub !== 'string' && typeof claims.sub !== 'number') {
		throw new AuthError('missing sub claim');
	}

	return {
		shopId: destHost,
		userId: String(claims.sub),
		roles: [],
		source: 'shopify-session',
	};
}
