import { Resource } from 'harper';
import { listOrders, getOrderDetail } from '../api/queries.ts';
import { identity } from './auth.ts';
import { httpError, parseUrl, trailingId, numParam } from './http.ts';
import { ProjectionsQ, EventsQ, FindingsQ } from './tables.ts';

// The operational worklist (orders and one order's full observed history). Every
// count on the Overview drills in here, so this is the endpoint that turns
// aggregates into something a merchant can act on.
export class OrdersResource extends Resource {
	static path = '/api/v1/orders';
	allowRead() {
		return true;
	}
	async get() {
		const ctx = this.getContext();
		const shopId = (await identity.authenticate(ctx)).shopId;
		const url = parseUrl(ctx.url);
		const orderId = trailingId(url.pathname, '/api/v1/orders');
		if (orderId) {
			const detail = await getOrderDetail(ProjectionsQ, EventsQ, FindingsQ, shopId, Date.now(), orderId);
			if (!detail) throw httpError('order not found', 404);
			return detail;
		}
		const p = url.searchParams;
		return listOrders(ProjectionsQ, shopId, Date.now(), {
			state: p.get('state') ?? undefined,
			minAgeHours: numParam(p, 'minAgeHours'),
			maxAgeHours: numParam(p, 'maxAgeHours'),
			sort: p.get('sort') === 'oldest' ? 'oldest' : 'newest',
			cursor: p.get('cursor') ?? undefined,
			limit: p.get('limit') ?? undefined,
		});
	}
}
