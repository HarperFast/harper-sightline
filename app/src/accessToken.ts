// Usable-access-token resolution for background Admin API work.
//
// WHY THIS EXISTS. Shopify issues *expiring* offline access tokens (mandatory for
// new public apps) plus a 90-day refresh token. Before this module, the only code
// that ever refreshed was `ensureCredential`, which needs a merchant to OPEN THE
// APP with a live `id_token`. `loadAccessToken` handed back whatever was stored
// without checking `expiresAt`, so once a token expired:
//
//   fetchOrdersUpdatedSince -> Shopify 401 -> adminGraphql throws
//     -> the throw escapes BEFORE Shops.patch({lastReconciledAt})
//     -> the timestamp freezes and nothing marks the shop reauthorization_required
//
// Reconciliation therefore died silently roughly every 24h and stayed dead until
// a human opened the UI, while the credential still reported itself `active` and
// the refresh token sat unused. Proven live on 2026-08-07: the cycle 40s before
// expiry succeeded, the next one (and every one after) did not, with
// status/version unchanged. `rotateCredential` was fully written but had no call
// site and no tests — this module is that call site.
//
// Deps are injected so this is testable without the Harper runtime, matching the
// pattern retention.ts / redaction.ts use.

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

// Refresh this far ahead of expiry so a token cannot die part-way through a
// sweep. Comfortably larger than the 10-minute reconcile interval, so a token is
// renewed a whole cycle before it could fail.
export const REFRESH_MARGIN_MS = 15 * 60 * 1000;

// Resolve a token that is actually usable, rotating first when it is at or near
// expiry. Returns null when there is nothing to use — no credential, or a shop
// already parked in reauthorization_required (which must NOT be retried on every
// tick; the merchant has to re-consent).
export async function getUsableAccessToken(deps: TokenDeps, shopId: string, now: number): Promise<string | null> {
	const credential = await deps.getCredential(shopId);
	if (!credential?.accessTokenEnc) return null;
	if (credential.status === 'reauthorization_required') return null;

	// A missing expiresAt is treated as "refresh now" rather than "assume valid":
	// an unknown expiry is exactly the state that produced the silent outage.
	const needsRefresh = credential.expiresAt === undefined || credential.expiresAt - now <= REFRESH_MARGIN_MS;
	if (!needsRefresh) return deps.loadAccessToken(shopId);

	// rotateCredential marks the shop reauthorization_required on failure, so a
	// false here is already recorded as merchant-actionable state.
	if (!(await deps.rotate(shopId))) return null;
	return deps.loadAccessToken(shopId);
}

// True when an Admin API error means "this token is no longer accepted", i.e.
// worth one rotation + retry. adminGraphql maps transport failures to statusCode.
export function isAuthError(err: unknown): boolean {
	return (err as { statusCode?: number } | null)?.statusCode === 401;
}
