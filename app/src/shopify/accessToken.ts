// Resolves a usable Admin API token for background work, rotating via the refresh
// token when the stored one is at or near expiry. Deps are injected so it runs
// without the Harper runtime.

export interface CredentialFacts {
	status?: string;
	expiresAt?: number;
	accessTokenEnc?: string;
}

export interface TokenDeps {
	getCredential(shopId: string): Promise<CredentialFacts | undefined>;
	loadAccessToken(shopId: string): Promise<string | null>;
	rotate(shopId: string): Promise<boolean>;
}

// Refresh this far ahead of expiry so a token cannot die mid-sweep. Offline tokens
// last about 60 minutes, so this must exceed the 10-minute reconcile interval.
export const REFRESH_MARGIN_MS = 15 * 60 * 1000;

// Returns null when there is nothing to use: no credential, or a shop parked in
// reauthorization_required, which must not be retried every tick.
export async function getUsableAccessToken(deps: TokenDeps, shopId: string, now: number): Promise<string | null> {
	const credential = await deps.getCredential(shopId);
	if (!credential?.accessTokenEnc) return null;
	if (credential.status === 'reauthorization_required') return null;

	// An unknown expiry counts as expired.
	const needsRefresh = credential.expiresAt === undefined || credential.expiresAt - now <= REFRESH_MARGIN_MS;
	if (!needsRefresh) return deps.loadAccessToken(shopId);

	// A false means rotateCredential already parked the shop for re-consent; a transient
	// failure throws instead and leaves the shop untouched.
	if (!(await deps.rotate(shopId))) return null;
	return deps.loadAccessToken(shopId);
}

// True when the error means the token is no longer accepted (worth one rotate and retry).
export function isAuthError(err: unknown): boolean {
	return (err as { statusCode?: number } | null)?.statusCode === 401;
}
