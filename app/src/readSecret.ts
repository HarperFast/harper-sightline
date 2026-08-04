// Read the Shopify app secret from Harper native secrets (encrypted, never
// logged/replicated as plaintext — ADR-001). Dynamic import + optional access
// so a differing secrets API can never break module load / route registration.
// Falls back to env for local/CI contexts.
export async function readShopifySecret(): Promise<string> {
	try {
		const mod = (await import('harper')) as { secrets?: Record<string, string | undefined> };
		const value = mod.secrets?.SHOPIFY_API_SECRET;
		if (value) return value;
	} catch {
		// fall through to env
	}
	return process.env.SHOPIFY_API_SECRET ?? '';
}
