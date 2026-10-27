import { exchangeOfflineToken } from './exchangeToken.ts';
import { saveCredential, deleteCredential, markCredentialStatus } from './credentialStore.ts';
import { Shops, Credentials, DigestSubscriptions } from '../db.ts';
import type { Shop } from '../domain/model.ts';

// app/uninstalled: mark inactive and invalidate the credential.
export async function uninstallShop(shopId: string): Promise<void> {
	const shop = await Shops.get(shopId);
	if (shop) await Shops.patch(shopId, { status: 'uninstalled', uninstalledAt: Date.now() });
	await deleteCredential(shopId);
	// Stop notifying at once; delete (not pause), since the address is data we no longer need.
	try {
		await DigestSubscriptions.delete(shopId);
	} catch {
		// no subscription — nothing to clear
	}
}

export async function markReauthRequired(shopId: string): Promise<void> {
	await Shops.patch(shopId, { status: 'reauthorization_required' });
	await markCredentialStatus(shopId, 'reauthorization_required');
}

// What the Shop record learns from a token exchange. Pure and exported because it is
// the only part of ensureCredential a test can reach (table handles come from
// `../db.ts`, inert under `node --test`).
//
//  1. `scopes`: the granted list arrives with the token and this is the only path
//     that sees it on a managed install (no OAuth callback); without it the Privacy
//     screen has nothing to show.
//  2. `status`: saveCredential resets the credential but not the shop, and
//     runReconcileSweep only iterates status:'active', so without this one refresh
//     failure would stop background reconciliation permanently.
//
// Only the reauth state is lifted (an uninstalled shop is never resurrected by an app
// load), and an unchanged scope string writes nothing.
export function shopPatchAfterExchange(shop: Shop | undefined, scope: string): Partial<Shop> | undefined {
	if (!shop) return undefined;
	const patch: Partial<Shop> = {};
	if (shop.status === 'reauthorization_required') patch.status = 'active';
	if (scope && scope !== shop.scopes) patch.scopes = scope;
	return Object.keys(patch).length ? patch : undefined;
}

// Called on every path where a token arrives (ensureCredential, rotateCredential) so
// the recorded scope list cannot go stale on one path.
export async function recordExchangeOutcome(shopId: string, scope: string): Promise<void> {
	const shop = await Shops.get(shopId);
	const patch = shopPatchAfterExchange(shop, scope);
	if (patch) await Shops.patch(shopId, patch);
}

// Bootstraps the offline Admin API credential from a verified session token (a
// managed install has no OAuth callback). Best-effort: callers must not fail the
// request when it fails; the next load retries. Webhook capture works without it.
export async function ensureCredential(args: {
	shop: string;
	sessionToken: string;
	apiKey: string;
	secret: string;
}): Promise<'exists' | 'created' | 'failed'> {
	const existing = await Credentials.get(args.shop);
	if (existing?.status === 'active' && (existing.expiresAt ?? 0) > Date.now() + 60_000) return 'exists';
	try {
		const tok = await exchangeOfflineToken({ shop: args.shop, sessionToken: args.sessionToken, apiKey: args.apiKey, secret: args.secret });
		await saveCredential(args.shop, tok);
		await recordExchangeOutcome(args.shop, tok.scope);
		return 'created';
	} catch {
		return 'failed';
	}
}

// Ensures a Shop row exists without a token exchange, so the first authenticated call works.
export async function ensureShopRecord(shopId: string): Promise<void> {
	const shop = await Shops.get(shopId);
	if (!shop) {
		await Shops.put({ shopId, status: 'active', installedAt: Date.now(), reconciliationState: 'pending' });
	}
}
