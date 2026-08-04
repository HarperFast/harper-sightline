// Top-level Shopify payload keys that carry customer PII (name, email, phone,
// address, free text). Shopify nests customer PII inside these containers, so
// deleting them at ingress guarantees we never persist PII — even if an
// `include_fields` whitelist is misconfigured or a future payload adds a field
// (shopify-contract §5, defense in depth on top of the whitelist + PCD Level 1).
//
// We deliberately do NOT recurse: order-level keys like `name` (the order name,
// e.g. "#1001") and line-item `title`/`sku` are Level-1 evidence, not PII, and
// must be kept. All customer PII in Shopify webhook payloads lives at the top
// level under these container keys.
const PII_KEYS = [
	'customer',
	'billing_address',
	'shipping_address',
	'destination',
	'client_details',
	'email',
	'contact_email',
	'phone',
	'note',
	'note_attributes',
	'customer_locale',
] as const;

// Returns a shallow copy of the payload with known PII container keys removed.
// Non-object inputs (null, arrays, primitives) pass through unchanged.
export function stripPii(payload: unknown): unknown {
	if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
	const clone: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
	for (const key of PII_KEYS) delete clone[key];
	return clone;
}
