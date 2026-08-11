import { Resource } from 'harper';
import { listEvents, listFindings, listOrders } from '../queries.ts';
import { collectExportRows, EXPORT_COLUMNS, MAX_EXPORT_ROWS, exportFilename, toCsv } from '../csv.ts';
import { MAX_LIMIT } from '../apiContract.ts';
import { log } from '../observe.ts';
import { identity } from './auth.ts';
import { httpError, parseUrl, trailingId, numParam } from './http.ts';
import { EventsQ, FindingsQ, ExpectationsQ, ProjectionsQ, EventSkusQ } from './tables.ts';

// CSV export of any filtered list. The one differentiator over Shopify's own
// activity log that a merchant can hold in their hand — the log is view-only,
// non-exportable, and capped at 250 rows.
//
// Authenticated by the same session token as every other read, which is why the
// SPA fetches this and downloads from a blob rather than linking directly: a
// browser navigation cannot carry the X-Shopify-Session-Token header.
//
// Bounded at MAX_EXPORT_ROWS. A truncated export SAYS SO in a response header and
// in the UI — silent truncation would read as "this is everything".
export class ExportResource extends Resource {
	static path = '/api/v1/export';
	allowRead() {
		return true;
	}
	async get() {
		const ctx = this.getContext();
		const shopId = (await identity.authenticate(ctx)).shopId;
		const url = parseUrl(ctx.url);
		const raw = trailingId(url.pathname, '/api/v1/export') ?? '';
		const kind = raw.replace(/\.csv$/, '');
		if (kind !== 'events' && kind !== 'findings' && kind !== 'orders') throw httpError('unknown export kind', 404);

		const now = Date.now();
		const p = url.searchParams;
		// One page-fetching closure per kind, over the SAME query functions the
		// screens use, so an export can never see a row the UI could not, and
		// tenant scoping is identical. collectExportRows (src/csv.ts) owns the
		// accumulate-until-cap loop and the truncation determination — pure and
		// unit-tested, since a Resource class needs the Harper runtime to test.
		const fetchPage = (cursor: string | undefined) => {
			if (kind === 'events') {
				return listEvents(
					EventsQ,
					shopId,
					now,
					{
						domain: p.get('domain') ?? undefined,
						topic: p.get('topic') ?? undefined,
						resourceId: p.get('resourceId') ?? undefined,
						sku: p.get('sku') ?? undefined,
						source: p.get('source') ?? undefined,
						state: p.get('state') ?? undefined,
						since: numParam(p, 'since'),
						until: numParam(p, 'until'),
						cursor,
						limit: MAX_LIMIT,
					},
					EventSkusQ,
				);
			}
			if (kind === 'findings') {
				return listFindings(FindingsQ, ExpectationsQ, ProjectionsQ, shopId, {
					status: p.get('status') ?? undefined,
					detector: p.get('detector') ?? undefined,
					cursor,
					limit: MAX_LIMIT,
				});
			}
			return listOrders(ProjectionsQ, shopId, now, {
				state: p.get('state') ?? undefined,
				minAgeHours: numParam(p, 'minAgeHours'),
				maxAgeHours: numParam(p, 'maxAgeHours'),
				sort: p.get('sort') === 'oldest' ? 'oldest' : 'newest',
				cursor,
				limit: MAX_LIMIT,
			});
		};
		const { rows: bounded, truncated } = await collectExportRows(fetchPage, MAX_EXPORT_ROWS, p.get('cursor') ?? undefined);
		const columns = EXPORT_COLUMNS[kind];
		const body = toCsv(
			columns.map((c) => c.header),
			bounded.map((row) => columns.map((c) => row[c.field])),
		);
		log('trace', 'export.served', { kind, rows: bounded.length, truncated });
		return new Response(body, {
			status: 200,
			headers: {
				'content-type': 'text/csv; charset=utf-8',
				'content-disposition': `attachment; filename="${exportFilename(kind, now)}"`,
				'x-sightline-row-count': String(bounded.length),
				'x-sightline-truncated': String(truncated),
			},
		});
	}
}
