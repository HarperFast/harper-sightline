import { isShopDomain } from '../auth/shopDomain.ts';

// The HMAC covers only the body, so the header shop must be bound to the body or to a known shop.

export type WebhookShopVerdict = { ok: true } | { ok: false; status: number; reason: string };

// Each lifecycle/compliance topic is bound to its own payload shape, so a signed
// body cannot be replayed under another topic (an uninstall or a full redaction)
// or another shop. Heuristic: it keys on the fields Shopify documents per topic.
interface TopicShape {
	shopField: 'myshopify_domain' | 'shop_domain';
	require?: string[];
	forbid?: string[];
}

const COMPLIANCE_ONLY = ['orders_to_redact', 'orders_requested', 'data_request', 'customer'];
const TOPIC_SHAPES: Record<string, TopicShape> = {
	'app/uninstalled': { shopField: 'myshopify_domain', forbid: ['shop_domain', ...COMPLIANCE_ONLY] },
	'shop/redact': { shopField: 'shop_domain', forbid: ['myshopify_domain', ...COMPLIANCE_ONLY] },
	'customers/redact': {
		shopField: 'shop_domain',
		require: ['orders_to_redact'],
		forbid: ['myshopify_domain', 'orders_requested', 'data_request'],
	},
	'customers/data_request': { shopField: 'shop_domain', require: ['orders_requested'], forbid: ['myshopify_domain', 'orders_to_redact'] },
};

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
	for (const field of BODY_SHOP_FIELDS) {
		const value = bodyObject?.[field];
		if (value === undefined) continue;
		if (value !== args.shopId) return { ok: false, status: 400, reason: 'shop domain mismatch' };
	}
	const shape = TOPIC_SHAPES[args.topic];
	if (shape) {
		if (!bodyObject || bodyObject[shape.shopField] === undefined)
			return { ok: false, status: 400, reason: 'webhook body does not name its shop' };
		const present = (k: string) => bodyObject[k] !== undefined;
		if (!(shape.require ?? []).every(present) || (shape.forbid ?? []).some(present)) {
			return { ok: false, status: 400, reason: 'webhook body does not match its topic' };
		}
	}

	if (args.requireKnownShop && !(await args.isKnownShop(args.shopId))) return { ok: false, status: 404, reason: 'unknown shop' };
	return { ok: true };
}
