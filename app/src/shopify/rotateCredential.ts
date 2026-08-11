import { loadRefreshToken, saveCredential } from './credentialStore.ts';
import { refreshOfflineToken } from './exchangeToken.ts';
import { markReauthRequired } from './lifecycle.ts';

// Renew a shop's expiring offline token. Runs under the single-active worker
// lease (ADR-002), so no compare-and-swap is needed for safety — rotation for a
// given shop is serialized through one owner (Harper documents no CAS write; the
// lease is the concurrency control). On failure the shop moves to
// reauthorization_required and Admin API jobs stop.
export async function rotateCredential(args: { shopId: string; shop: string; apiKey: string; secret: string }): Promise<boolean> {
	const refreshToken = await loadRefreshToken(args.shopId);
	if (!refreshToken) {
		await markReauthRequired(args.shopId);
		return false;
	}
	try {
		const tok = await refreshOfflineToken({ shop: args.shop, refreshToken, apiKey: args.apiKey, secret: args.secret });
		await saveCredential(args.shopId, tok);
		return true;
	} catch {
		await markReauthRequired(args.shopId);
		return false;
	}
}
