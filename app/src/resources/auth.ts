// The identity adapter every authenticated resource shares, plus the session
// payload the SPA boots from. shopId is always derived from the verified
// principal, never from caller input (threat model §4).
import { createShopifyIdentityAdapter } from '../identity.ts';
import { capabilitiesFor } from '../capabilities.ts';
import { supportContact } from '../support.ts';
import { SHOPIFY_API_KEY } from '../readSecret.ts';
import { Shops as ShopsTable } from '../db.ts';

// Public app API key (client_id) — not a secret. Sourced from readSecret.ts so the
// literal cannot drift between here and background token rotation.
export const API_KEY = SHOPIFY_API_KEY;
export const VERSION = '0.1.0';

export const identity = createShopifyIdentityAdapter({ apiKey: API_KEY });

// Verifies the Shopify session token via the identity adapter and returns the
// tenant identity + capability profile. shopId is derived from the verified
// principal, never from caller input (threat model §4).
// The session payload the SPA boots from. `timezone` is the store's configured
// IANA zone, cached by the reconcile sweep — it is absent until the first sweep
// completes, and the SPA falls back to the viewer's zone (labelling whichever it
// used) so a timestamp is never shown against an unstated zone.
export async function sessionPayload(shopId: string, userId: string): Promise<Record<string, unknown>> {
	const shop = await ShopsTable.get(shopId);
	return {
		shop: shopId,
		user: userId,
		capabilities: capabilitiesFor(shopId),
		...(shop?.ianaTimezone ? { timezone: shop.ianaTimezone } : {}),
		// Merchant-facing support contact, so the UI can offer help on the screens
		// where a merchant is actually stuck. Absent when unconfigured — never a
		// fabricated address (src/support.ts).
		support: supportContact(),
	};
}
