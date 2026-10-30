import { requiredSecret } from './secretsPolicy.ts';

// The app's client_id: public (served in AppHome's `<meta name="shopify-api-key">`),
// kept beside the secret reader so the request path and background token rotation
// share one literal. Not in config.yaml's `env:` block, which would call it a secret.
export const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY ?? 'e446bda5edb3ee3bae6e0ba280ef8b12';

// The Shopify app secret, which verifies webhook HMACs and session tokens, so it
// decides whether a request is genuinely from Shopify. There is no fallback: a
// verifier that accepts a secret readable from the repository is not a verifier.
// Stays `async` so a future `secrets.subscribe()`-backed reader needs no call-site changes.
export async function readShopifySecret(): Promise<string> {
	return requiredSecret('SHOPIFY_API_SECRET');
}
