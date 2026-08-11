import { Credentials } from '../db.ts';
import { loadAccessToken } from './credentialStore.ts';
import { rotateCredential } from './rotateCredential.ts';
import { readShopifySecret } from '../secrets/readSecret.ts';
import { SHOPIFY_API_KEY } from '../secrets/readSecret.ts';
import type { TokenDeps } from './accessToken.ts';

// Harper-backed wiring for accessToken.ts. Kept separate from accessToken.ts so
// the resolution logic stays unit-testable without the Harper runtime.

// The shop id IS the myshopify domain, which is what the refresh endpoint wants.
export async function rotateShopCredential(shopId: string): Promise<boolean> {
	const secret = await readShopifySecret();
	return rotateCredential({ shopId, shop: shopId, apiKey: SHOPIFY_API_KEY, secret });
}

export const tokenDeps: TokenDeps = {
	getCredential: (shopId) => Credentials.get(shopId),
	loadAccessToken,
	rotate: rotateShopCredential,
};
