import { timingSafeEqual } from 'node:crypto';

// Shared-secret gate for the operator-facing ops endpoint (/api/v1/ops). Separate
// from the merchant session path in identity.ts: this surface has no Shopify
// session behind it, because the callers are the load harness and the post-deploy
// checks, not a merchant in the admin.
//
// A bare shared secret is proportionate here only because the payload is already
// built to be non-sensitive — computeOpsHealth is cross-shop counts and ages with
// no merchant-identifying labels — so the worst case of a leak is disclosing
// backlog size, not shop data.

// The token is the entire security of this gate, so a short one is treated as
// absent rather than honoured. 32 chars is `openssl rand -hex 16`.
export const OPS_TOKEN_MIN_LENGTH = 32;

// True when the caller presented the configured ops token. Fails closed on every
// ambiguous input: unconfigured, absent header, weak configured token, or any
// length mismatch (which would otherwise make timingSafeEqual throw).
export function opsTokenAccepted(provided: string | null | undefined, configured: string | undefined): boolean {
	if (!configured || configured.length < OPS_TOKEN_MIN_LENGTH) return false;
	if (!provided) return false;
	const a = Buffer.from(provided, 'utf8');
	const b = Buffer.from(configured, 'utf8');
	return a.length === b.length && timingSafeEqual(a, b);
}
