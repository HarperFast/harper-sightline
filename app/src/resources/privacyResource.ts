import { Resource } from 'harper';
import { getPrivacy } from '../api/queries.ts';
import { identity } from './auth.ts';
import { EventsQ, FindingsQ, ProjectionsQ, DeliveriesQ, ShopsQ, DigestSubscriptionsQ } from './tables.ts';

export class PrivacyResource extends Resource {
	static path = '/api/v1/privacy';
	allowRead() {
		return true;
	}
	async get() {
		const shopId = (await identity.authenticate(this.getContext())).shopId;
		return getPrivacy(
			{
				events: EventsQ,
				findings: FindingsQ,
				projections: ProjectionsQ,
				deliveries: DeliveriesQ,
				shops: ShopsQ,
				digestSubscriptions: DigestSubscriptionsQ,
			},
			shopId,
			Date.now(),
		);
	}
}
