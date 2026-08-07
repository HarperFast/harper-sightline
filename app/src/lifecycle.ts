import { exchangeOfflineToken } from './exchangeToken.ts';
import { saveCredential, deleteCredential, markCredentialStatus } from './credentialStore.ts';
import { Shops, Credentials } from './db.ts';

// Managed install: exchange the verified session token for an offline token,
// create/update the Shop record, store the encrypted credential. (The live
// token exchange requires a real Admin session token — verified at dev-store
// install time.)
export async function installShop(args: { shop: string; sessionToken: string; apiKey: string; secret: string }): Promise<void> {
	const tok = await exchangeOfflineToken({ shop: args.shop, sessionToken: args.sessionToken, apiKey: args.apiKey, secret: args.secret });
	await Shops.put({ shopId: args.shop, status: 'active', scopes: tok.scope, installedAt: Date.now(), reconciliationState: 'pending' });
	await saveCredential(args.shop, tok);
}

// app/uninstalled: mark inactive and invalidate the credential (documented
// redaction timing handled by the compliance flow, #20/#21).
export async function uninstallShop(shopId: string): Promise<void> {
	const shop = await Shops.get(shopId);
	if (shop) await Shops.patch(shopId, { status: 'uninstalled', uninstalledAt: Date.now() });
	await deleteCredential(shopId);
}

// Refresh failure → stop Admin API jobs, surface reauthorization_required.
export async function markReauthRequired(shopId: string): Promise<void> {
	await Shops.patch(shopId, { status: 'reauthorization_required' });
	await markCredentialStatus(shopId, 'reauthorization_required');
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
		// saveCredential resets the CREDENTIAL to active, but nothing resets the
		// SHOP — and runReconcileSweep only iterates status:'active'. Without this a
		// single refresh failure would park the shop in reauthorization_required
		// permanently: the merchant re-opens the app, the credential recovers, and
		// background reconciliation still never resumes. Only lift the reauth state
		// — an uninstalled shop must NOT be resurrected by an app load.
		const shop = await Shops.get(args.shop);
		if (shop?.status === 'reauthorization_required') await Shops.patch(args.shop, { status: 'active' });
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
