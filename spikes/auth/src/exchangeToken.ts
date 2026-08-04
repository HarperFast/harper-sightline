export type OfflineToken = {
	accessToken: string;
	scope: string;
	expiresIn: number;
	refreshToken: string;
	refreshTokenExpiresIn: number;
	obtainedAt: number;
};

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
	});
	if (!res.ok) {
		const e = new Error(`token exchange failed: ${res.status}`) as Error & { statusCode: number };
		e.statusCode = res.status === 400 || res.status === 401 ? 401 : 502;
		throw e;
	}
	const json = (await res.json()) as Record<string, unknown>;
	return {
		accessToken: String(json.access_token),
		scope: String(json.scope ?? ''),
		expiresIn: Number(json.expires_in ?? 0),
		refreshToken: String(json.refresh_token ?? ''),
		refreshTokenExpiresIn: Number(json.refresh_token_expires_in ?? 0),
		obtainedAt: Math.floor(Date.now() / 1000),
	};
}
