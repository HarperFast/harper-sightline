import { Resource } from 'harper';
import { ensureShopRecord } from '../lifecycle.ts';
import { identity, sessionPayload } from './auth.ts';

export class Session extends Resource {
	static path = '/api/v1/session';
	allowRead() {
		return true;
	}
	async get() {
		const principal = await identity.authenticate(this.getContext());
		// Bootstrap the shop record on first authenticated call (no token exchange).
		await ensureShopRecord(principal.shopId);
		return sessionPayload(principal.shopId, principal.userId);
	}
}
