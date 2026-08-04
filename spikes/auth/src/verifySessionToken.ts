import { createHmac, timingSafeEqual } from 'node:crypto';
import { AuthError } from './AuthError.ts';

export type Principal = {
	shopId: string;
	userId: string;
	roles: string[];
	source: 'shopify-session';
};

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

export function verifySessionToken(token: string, opts: VerifyOpts): Principal {
	const leeway = opts.leewaySeconds ?? 5;
	const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);

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
