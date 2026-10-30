import { Resource } from 'harper';
import { listEvents, listFindings, listOrders } from '../api/queries.ts';
import { collectExportRows, EXPORT_COLUMNS, MAX_EXPORT_ROWS, exportFilename, toCsv } from '../api/csv.ts';
import { MAX_LIMIT } from '../api/apiContract.ts';
import { createExportGate, EXPORT_BUSY_RETRY_SECONDS, exportBusyResponse, runExclusive, sharedExportSlot } from '../api/exportGate.ts';
import { Shops } from '../db.ts';
import { createRateLimiter, EXPORTS_PER_MINUTE, RateLimitError } from '../auth/rateLimit.ts';
import { log, M, metrics } from '../observability/observe.ts';
import { identity } from './auth.ts';
import { httpError, parseUrl, trailingId, numParam } from './http.ts';
import { EventsQ, FindingsQ, ExpectationsQ, ProjectionsQ, EventSkusQ } from './tables.ts';

// A much tighter limit than the per-shop request limit, since export is the one read
// whose cost is not proportional to the request (EXPORTS_PER_MINUTE). Module scope so
// the counter survives between requests.
const exportLimiter = createRateLimiter({ limit: EXPORTS_PER_MINUTE });

// One export in flight per node, across all shops and threads (src/api/exportGate.ts).
// Taken before the per-shop limiter so a refusal for being busy does not spend the
// shop's export budget. Any table's store holds the shared slot; Shops is the smallest.
const { slot: exportSlot, shared: exportSlotShared } = sharedExportSlot(
	(Shops as unknown as { primaryStore?: Parameters<typeof sharedExportSlot>[0] }).primaryStore,
);
if (!exportSlotShared) log('warn', 'export.gate_per_thread', {});
const exportGate = createExportGate({ slot: exportSlot });

// CSV export of any filtered list. The SPA fetches it and downloads from a blob,
// since a browser navigation cannot carry the X-Shopify-Session-Token header.
// Bounded at MAX_EXPORT_ROWS; a truncated export says so in a response header and
// the UI, because silent truncation reads as "this is everything".
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
		return runExclusive(
			exportGate,
			() => this.buildExport(shopId, kind, url),
			() => {
				metrics.inc(M.exportBusy);
				log('warn', 'export.busy', { kind, retryAfterSeconds: EXPORT_BUSY_RETRY_SECONDS });
				return exportBusyResponse();
			},
		);
	}

	private async buildExport(shopId: string, kind: 'events' | 'findings' | 'orders', url: URL): Promise<Response> {
		const now = Date.now();
		const decision = exportLimiter.check(shopId, now);
		if (!decision.allowed) {
			metrics.inc(M.rateLimitedExports);
			log('warn', 'export.rate_limited', { kind, retryAfterSeconds: decision.retryAfterSeconds });
			throw new RateLimitError('exports', decision.retryAfterSeconds);
		}
		const p = url.searchParams;
		// Closures over the same query functions the screens use, so an export sees no row
		// the UI could not. collectExportRows (src/api/csv.ts) owns the cap and truncation
		// logic, which is unit-tested because a Resource class needs the Harper runtime.
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
