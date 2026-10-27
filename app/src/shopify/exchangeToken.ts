import { ADMIN_TIMEOUT_MS } from './adminApi.ts';

// Shopify token exchange + refresh for expiring OFFLINE access tokens
// (ADR-001, contract §2). Promoted from Spike A. The offline token is obtained
// by exchanging a verified session token; expiring tokens are later renewed via
// the refresh token.

export interface OfflineToken {
	accessToken: string;
	scope: string;
	expiresIn: number;
	refreshToken: string;
	refreshTokenExpiresIn: number;
	obtainedAt: number; // epoch seconds
}

function parse(json: Record<string, unknown>): OfflineToken {
	return {
		accessToken: String(json.access_token ?? ''),
		scope: String(json.scope ?? ''),
		expiresIn: Number(json.expires_in ?? 0),
		refreshToken: String(json.refresh_token ?? ''),
		refreshTokenExpiresIn: Number(json.refresh_token_expires_in ?? 0),
		obtainedAt: Math.floor(Date.now() / 1000),
	};
}

function mapError(status: number, op: string): Error & { statusCode: number } {
	const e = new Error(`shopify ${op} failed: ${status}`) as Error & { statusCode: number };
	// 400/401 → the shop must re-authorize; other errors are upstream/transient.
	e.statusCode = status === 400 || status === 401 ? 401 : 502;
	return e;
}

// Exchange a verified session token for an expiring offline access token.
export async function exchangeOfflineToken(args: {
	shop: string;
	sessionToken: string;
	apiKey: string;
	secret: string;
	expiring?: boolean;
}): Promise<OfflineToken> {
	const body = new URLSearchParams({
		client_id: args.apiKey,
		client_secret: args.secret,
		grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
		subject_token: args.sessionToken,
		subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
		requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
		expiring: args.expiring === false ? '0' : '1',
	});
	const res = await fetch(`https://${args.shop}/admin/oauth/access_token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
		body,
		signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS),
	});
	if (!res.ok) throw mapError(res.status, 'token exchange');
	return parse((await res.json()) as Record<string, unknown>);
}

// Renew an expiring offline token using its refresh token.
// NOTE: confirm the exact refresh grant params against Shopify's offline-access-
// tokens docs at real-install time; the request shape is unit-tested here.
export async function refreshOfflineToken(args: {
	shop: string;
	refreshToken: string;
	apiKey: string;
	secret: string;
}): Promise<OfflineToken> {
	const body = new URLSearchParams({
		client_id: args.apiKey,
		client_secret: args.secret,
		grant_type: 'refresh_token',
		refresh_token: args.refreshToken,
	});
	const res = await fetch(`https://${args.shop}/admin/oauth/access_token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
		body,
		signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS),
	});
	if (!res.ok) throw mapError(res.status, 'token refresh');
	return parse((await res.json()) as Record<string, unknown>);
}
