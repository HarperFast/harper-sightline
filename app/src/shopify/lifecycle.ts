import { exchangeOfflineToken } from './exchangeToken.ts';
import { saveCredential, deleteCredential, markCredentialStatus } from './credentialStore.ts';
import { Shops, Credentials, DigestSubscriptions } from '../db.ts';
import type { Shop } from '../domain/model.ts';

// app/uninstalled: mark inactive and invalidate the credential (documented
// redaction timing handled by the compliance flow, #20/#21).
export async function uninstallShop(shopId: string): Promise<void> {
	const shop = await Shops.get(shopId);
	if (shop) await Shops.patch(shopId, { status: 'uninstalled', uninstalledAt: Date.now() });
	await deleteCredential(shopId);
	// Stop notifying an uninstalled shop at once. Deleting (not pausing) is right:
	// the address is merchant data we no longer have a reason to hold.
	try {
		await DigestSubscriptions.delete(shopId);
	} catch {
		// no subscription — nothing to clear
	}
}

// Refresh failure → stop Admin API jobs, surface reauthorization_required.
export async function markReauthRequired(shopId: string): Promise<void> {
	await Shops.patch(shopId, { status: 'reauthorization_required' });
	await markCredentialStatus(shopId, 'reauthorization_required');
}

// What the Shop record has to learn from a successful token exchange. Pure, and
// exported, because it is the only part of ensureCredential a test can reach — the
// table handles come from module scope (`../db.ts`), which is inert under
// `node --test`.
//
// Two separate facts, deliberately in one patch (one write, and neither can be
// applied without the other's context):
//
//  1. `scopes` — the granted scope list arrives WITH the token, and this is the
//     only path that ever sees it on a managed install (there is no OAuth
//     callback). Without recording it here the Shop row keeps an empty `scopes`
//     forever and the Privacy screen's "Granted access" field has nothing to show.
//  2. `status` — saveCredential resets the CREDENTIAL to active, but nothing resets
//     the SHOP, and runReconcileSweep only iterates status:'active'. Without this a
//     single refresh failure would park the shop in reauthorization_required
//     permanently: the merchant re-opens the app, the credential recovers, and
//     background reconciliation still never resumes.
//
// Only the reauth state is lifted — an UNINSTALLED shop must never be resurrected
// by an app load — and an unchanged scope string writes nothing, so a routine
// re-exchange is not a write.
export function shopPatchAfterExchange(shop: Shop | undefined, scope: string): Partial<Shop> | undefined {
	if (!shop) return undefined;
	const patch: Partial<Shop> = {};
	if (shop.status === 'reauthorization_required') patch.status = 'active';
	if (scope && scope !== shop.scopes) patch.scopes = scope;
	return Object.keys(patch).length ? patch : undefined;
}

// Apply that patch. Called from every path where a token arrives — the first
// exchange (ensureCredential) and each later refresh (rotateCredential) — so the
// recorded scope list cannot go stale on one path and be correct on the other.
export async function recordExchangeOutcome(shopId: string, scope: string): Promise<void> {
	const shop = await Shops.get(shopId);
	const patch = shopPatchAfterExchange(shop, scope);
	if (patch) await Shops.patch(shopId, patch);
}

// Bootstrap the offline Admin API credential from a verified session token, once
// (managed install has no OAuth callback, so we exchange the id_token the first
// time we see one and no active credential exists). Best-effort: returns the
// outcome; callers must not fail the request when the exchange fails (e.g. a
// stale id_token) — the next load retries. The Admin token enables reconciliation
// (#13); webhook capture works without it.
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

// Safe bootstrap on an authenticated request: ensure a Shop row exists. Does NOT
// do token exchange, so it works on the first authenticated call regardless.
export async function ensureShopRecord(shopId: string): Promise<void> {
	const shop = await Shops.get(shopId);
	if (!shop) {
		await Shops.put({ shopId, status: 'active', installedAt: Date.now(), reconciliationState: 'pending' });
	}
}
