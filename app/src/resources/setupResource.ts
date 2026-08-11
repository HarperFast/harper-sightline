import { Resource } from 'harper';
import { getSetup } from '../queries.ts';
import { identity } from './auth.ts';
import { ShopsQ, DeliveriesQ, CredentialsQ } from './tables.ts';

// First-open/setup progress (screen spec §1), derived from durable state only.
export class SetupResource extends Resource {
	static path = '/api/v1/setup';
	allowRead() {
		return true;
	}
	async get() {
		const shopId = (await identity.authenticate(this.getContext())).shopId;
		return getSetup({ shops: ShopsQ, deliveries: DeliveriesQ, credentials: CredentialsQ }, shopId, Date.now());
	}
}
