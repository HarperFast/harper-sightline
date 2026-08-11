// Merchant-facing support contact (#26 App Store readiness).
//
// This is product metadata, not a secret and not environment-specific — the same
// address in dev, staging, and production — so it lives in code with an env
// override, rather than as env-only config. Env-only would mean a production
// deploy that forgets the variable ships an app telling merchants support is not
// configured, and Shopify requires a reachable contact. A committed correct value
// cannot be forgotten; the override still allows a staging or white-label
// deployment to point somewhere else:
//
//   SIGHTLINE_SUPPORT_EMAIL=other@example.com
//   SIGHTLINE_SUPPORT_URL=https://example.com/sightline/help   (optional)
//
// What is still refused is *fabrication*: an explicitly blank override does not
// silently invent an address, and the UI/policy render "not configured" rather
// than a broken mailto if a contact genuinely cannot be resolved.

export const DEFAULT_SUPPORT_EMAIL = 'support@harperdb.io';

export interface SupportContact {
	email?: string;
	url?: string;
}

// Trim and drop empties so `SIGHTLINE_SUPPORT_EMAIL=""` counts as unset rather
// than as a configured empty address.
function clean(value: string | undefined): string | undefined {
	const trimmed = (value ?? '').trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function supportContact(env: Record<string, string | undefined> = process.env): SupportContact {
	// A blank/whitespace override falls back to the default rather than counting as
	// "deliberately unset" — an empty env var is nearly always an accident, and the
	// failure it would cause (no support contact in production) is worse than the
	// inflexibility of not honouring it.
	const email = clean(env.SIGHTLINE_SUPPORT_EMAIL) ?? DEFAULT_SUPPORT_EMAIL;
	const url = clean(env.SIGHTLINE_SUPPORT_URL);
	return { email, ...(url ? { url } : {}) };
}

// At least one reachable channel. The App Store submission cannot be made
// truthfully until this is true in production.
export function supportConfigured(contact: SupportContact): boolean {
	return Boolean(contact.email || contact.url);
}
