import { Resource } from 'harper';
import { getSetup } from '../api/queries.ts';
import { identity } from './auth.ts';
import { ShopsQ, DeliveriesQ, CredentialsQ } from './tables.ts';

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
