// The identity adapter every authenticated resource shares, plus the session payload
// the SPA boots from. shopId comes from the verified principal (threat model §4).
import { createShopifyIdentityAdapter } from '../auth/identity.ts';
import { capabilitiesFor } from '../auth/capabilities.ts';
import { supportContact } from '../privacy/support.ts';
import { SHOPIFY_API_KEY } from '../secrets/readSecret.ts';
import { Shops as ShopsTable } from '../db.ts';

// Public client_id, not a secret; shared with background token rotation via readSecret.ts.
export const API_KEY = SHOPIFY_API_KEY;
export const VERSION = '0.1.0';

export const identity = createShopifyIdentityAdapter({ apiKey: API_KEY });

// Verifies the session token and returns the tenant identity and capabilities.
// `timezone` is cached by the reconcile sweep and absent until the first one
// completes; the SPA then labels whichever zone it falls back to.
export async function sessionPayload(shopId: string, userId: string): Promise<Record<string, unknown>> {
	const shop = await ShopsTable.get(shopId);
	return {
		shop: shopId,
		user: userId,
		capabilities: capabilitiesFor(shopId),
		...(shop?.ianaTimezone ? { timezone: shop.ianaTimezone } : {}),
		// Absent when unconfigured, never fabricated (src/privacy/support.ts).
		support: supportContact(),
	};
}
