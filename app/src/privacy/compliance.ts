// Mandatory privacy webhooks (customers/data_request, customers/redact, shop/redact).
// The resource verifies the HMAC and parses; this is the pure dispatcher. Retry-safe:
// redaction is idempotent and audits are keyed by webhook id.

export interface ComplianceDeps {
	redactShop(shopId: string): Promise<{ deleted: number; failures: string[] }>;
	redactOrders(shopId: string, orderIds: string[]): Promise<{ deleted: number; failures: string[] }>;
	audit(action: string, shopId: string, detail: Record<string, unknown>): Promise<void>;
}

export type ComplianceAction = 'shop_redact' | 'customer_redact' | 'customer_data_request' | 'ignored';

export interface ComplianceResult {
	topic: string;
	action: ComplianceAction;
	deleted?: number;
	failures?: string[];
}

function orderIds(payload: Record<string, unknown>, key: string): string[] {
	const raw = payload[key];
	if (!Array.isArray(raw)) return [];
	return raw.map((x) => (typeof x === 'number' ? String(x) : typeof x === 'string' ? x : '')).filter(Boolean);
}

export async function handleCompliance(
	topic: string,
	shopId: string,
	payload: Record<string, unknown>,
	deps: ComplianceDeps,
): Promise<ComplianceResult> {
	switch (topic) {
		case 'shop/redact': {
			const r = await deps.redactShop(shopId);
			await deps.audit('shop_redact', shopId, { deleted: r.deleted, failures: r.failures });
			return { topic, action: 'shop_redact', deleted: r.deleted, failures: r.failures };
		}
		case 'customers/redact': {
			// No customer id is held, so `orders_to_redact` is the only key we can act on.
			const ids = orderIds(payload, 'orders_to_redact');
			const r = await deps.redactOrders(shopId, ids);
			await deps.audit('customer_redact', shopId, { orderIds: ids, deleted: r.deleted, failures: r.failures });
			return { topic, action: 'customer_redact', deleted: r.deleted, failures: r.failures };
		}
		case 'customers/data_request': {
			// No customer PII is stored, so there is nothing to export; record the request for audit.
			await deps.audit('customer_data_request', shopId, { note: 'no customer PII stored', orders: orderIds(payload, 'orders_requested') });
			return { topic, action: 'customer_data_request' };
		}
		default:
			return { topic, action: 'ignored' };
	}
}
