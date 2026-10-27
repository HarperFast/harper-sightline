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
	settle(ms: number): Promise<void>;
}

// How long a 401 waits before the version is re-read once more, so a winner
// whose write is still landing on another thread is seen before parking.
export const SETTLE_MS = 1_000;

const realDeps: RotateDeps = {
	readVersion: async (shopId) => (await Credentials.get(shopId))?.version ?? 0,
	loadRefreshToken,
	refresh: refreshOfflineToken,
	save: saveCredential,
	recordOutcome: recordExchangeOutcome,
	markReauth: markReauthRequired,
	settle: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// One rotation per shop at a time within this worker: the reconcile and
// enrich jobs both run on the leader and would otherwise race each other.
const inFlight = new Map<string, Promise<boolean>>();

// Renew a shop's expiring offline token. In-process callers are single-flighted;
// other threads and nodes are not serialized, and every
// rotation replaces the stored refresh token, so a concurrent loser presents a
// spent one. A failure therefore re-reads the credential: a higher version means
// another rotation won and the shop is fine. Only a rejection by Shopify itself
// (401) parks the shop; any other failure is transient and propagates untouched.
export function rotateCredential(
	args: { shopId: string; shop: string; apiKey: string; secret: string },
	deps: RotateDeps = realDeps,
): Promise<boolean> {
	const existing = inFlight.get(args.shopId);
	if (existing) return existing;
	const run = rotate(args, deps).finally(() => inFlight.delete(args.shopId));
	inFlight.set(args.shopId, run);
	return run;
}

async function rotate(args: { shopId: string; shop: string; apiKey: string; secret: string }, deps: RotateDeps): Promise<boolean> {
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
		await deps.settle(SETTLE_MS);
		if ((await deps.readVersion(args.shopId)) > startVersion) return true;
		await deps.markReauth(args.shopId);
		return false;
	}
}
