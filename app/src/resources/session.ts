import { Resource } from 'harper';
import { ensureShopRecord } from '../shopify/lifecycle.ts';
import { identity, sessionPayload } from './auth.ts';

export class Session extends Resource {
	static path = '/api/v1/session';
	allowRead() {
		return true;
	}
	async get() {
		const principal = await identity.authenticate(this.getContext());
		await ensureShopRecord(principal.shopId);
		return sessionPayload(principal.shopId, principal.userId);
	}
}
