import { Credentials } from '../db.ts';
import { loadRefreshToken, saveCredential } from './credentialStore.ts';
import { refreshOfflineToken } from './exchangeToken.ts';
import { markReauthRequired, recordExchangeOutcome } from './lifecycle.ts';
import { isAuthError } from './accessToken.ts';

export interface RotateDeps {
	readVersion(shopId: string): Promise<number>;
	loadRefreshToken: typeof loadRefreshToken;
	refresh: typeof refreshOfflineToken;
	save: typeof saveCredential;
	recordOutcome: typeof recordExchangeOutcome;
	markReauth: typeof markReauthRequired;
}

const realDeps: RotateDeps = {
	readVersion: async (shopId) => (await Credentials.get(shopId))?.version ?? 0,
	loadRefreshToken,
	refresh: refreshOfflineToken,
	save: saveCredential,
	recordOutcome: recordExchangeOutcome,
	markReauth: markReauthRequired,
};

// Renew a shop's expiring offline token. Nothing serializes callers (the
// reconcile and inventory-enrich jobs both rotate the same shop), and every
// rotation replaces the stored refresh token, so a concurrent loser presents a
// spent one. A failure therefore re-reads the credential: a higher version means
// another rotation won and the shop is fine. Only a rejection by Shopify itself
// (401) parks the shop; any other failure is transient and propagates untouched.
export async function rotateCredential(
	args: { shopId: string; shop: string; apiKey: string; secret: string },
	deps: RotateDeps = realDeps,
): Promise<boolean> {
	const startVersion = await deps.readVersion(args.shopId);
	const refreshToken = await deps.loadRefreshToken(args.shopId);
	if (!refreshToken) {
		await deps.markReauth(args.shopId);
		return false;
	}
	try {
		const tok = await deps.refresh({ shop: args.shop, refreshToken, apiKey: args.apiKey, secret: args.secret });
		await deps.save(args.shopId, tok);
		// A refresh carries the granted scope list too, so the same recording happens
		// here as on the first exchange — otherwise a shop's scopes would be whatever
		// they were at install and could silently go stale.
		await deps.recordOutcome(args.shopId, tok.scope);
		return true;
	} catch (err) {
		if ((await deps.readVersion(args.shopId)) > startVersion) return true;
		if (!isAuthError(err)) throw err;
		await deps.markReauth(args.shopId);
		return false;
	}
}
