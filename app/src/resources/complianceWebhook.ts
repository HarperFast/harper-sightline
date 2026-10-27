import { Resource } from 'harper';
import { verifyWebhookHmac } from '../shopify/webhookHmac.ts';
import { readShopifySecret } from '../secrets/readSecret.ts';
import { redactShop, redactOrders } from '../privacy/redaction.ts';
import { REDACT_TARGETS } from '../retention/ledgerTargets.ts';
import { log, metrics, M } from '../observability/observe.ts';
import { writeAudit } from '../audit.ts';
import { checkWebhookShop } from '../ingest/webhookShop.ts';
import { handleCompliance, type ComplianceDeps } from '../privacy/compliance.ts';
import { httpError } from './http.ts';

// Mandatory compliance webhooks, on separate URIs from operational events
// (shopify.app.toml [webhooks.privacy_compliance]). HMAC over the raw body; an
// invalid HMAC 401s with no mutation. Retry-safe: redaction is idempotent and audits
// are keyed by webhook id.
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

		// Redaction is idempotent and Shopify retries after the shop row is gone, so
		// no known-shop requirement; the body must still name the header's shop.
		const verdict = await checkWebhookShop({ shopId, topic, body: payload, requireKnownShop: false, isKnownShop: async () => true });
		if (!verdict.ok) {
			metrics.inc(M.webhookBadRequest);
			log('warn', 'webhook.rejected', { cid: webhookId, topic, reason: verdict.reason });
			throw httpError(verdict.reason, verdict.status);
		}

		const deps: ComplianceDeps = {
			redactShop: (sid) => redactShop(REDACT_TARGETS, sid),
			redactOrders: (sid, ids) => redactOrders(REDACT_TARGETS, sid, ids),
			// Keyed by webhook id so a retry upserts the same audit row.
			audit: (action, sid, detail) => writeAudit(`${action}:${webhookId}`, sid, action, Date.now(), detail),
		};
		const result = await handleCompliance(topic, shopId, payload, deps);
		return { ok: true, result };
	}
}
