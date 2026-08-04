// Shopify payload keys that carry customer PII (name, email, phone, address,
// free text). Shopify nests customer PII inside these containers — at the top
// level (`customer`, `billing_address`, …) and, in fuller payloads, nested in
// arrays too (e.g. `fulfillments[].destination`). We drop them at EVERY level so
// no PII is persisted even if an `include_fields` whitelist is misconfigured or a
// future payload adds a field (shopify-contract §5, defense in depth on top of
// the whitelist + PCD Level 1).
//
// The denylist deliberately omits `name`: order `name` (e.g. "#1001") and
// line-item `title`/`sku` are Level-1 evidence, not PII, and are kept at every
// level. Only these explicit container keys are removed; everything else is
// preserved by a structural deep copy.
const PII_KEYS = new Set([
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
]);

// Returns a deep copy of the payload with every PII container key removed at all
// nesting levels. Non-object inputs (null, primitives) pass through unchanged;
// arrays are recursed element-wise. Does not mutate the input.
export function stripPii(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripPii);
	if (value === null || typeof value !== 'object') return value;
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		if (PII_KEYS.has(key)) continue;
		out[key] = stripPii(child);
	}
	return out;
}
