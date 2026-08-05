// Fail-closed policy for secret material (#23 security review). Two dev fallbacks
// keep local dev / tests / the current custody-degraded dev deployment working:
// a hardcoded Shopify app secret (readSecret.ts) and a deterministic token
// encryption key (crypto.ts). Both are known-weak. When SIGHTLINE_REQUIRE_SECRETS=1
// — set in staging/production — the app must REFUSE to fall back to either, so a
// misconfigured prod deploy fails closed instead of silently running on a public
// key/secret. Off by default so nothing currently working breaks.
export function requireRealSecrets(): boolean {
	return process.env.SIGHTLINE_REQUIRE_SECRETS === '1';
}

export class InsecureSecretError extends Error {
	readonly statusCode = 500;
	constructor(what: string) {
		super(`${what} is unavailable and SIGHTLINE_REQUIRE_SECRETS is set — refusing to use the dev fallback`);
		this.name = 'InsecureSecretError';
	}
}
