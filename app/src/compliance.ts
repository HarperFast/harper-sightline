// Shopify mandatory privacy webhooks (#21): customers/data_request,
// customers/redact, shop/redact. HMAC verification + parsing happen in the
// resource; this is the pure dispatcher (injected side effects → testable).
// Every branch is retry-safe: redaction is idempotent (delete-by-condition) and
// audits are keyed by webhook id.

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

// Order ids from a compliance payload list field (numbers or strings → strings).
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
			// Erase the whole tenant (~48h after uninstall). Idempotent.
			const r = await deps.redactShop(shopId);
			await deps.audit('shop_redact', shopId, { deleted: r.deleted, failures: r.failures });
			return { topic, action: 'shop_redact', deleted: r.deleted, failures: r.failures };
		}
		case 'customers/redact': {
			// Remove records linked to the customer's orders. We hold no customer id,
			// so `orders_to_redact` is the only customer-scoped key we can act on.
			const ids = orderIds(payload, 'orders_to_redact');
			const r = await deps.redactOrders(shopId, ids);
			await deps.audit('customer_redact', shopId, { orderIds: ids, deleted: r.deleted, failures: r.failures });
			return { topic, action: 'customer_redact', deleted: r.deleted, failures: r.failures };
		}
		case 'customers/data_request': {
			// Sightline stores no customer PII, so there is nothing to export. Record
			// the request for the audit trail; provision (if any) is an ops process.
			await deps.audit('customer_data_request', shopId, { note: 'no customer PII stored', orders: orderIds(payload, 'orders_requested') });
			return { topic, action: 'customer_data_request' };
		}
		default:
			return { topic, action: 'ignored' };
	}
}
