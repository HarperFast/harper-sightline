import { Resource } from 'harper';
import { DigestSubscriptions as DigestSubscriptionsTable } from '../db.ts';
import { applySubscriptionUpdate, toSubscriptionView } from '../digest/digestSubscription.ts';
import { writeAudit } from '../audit.ts';
import { identity } from './auth.ts';
import { httpError } from './http.ts';

// The notification subscription, the app's only write endpoint; it writes
// Sightline's own configuration, never Shopify data. shopId comes from the verified
// principal and a body shopId is ignored. Every change is audited and the address is never logged.
export class DigestResource extends Resource {
	static path = '/api/v1/digest';
	allowRead() {
		return true;
	}
	allowUpdate() {
		return true;
	}
	async get() {
		const shopId = (await identity.authenticate(this.getContext())).shopId;
		return toSubscriptionView(await DigestSubscriptionsTable.get(shopId));
	}
	async put() {
		const ctx = this.getContext();
		const shopId = (await identity.authenticate(ctx)).shopId;
		const resolved = await ctx.data;
		// The raw-JSON content-type handler means bodies arrive as a Buffer.
		let body: Record<string, unknown> = {};
		try {
			const text = Buffer.isBuffer(resolved) ? resolved.toString('utf8') : typeof resolved === 'string' ? resolved : '';
			const parsed = JSON.parse(text);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
		} catch {
			throw httpError('body must be a JSON object', 400);
		}

		const now = Date.now();
		const existing = await DigestSubscriptionsTable.get(shopId);
		const next = applySubscriptionUpdate(existing, shopId, body, now);
		await DigestSubscriptionsTable.put(next);
		// Audit the CHANGE, never the address itself.
		await writeAudit(`digest:${shopId}:${now}`, shopId, 'digest.subscription.updated', now, {
			status: next.status,
			cadence: next.cadence,
			hasEmail: Boolean(next.email),
		});
		return toSubscriptionView(next);
	}
}
