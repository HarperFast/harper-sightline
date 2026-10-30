import { Resource } from 'harper';
import { getSummary } from '../api/queries.ts';
import { createReadCache } from '../api/readCache.ts';
import { identity } from './auth.ts';
import { EventsQ, ProjectionsQ, FindingsQ, DeliveriesQ, ShopsQ } from './tables.ts';

// Module scope so it outlives a request; per worker thread (src/api/readCache.ts).
const summaryCache = createReadCache<Record<string, unknown>>();

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
			summaryCache,
		);
	}
}
