import { Resource } from 'harper';
import { verifyWebhookHmac } from '../webhookHmac.ts';
import { readShopifySecret } from '../readSecret.ts';
import { acceptDelivery } from '../webhookIngress.ts';
import { stripPii } from '../pii.ts';
import { log, metrics, M } from '../observe.ts';
import { httpError } from './http.ts';

// Shopify webhook ingress. Authenticated by HMAC over the RAW body (NOT the
// merchant JWT), verified before any parsing (ADR-001, plan §12). Durably
// accepts once per (shop, webhookId) and acks fast — no normalization or Admin
// API calls here (ADR-002). A worker processes accepted rows later.
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
		// With the raw content-type handler (src/resources/boot.ts), ctx.data
		// resolves to the raw Buffer of the request body (not parsed).
		const resolved = await ctx.data;
		const rawBody = Buffer.isBuffer(resolved) ? resolved : Buffer.from(typeof resolved === 'string' ? resolved : '', 'utf8');

		const secret = await readShopifySecret();
		if (!verifyWebhookHmac(rawBody, ctx.headers.get('x-shopify-hmac-sha256'), secret)) {
			metrics.inc(M.webhookHmacFail);
			throw httpError('invalid webhook hmac', 401);
		}

		const shopId = ctx.headers.get('x-shopify-shop-domain') ?? '';
		const webhookId = ctx.headers.get('x-shopify-webhook-id') ?? '';
		const topic = ctx.headers.get('x-shopify-topic') ?? '';
		if (!shopId || !webhookId) {
			metrics.inc(M.webhookBadRequest);
			throw httpError('missing webhook headers', 400);
		}

		// Persist the PII-stripped body so the worker can normalize it later
		// (ADR-002: accept fast, process later). HMAC is already verified over the
		// raw bytes; storage keeps only the whitelisted, non-PII fields (#10).
		let payload: string | undefined;
		try {
			payload = JSON.stringify(stripPii(JSON.parse(rawBody.toString('utf8'))));
		} catch {
			// Non-JSON body — store nothing; an operational topic will dead-letter.
		}

		const result = await acceptDelivery({ shopId, webhookId, topic, payload });
		metrics.inc(result === 'duplicate' ? M.webhookDuplicate : M.webhookAccepted);
		metrics.observeMs(M.webhookAckMs, Date.now() - startedAt);
		// cid = webhookId ties this ack to the worker's later processing lines.
		log('trace', 'webhook.accepted', { cid: webhookId, topic, result });
		return { ok: true, result };
	}
}
