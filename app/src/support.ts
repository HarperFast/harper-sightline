// Merchant-facing support contact (#26 App Store readiness).
//
// Deliberately has NO DEFAULT. Shopify requires a reachable support contact, and
// a plausible-but-wrong address is worse than a visibly absent one: the merchant
// gets silence instead of help and nobody notices. So an unconfigured contact
// renders as "not configured" — obvious in dev, caught by the review checklist
// before submission — rather than as a broken mailto that looks fine.
//
// Set at deploy time, not in code, so it is environment-specific and rotating it
// is a config change:
//   SIGHTLINE_SUPPORT_EMAIL=support@example.com
//   SIGHTLINE_SUPPORT_URL=https://example.com/sightline/help   (optional)

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
	const email = clean(env.SIGHTLINE_SUPPORT_EMAIL);
	const url = clean(env.SIGHTLINE_SUPPORT_URL);
	return { ...(email ? { email } : {}), ...(url ? { url } : {}) };
}

// At least one reachable channel. The App Store submission cannot be made
// truthfully until this is true in production.
export function supportConfigured(contact: SupportContact): boolean {
	return Boolean(contact.email || contact.url);
}
