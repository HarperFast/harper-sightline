import { timingSafeEqual } from 'node:crypto';

// Shared-secret gate for /api/v1/ops, separate from the merchant session path. A bare
// secret is proportionate only because the payload is non-sensitive (cross-shop
// counts and ages); a leak discloses backlog size, not shop data.

// The token is the whole gate, so a short one counts as absent (32 chars = `openssl rand -hex 16`).
export const OPS_TOKEN_MIN_LENGTH = 32;

// Fails closed on every ambiguous input: unconfigured, absent header, weak token, or
// length mismatch (which would make timingSafeEqual throw).
export function opsTokenAccepted(provided: string | null | undefined, configured: string | undefined): boolean {
	if (!configured || configured.length < OPS_TOKEN_MIN_LENGTH) return false;
	if (!provided) return false;
	const a = Buffer.from(provided, 'utf8');
	const b = Buffer.from(configured, 'utf8');
	return a.length === b.length && timingSafeEqual(a, b);
}
