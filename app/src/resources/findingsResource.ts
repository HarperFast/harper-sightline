import { Resource } from 'harper';
import { listFindings, getFindingDetail } from '../api/queries.ts';
import { identity } from './auth.ts';
import { httpError, parseUrl, trailingId } from './http.ts';
import { FindingsQ, ExpectationsQ, ProjectionsQ } from './tables.ts';

export class FindingsResource extends Resource {
	static path = '/api/v1/findings';
	allowRead() {
		return true;
	}
	async get() {
		const ctx = this.getContext();
		const shopId = (await identity.authenticate(ctx)).shopId;
		const url = parseUrl(ctx.url);
		const id = trailingId(url.pathname, '/api/v1/findings');
		if (id) {
			const detail = await getFindingDetail(FindingsQ, ExpectationsQ, ProjectionsQ, shopId, id);
			if (!detail) throw httpError('finding not found', 404);
			return detail;
		}
		const p = url.searchParams;
		return listFindings(FindingsQ, ExpectationsQ, ProjectionsQ, shopId, {
			status: p.get('status') ?? undefined,
			detector: p.get('detector') ?? undefined,
			cursor: p.get('cursor') ?? undefined,
			limit: p.get('limit') ?? undefined,
		});
	}
}
