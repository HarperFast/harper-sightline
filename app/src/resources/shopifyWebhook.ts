import { Resource } from 'harper';
import { verifyWebhookHmac } from '../shopify/webhookHmac.ts';
import { readShopifySecret } from '../secrets/readSecret.ts';
import { acceptDelivery } from '../ingest/webhookIngress.ts';
import { checkWebhookShop } from '../ingest/webhookShop.ts';
import { Shops } from '../db.ts';
import { storedBody } from '../privacy/pii.ts';
import { log, metrics, M } from '../observability/observe.ts';
import { httpError } from './http.ts';

// Shopify webhook ingress. Authenticated by HMAC over the raw body (not the merchant
// JWT), verified before parsing (ADR-001). Accepts once per (shop, webhookId) and acks
// fast; normalization happens later in a worker (ADR-002).
export class ShopifyWebhook extends Resource {
	static path = '/webhooks/shopify/events';
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
		const startedAt = Date.now();
		metrics.inc(M.webhookReceived);
		// With the raw content-type handler (boot.ts), ctx.data is the raw request Buffer.
		const resolved = await ctx.data;
		const rawBody = Buffer.isBuffer(resolved) ? resolved : Buffer.from(typeof resolved === 'string' ? resolved : '', 'utf8');

		const secret = await readShopifySecret();
		if (!verifyWebhookHmac(rawBody, ctx.headers.get('x-shopify-hmac-sha256'), secret)) {
			metrics.inc(M.webhookSignatureFail);
			throw httpError('invalid webhook hmac', 401);
		}

		const shopId = ctx.headers.get('x-shopify-shop-domain') ?? '';
		const webhookId = ctx.headers.get('x-shopify-webhook-id') ?? '';
		const topic = ctx.headers.get('x-shopify-topic') ?? '';
		if (!shopId || !webhookId) {
			metrics.inc(M.webhookBadRequest);
			throw httpError('missing webhook headers', 400);
		}

		// HMAC proves the body, not the headers: bind the shop header to the signed
		// body (or a known shop) before anything is persisted under it.
		let parsed: unknown;
		try {
			parsed = JSON.parse(rawBody.toString('utf8'));
		} catch {
			// Non-JSON body — store nothing; an operational topic will dead-letter.
		}
		const verdict = await checkWebhookShop({
			shopId,
			topic,
			body: parsed,
			requireKnownShop: true,
			isKnownShop: async (id) => (await Shops.get(id)) != null,
		});
		if (!verdict.ok) {
			metrics.inc(verdict.status === 404 ? M.webhookUnknownShop : M.webhookBadRequest);
			log('warn', 'webhook.rejected', { cid: webhookId, topic, reason: verdict.reason });
			throw httpError(verdict.reason, verdict.status);
		}

		// Persist the allowlisted body so the worker can normalize it later (ADR-002).
		let payload: string | undefined;
		if (parsed !== undefined) {
			try {
				payload = JSON.stringify(storedBody(topic, parsed));
			} catch {
				// Unstorable body — store nothing, as for a non-JSON one.
			}
		}

		const result = await acceptDelivery({ shopId, webhookId, topic, payload });
		metrics.inc(result === 'duplicate' ? M.webhookDuplicate : M.webhookAccepted);
		metrics.observeMs(M.webhookAckMs, Date.now() - startedAt);
		log('trace', 'webhook.accepted', { cid: webhookId, topic, result });
		return { ok: true, result };
	}
}
