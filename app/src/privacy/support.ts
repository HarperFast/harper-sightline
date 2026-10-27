// Merchant-facing support contact. Product metadata, so it lives in code with an env
// override rather than env-only config: a production deploy that forgets the variable
// must not tell merchants support is not configured, and Shopify requires a reachable
// contact.
//
//   SIGHTLINE_SUPPORT_EMAIL=other@example.com
//   SIGHTLINE_SUPPORT_URL=https://example.com/sightline/help   (optional)
//
// A blank override never invents an address; the UI renders "not configured" rather
// than a broken mailto if no contact resolves.

export const DEFAULT_SUPPORT_EMAIL = 'support@harperdb.io';

export interface SupportContact {
	email?: string;
	url?: string;
}

// Trim and drop empties so a blank variable counts as unset.
function clean(value: string | undefined): string | undefined {
	const trimmed = (value ?? '').trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function supportContact(env: Record<string, string | undefined> = process.env): SupportContact {
	// A blank override falls back to the default: it is nearly always an accident, and
	// no support contact in production is worse than not honouring it.
	const email = clean(env.SIGHTLINE_SUPPORT_EMAIL) ?? DEFAULT_SUPPORT_EMAIL;
	const url = clean(env.SIGHTLINE_SUPPORT_URL);
	return { email, ...(url ? { url } : {}) };
}

export function supportConfigured(contact: SupportContact): boolean {
	return Boolean(contact.email || contact.url);
}
