import { Resource } from 'harper';
import { computeFlows } from '../queries.ts';
import { identity } from './auth.ts';
import { ProjectionsQ } from './tables.ts';

export class FlowsResource extends Resource {
	static path = '/api/v1/flows';
	allowRead() {
		return true;
	}
	async get() {
		const shopId = (await identity.authenticate(this.getContext())).shopId;
		return computeFlows(ProjectionsQ, shopId, Date.now());
	}
}
