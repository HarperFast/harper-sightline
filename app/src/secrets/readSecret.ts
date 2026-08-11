import { requireRealSecrets, InsecureSecretError } from './secretsPolicy.ts';

// TEMP DEV UNBLOCK — REMOVE BEFORE PROD. The Fabric instance's secrets custody
// is broken (custody_fingerprint null cluster-wide), so no Harper-secrets path
// works. This dev-only hardcoded fallback keeps the app-secret edges testable.
// It is LAST RESORT: real Harper secrets / process.env win when available, so
// once custody is restored this fallback is simply dead code (then delete it).
// The secret below is a DEV app secret and is exposed in git history — rotate it
// in Shopify before any non-dev use.
const DEV_FALLBACK_SECRET = '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';

// The app's client_id. PUBLIC, not a secret — but it lives here beside the secret
// reader so the two Shopify app credentials are configured in one place and the
// literal cannot drift between the request path (resources.ts) and background
// token rotation (tokenDeps.ts).
export const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY ?? 'e446bda5edb3ee3bae6e0ba280ef8b12';

// Read the Shopify app secret from Harper native secrets (encrypted, never
// logged/replicated as plaintext — ADR-001). Dynamic import + optional access
// so a differing secrets API can never break module load / route registration.
// Falls back to env, then the temporary dev constant above. With
// SIGHTLINE_REQUIRE_SECRETS=1 the dev-constant fallback is refused (fails closed).
export async function readShopifySecret(): Promise<string> {
	try {
		const mod = (await import('harper')) as { secrets?: Record<string, string | undefined> };
		const value = mod.secrets?.SHOPIFY_API_SECRET;
		if (value) return value;
	} catch {
		// fall through
	}
	const fromEnv = process.env.SHOPIFY_API_SECRET;
	if (fromEnv) return fromEnv;
	if (requireRealSecrets()) throw new InsecureSecretError('Shopify app secret');
	return DEV_FALLBACK_SECRET;
}
