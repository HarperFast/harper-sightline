import { requiredSecret } from './secretsPolicy.ts';

// The app's client_id. PUBLIC, not a secret — it is served to the browser in
// AppHome's `<meta name="shopify-api-key">` — but it lives here beside the secret
// reader so the two Shopify app credentials are configured in one place and the
// literal cannot drift between the request path (resources/auth.ts) and
// background token rotation (shopify/tokenDeps.ts). Deliberately NOT declared in
// config.yaml's `env:` block: declaring a public identifier as a required secret
// would say something false about it.
export const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY ?? 'e446bda5edb3ee3bae6e0ba280ef8b12';

// Read the Shopify app secret. Verifies webhook HMACs (resources/shopifyWebhook.ts,
// resources/complianceWebhook.ts) and embedded session tokens (auth/identity.ts),
// so it is the credential that decides whether an inbound request is genuinely
// from Shopify.
//
// There is no fallback. This previously ended in a hardcoded
// `DEV_FALLBACK_SECRET = 'shpss_…'` — committed, and therefore permanently in git
// history — used whenever the store and the environment both came up empty, which
// on the custody-degraded instance was always. A verifier that accepts a secret
// an attacker can read from the repository is not a verifier; failing to serve is
// strictly better than serving with forgeable HMACs. (That leaked dev secret must
// still be rotated in the Shopify Partner dashboard — deleting the constant does
// not un-publish it.)
//
// Stays `async` although the read is now synchronous: five call sites already
// `await` it, and the signature leaves room for a future
// `secrets.subscribe()`-backed reader without touching them.
export async function readShopifySecret(): Promise<string> {
	return requiredSecret('SHOPIFY_API_SECRET');
}
