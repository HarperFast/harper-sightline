import { Resource } from 'harper';
import { listEvents, getEventDetail } from '../queries.ts';
import { identity } from './auth.ts';
import { httpError, parseUrl, trailingId, numParam } from './http.ts';
import { EventsQ, ProjectionsQ, FindingsQ, InventoryItemsQ, ShopLocationsQ, EventSkusQ } from './tables.ts';

export class EventsResource extends Resource {
	static path = '/api/v1/events';
	allowRead() {
		return true;
	}
	async get() {
		const ctx = this.getContext();
		const shopId = (await identity.authenticate(ctx)).shopId;
		const url = parseUrl(ctx.url);
		const id = trailingId(url.pathname, '/api/v1/events');
		if (id) {
			const detail = await getEventDetail(EventsQ, ProjectionsQ, FindingsQ, shopId, id, InventoryItemsQ, ShopLocationsQ, EventSkusQ);
			if (!detail) throw httpError('event not found', 404);
			return detail;
		}
		const p = url.searchParams;
		return listEvents(
			EventsQ,
			shopId,
			Date.now(),
			{
				domain: p.get('domain') ?? undefined,
				topic: p.get('topic') ?? undefined,
				resourceId: p.get('resourceId') ?? undefined,
				sku: p.get('sku') ?? undefined,
				source: p.get('source') ?? undefined,
				state: p.get('state') ?? undefined,
				since: numParam(p, 'since'),
				until: numParam(p, 'until'),
				cursor: p.get('cursor') ?? undefined,
				limit: p.get('limit') ?? undefined,
			},
			EventSkusQ,
		);
	}
}
