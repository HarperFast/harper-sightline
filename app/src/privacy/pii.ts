// Shopify payload keys that carry customer PII. They are dropped at every nesting
// level, so no PII is persisted even if an `include_fields` whitelist is
// misconfigured (shopify-contract §5, defense in depth). `name` is omitted on
// purpose: order `name` and line-item `title`/`sku` are Level-1 evidence, not PII.
// Everything else is preserved by a structural deep copy.
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

// Deep copy with every PII container key removed at all levels; non-objects pass through.
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
