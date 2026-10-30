import { Resource } from 'harper';
import { computeFlows } from '../api/queries.ts';
import { createReadCache } from '../api/readCache.ts';
import { identity } from './auth.ts';
import { ProjectionsQ } from './tables.ts';

// Module scope so it outlives a request; per worker thread (src/api/readCache.ts).
const flowsCache = createReadCache<Record<string, unknown>>();

export class FlowsResource extends Resource {
	static path = '/api/v1/flows';
	allowRead() {
		return true;
	}
	async get() {
		const shopId = (await identity.authenticate(this.getContext())).shopId;
		return computeFlows(ProjectionsQ, shopId, Date.now(), flowsCache);
	}
}
