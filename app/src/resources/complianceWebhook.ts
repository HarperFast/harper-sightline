import { Resource } from 'harper';
import { verifyWebhookHmac } from '../webhookHmac.ts';
import { readShopifySecret } from '../readSecret.ts';
import { redactShop, redactOrders } from '../redaction.ts';
import { REDACT_TARGETS } from '../ledgerTargets.ts';
import { writeAudit } from '../audit.ts';
import { handleCompliance, type ComplianceDeps } from '../compliance.ts';
import { httpError } from './http.ts';

// Shopify mandatory privacy/compliance webhooks (#21). Separate URIs from the
// operational events endpoint (shopify.app.toml [webhooks.privacy_compliance]).
// Authenticated by HMAC over the RAW body — an invalid HMAC 401s and performs NO
// mutation (verification precedes any dispatch). Retry-safe: redaction is
// idempotent and audits are keyed by webhook id.
export class ComplianceWebhook extends Resource {
	static path = '/webhooks/shopify/compliance';
	allowRead() {
		return true;
	}
	allowCreate() {
		return true;
	}
	allowUpdate() {
		return true;
	}
	async post() {
		const ctx = this.getContext();
		const resolved = await ctx.data;
		const rawBody = Buffer.isBuffer(resolved) ? resolved : Buffer.from(typeof resolved === 'string' ? resolved : '', 'utf8');

		const secret = await readShopifySecret();
		if (!verifyWebhookHmac(rawBody, ctx.headers.get('x-shopify-hmac-sha256'), secret)) {
			throw httpError('invalid webhook hmac', 401);
		}

		const topic = ctx.headers.get('x-shopify-topic') ?? '';
		const webhookId = ctx.headers.get('x-shopify-webhook-id') ?? '';
		const shopId = ctx.headers.get('x-shopify-shop-domain') ?? '';
		let payload: Record<string, unknown> = {};
		try {
			const parsed = JSON.parse(rawBody.toString('utf8'));
			if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>;
		} catch {
			// tolerate an empty/invalid body — HMAC already proved authenticity
		}

		const deps: ComplianceDeps = {
			redactShop: (sid) => redactShop(REDACT_TARGETS, sid),
			redactOrders: (sid, ids) => redactOrders(REDACT_TARGETS, sid, ids),
			// Keyed by webhook id → a Shopify retry upserts the same audit row.
			audit: (action, sid, detail) => writeAudit(`${action}:${webhookId}`, sid, action, Date.now(), detail),
		};
		const result = await handleCompliance(topic, shopId, payload, deps);
		return { ok: true, result };
	}
}
