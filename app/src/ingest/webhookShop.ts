import { isShopDomain } from '../auth/shopDomain.ts';

// The webhook HMAC covers only the raw body, so every header that names a tenant
// is unauthenticated: a captured signed body replayed under another shop's
// X-Shopify-Shop-Domain would be filed under that shop. This binds the header to
// the signed body where the body names its shop, and to a known shop otherwise.
// Pure and injected so it is testable without the Harper runtime.

export type WebhookShopVerdict = { ok: true } | { ok: false; status: number; reason: string };

// Topics whose payload is about the shop itself and must say which one, so a
// swapped shop header (or a swapped topic header) cannot move the body to
// another tenant.
const BODY_BOUND_TOPICS = new Set(['app/uninstalled', 'shop/redact', 'customers/redact', 'customers/data_request']);

const BODY_SHOP_FIELDS = ['myshopify_domain', 'shop_domain'] as const;

export interface WebhookShopArgs {
	shopId: string;
	topic: string;
	body: unknown;
	// Compliance topics are idempotent erasures that Shopify retries after the
	// shop row is already gone, so they must not require a known shop.
	requireKnownShop: boolean;
	isKnownShop(shopId: string): Promise<boolean>;
}

export async function checkWebhookShop(args: WebhookShopArgs): Promise<WebhookShopVerdict> {
	if (!isShopDomain(args.shopId)) return { ok: false, status: 400, reason: 'invalid shop domain' };

	const bodyObject =
		args.body !== null && typeof args.body === 'object' && !Array.isArray(args.body) ? (args.body as Record<string, unknown>) : undefined;
	let bodyNamesShop = false;
	for (const field of BODY_SHOP_FIELDS) {
		const value = bodyObject?.[field];
		if (value === undefined) continue;
		bodyNamesShop = true;
		if (value !== args.shopId) return { ok: false, status: 400, reason: 'shop domain mismatch' };
	}
	if (!bodyNamesShop && BODY_BOUND_TOPICS.has(args.topic)) return { ok: false, status: 400, reason: 'webhook body does not name its shop' };

	if (args.requireKnownShop && !(await args.isKnownShop(args.shopId))) return { ok: false, status: 404, reason: 'unknown shop' };
	return { ok: true };
}
