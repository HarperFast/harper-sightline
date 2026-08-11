import { Resource } from 'harper';
import { getSummary } from '../api/queries.ts';
import { identity } from './auth.ts';
import { EventsQ, ProjectionsQ, FindingsQ, DeliveriesQ, ShopsQ } from './tables.ts';

export class SummaryResource extends Resource {
	static path = '/api/v1/summary';
	allowRead() {
		return true;
	}
	async get() {
		const shopId = (await identity.authenticate(this.getContext())).shopId;
		return getSummary(
			{ events: EventsQ, projections: ProjectionsQ, findings: FindingsQ, deliveries: DeliveriesQ, shops: ShopsQ },
			shopId,
			Date.now(),
		);
	}
}
