import type { Expectation, GapFinding, OperationalEvent, OrderProjection, Shop } from './model.ts';
import {
	clampLimit,
	decodeCursor,
	encodeCursor,
	pick,
	WINDOW_MS,
	WINDOW_DAYS,
	EVENT_FIELDS,
	FINDING_FIELDS,
	FINDING_LIST_FIELDS,
	PROJECTION_FIELDS,
	EXPECTATION_FIELDS,
	MAX_LIMIT,
	ORDER_FIELDS,
	ORDER_LIST_FIELDS,
} from './apiContract.ts';
import { describeFinding, detectorKey, DETECTOR_FAILED } from './detector.ts';
import { AGE_BUCKETS, ageBucketKey, ageHours, deriveOrderLane, isAwaitingConfirmation } from './orders.ts';
import { RECONCILE_STALE_MS } from './opsHealth.ts';

// Minimal search/get surface a Harper table exposes to the read layer. Every
// query below derives shopId from the authenticated principal (never caller
// input) and constrains the search by it — the tenant-isolation guarantee.
export interface QuerySpec {
	conditions: Array<{ attribute: string; value: unknown; comparator?: string }>;
	operator?: 'and' | 'or';
	sort?: { attribute: string; descending?: boolean };
	select?: string[];
	limit?: number;
}
export interface QueryTable {
	search(spec: QuerySpec): AsyncIterable<Record<string, unknown>>;
	get(id: string): Promise<Record<string, unknown> | undefined>;
}

export interface Page {
	items: Array<Record<string, unknown>>;
	nextCursor?: string;
}

// Keyset pagination over a numeric sort field with the row id as a tiebreak.
// Over-fetches a small buffer and finalizes the cursor boundary in code so
// equal-timestamp rows page correctly. `descending` is the default because every
// ledger view is newest-first; the orders worklist also needs oldest-first, where
// the most overdue order belongs at the top.
async function keysetPage(
	table: QueryTable,
	baseConditions: QuerySpec['conditions'],
	sortField: string,
	idField: string,
	fields: readonly string[],
	cursorRaw: string | undefined,
	limitRaw: unknown,
	descending = true,
): Promise<Page> {
	const limit = clampLimit(limitRaw);
	const cursor = decodeCursor(cursorRaw);
	const conditions = [...baseConditions];
	if (cursor) {
		conditions.push({
			attribute: sortField,
			value: cursor.sortValue,
			comparator: descending ? 'less_than_equal' : 'greater_than_equal',
		});
	}

	const rows: Array<Record<string, unknown>> = [];
	for await (const row of table.search({
		conditions,
		operator: 'and',
		sort: { attribute: sortField, descending },
		limit: limit + 25,
	})) {
		rows.push(row);
	}
	rows.sort((a, b) => {
		const av = Number(a[sortField]);
		const bv = Number(b[sortField]);
		if (av !== bv) return descending ? bv - av : av - bv;
		const aid = String(a[idField]);
		const bid = String(b[idField]);
		return descending ? bid.localeCompare(aid) : aid.localeCompare(bid);
	});

	let start = 0;
	if (cursor) {
		start = rows.findIndex((r) => {
			const v = Number(r[sortField]);
			const id = String(r[idField]);
			return descending
				? v < cursor.sortValue || (v === cursor.sortValue && id < cursor.id)
				: v > cursor.sortValue || (v === cursor.sortValue && id > cursor.id);
		});
		if (start < 0) start = rows.length;
	}
	const page = rows.slice(start, start + limit);
	const items = page.map((r) => pick(r, fields));
	let nextCursor: string | undefined;
	if (page.length === limit && page.length > 0) {
		const last = page[page.length - 1];
		const sortValue = Number(last[sortField]);
		// NEVER emit a cursor this module cannot decode. decodeCursor rejects a
		// non-finite sort value, so a row whose sort field is absent encodes to
		// "NaN|<id>" and decodes back to `undefined` — the next page then runs with
		// NO boundary condition, returns this same page again, and pages forever
		// (an export of such a list accumulated 5000 duplicate rows). Ending the
		// list is the only safe answer: a cursor that cannot be honoured is worse
		// than no cursor. Callers keep the sort field non-nullable so this is
		// insurance, not the normal path.
		if (Number.isFinite(sortValue)) nextCursor = encodeCursor(sortValue, String(last[idField]));
	}
	return { items, nextCursor };
}

// Attach each event's full SKU list. `skus` is not a column on OperationalEvent —
// an order has many and the row holds one scalar, deliberately set only when there
// is exactly one — so the list is assembled from the EventSku index.
//
// One OR query per PAGE, not per row: a keyed query per event would be up to
// MAX_LIMIT round trips to paint one screen. The tenant is re-checked on every
// index row because this query is keyed by event id, not by shop.
export async function hydrateSkus(
	eventSkus: QueryTable,
	shopId: string,
	items: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
	const ids = items.map((item) => String(item.eventId)).filter((id) => id.length > 0);
	if (ids.length === 0) return items;

	const byEvent = new Map<string, string[]>();
	for await (const row of eventSkus.search({
		conditions: ids.map((id) => ({ attribute: 'eventId', value: id })),
		operator: 'or',
		select: ['eventId', 'sku', 'shopId'],
	})) {
		if (row.shopId !== shopId) continue;
		const eventId = String(row.eventId);
		const list = byEvent.get(eventId) ?? [];
		list.push(String(row.sku));
		byEvent.set(eventId, list);
	}

	return items.map((item) => {
		const skus = byEvent.get(String(item.eventId));
		// Sorted so a rebuild or a different index scan order cannot reorder a cell.
		return skus && skus.length > 0 ? { ...item, skus: [...skus].sort() } : item;
	});
}

export interface EventQueryParams {
	domain?: string;
	topic?: string;
	resourceId?: string;
	sku?: string;
	source?: string;
	// Fulfillment state ('error' | 'failure' | 'success' | …), so a failed attempt
	// recorded by Shopify can be found directly among the raw events, not just via
	// the finding it produced.
	state?: string;
	since?: number;
	until?: number;
	cursor?: string;
	limit?: unknown;
}

// GET /events — the searchable 7-day operational ledger, tenant-scoped, filtered,
// cursor-paginated. The window floor is max(caller since, now − 7 days).
//
// A `sku` filter takes a different path: SKUs live in the EventSku index (one row
// per event/SKU) because an order has many and the event row holds one scalar.
// The index carries the other filterable fields, so the SKU path is an ordinary
// keyset page over EventSku followed by a keyed hydrate.
//
// ONE EXCEPTION: `state` is not an EventSku column, so on the SKU path it is
// applied AFTER hydration, from the event row itself. Spreading the full
// condition list into the index query (which is what happened when `state` was
// added later) meant `sku` and `state` together matched nothing at all: each
// filter worked alone, and the pair — two controls sitting side by side in the
// same filter bar — silently returned an empty page.
//
// Denormalizing `state` into EventSku was the alternative and is worse: index
// rows written before the column existed would not carry it, so the combination
// would UNDER-return for every historical row while looking like it worked. That
// is exactly the legacy-column failure C1 just demonstrated on the projection
// table, and it fails silently in the merchant's disfavour.
//
// The cost is that this one path can return a SHORT page — fewer items than the
// limit while `nextCursor` is still set. Not a new property: the hydration loop
// already skips index rows whose event has been purged.
export async function listEvents(
	events: QueryTable,
	shopId: string,
	now: number,
	params: EventQueryParams,
	eventSkus?: QueryTable,
): Promise<Page> {
	const windowStart = Math.max(params.since ?? 0, now - WINDOW_MS);
	const conditions: QuerySpec['conditions'] = [
		{ attribute: 'shopId', value: shopId },
		{ attribute: 'occurredAt', value: windowStart, comparator: 'greater_than_equal' },
	];
	if (params.until !== undefined) conditions.push({ attribute: 'occurredAt', value: params.until, comparator: 'less_than_equal' });
	// Conditions every EventSku row also carries, so they are safe to push into
	// either query. `state` is deliberately NOT here — see below.
	for (const [attr, val] of [
		['domain', params.domain],
		['topic', params.topic],
		['resourceId', params.resourceId],
		// `source` distinguishes webhook-observed from reconciliation-recovered
		// evidence (screen spec §3 "evidence source" filter).
		['source', params.source],
	] as const) {
		if (val) conditions.push({ attribute: attr, value: val });
	}

	if (params.sku && eventSkus) {
		const indexPage = await keysetPage(
			eventSkus,
			[...conditions, { attribute: 'sku', value: params.sku }],
			'occurredAt',
			'id',
			['eventId'],
			params.cursor,
			params.limit,
		);
		// One get per index row, but ISSUED TOGETHER: awaiting inside the loop meant an
		// export of a SKU-filtered list serialized up to MAX_EXPORT_ROWS round trips
		// inside one request. The tenant re-check below stays per-row.
		const fetched = await Promise.all(indexPage.items.map((row) => events.get(String(row.eventId))));
		const hydrated: Array<Record<string, unknown>> = [];
		for (const event of fetched) {
			// An index row whose event is gone (purged mid-page, or written before its
			// event landed) is skipped rather than surfaced as a phantom result.
			if (!event || event.shopId !== shopId) continue;
			// `state` lives on the event, not on the index, so it is applied here.
			if (params.state && event.state !== params.state) continue;
			hydrated.push(pick(event, EVENT_FIELDS));
		}
		return { items: await hydrateSkus(eventSkus, shopId, hydrated), nextCursor: indexPage.nextCursor };
	}

	// Off the index path `state` IS a column on the event row, so it filters in the
	// database like every other condition.
	if (params.state) conditions.push({ attribute: 'state', value: params.state });

	// No EventSku table wired (or no sku filter requested): fall back to the
	// scalar `sku` column directly. That column is only ever populated for a
	// single-SKU event, so this path still answers a single-SKU query correctly
	// when a caller hasn't (or can't) supply the index table.
	if (params.sku) conditions.push({ attribute: 'sku', value: params.sku });

	const page = await keysetPage(events, conditions, 'occurredAt', 'eventId', EVENT_FIELDS, params.cursor, params.limit);
	return { items: eventSkus ? await hydrateSkus(eventSkus, shopId, page.items) : page.items, nextCursor: page.nextCursor };
}

// GET /events/:id — one event plus lightweight relations. Cross-tenant safe: an
// event whose shopId differs from the principal returns null (not another
// tenant's data), regardless of the id supplied.
export async function getEventDetail(
	events: QueryTable,
	projections: QueryTable,
	findings: QueryTable,
	shopId: string,
	eventId: string,
	inventoryItems?: QueryTable,
	locations?: QueryTable,
	eventSkus?: QueryTable,
): Promise<Record<string, unknown> | null> {
	const row = (await events.get(eventId)) as OperationalEvent | undefined;
	if (!row || row.shopId !== shopId) return null;

	const relatedEventIds: string[] = [];
	if (row.resourceId) {
		for await (const r of events.search({
			conditions: [
				{ attribute: 'shopId', value: shopId },
				{ attribute: 'resourceId', value: row.resourceId },
			],
			operator: 'and',
			select: ['eventId'],
			limit: 50,
		})) {
			const id = (r as { eventId?: unknown }).eventId;
			if (typeof id === 'string' && id !== eventId) relatedEventIds.push(id);
		}
	}
	const orderId = row.resourceId;
	const affectedProjection = orderId ? Boolean(await projections.get(`${shopId}:${orderId}`)) : false;
	const affectedFinding = orderId ? Boolean(await findings.get(detectorKey(shopId, orderId))) : false;

	// Human-readable context for the opaque ids on an inventory event. Both are
	// keyed gets against this shop's own cache rows; a cache miss simply omits the
	// field rather than blocking the detail view.
	let inventorySku: string | undefined;
	let productTitle: string | undefined;
	if (row.domain === 'inventory' && row.resourceId && inventoryItems) {
		const item = await inventoryItems.get(`${shopId}:${row.resourceId}`);
		if (item && item.shopId === shopId) {
			inventorySku = typeof item.sku === 'string' ? item.sku : undefined;
			productTitle = typeof item.productTitle === 'string' ? item.productTitle : undefined;
		}
	}
	let locationName: string | undefined;
	if (row.locationId && locations) {
		const location = await locations.get(`${shopId}:${row.locationId}`);
		if (location && location.shopId === shopId) {
			locationName = typeof location.name === 'string' ? location.name : undefined;
		}
	}

	const base = {
		...pick(row as unknown as Record<string, unknown>, EVENT_FIELDS),
		relatedEventIds,
		affectedProjection,
		affectedFinding,
		...(inventorySku ? { inventorySku } : {}),
		...(productTitle ? { productTitle } : {}),
		...(locationName ? { locationName } : {}),
	};
	// Hydrated the same way as the list, so detail and list agree on a multi-SKU
	// event's SKUs rather than the list showing them and the detail not.
	if (!eventSkus) return base;
	const [hydrated] = await hydrateSkus(eventSkus, shopId, [base]);
	return hydrated;
}

export interface FindingQueryParams {
	status?: string;
	detector?: string;
	cursor?: string;
	limit?: unknown;
}

// GET /findings — tenant-scoped finding list, filterable by status, paginated.
// Each row is enriched with the two order facts the list columns need (paid time
// and the expected-confirmation deadline). The expectation shares the finding's
// key, so the join is a keyed get per row — bounded by the page limit — and both
// sources are tenant-checked before any field is copied.
export async function listFindings(
	findings: QueryTable,
	expectations: QueryTable,
	projections: QueryTable,
	shopId: string,
	params: FindingQueryParams,
): Promise<Page> {
	const conditions: QuerySpec['conditions'] = [{ attribute: 'shopId', value: shopId }];
	if (params.status) conditions.push({ attribute: 'status', value: params.status });
	if (params.detector) conditions.push({ attribute: 'detector', value: params.detector });
	const page = await keysetPage(findings, conditions, 'detectedAt', 'id', FINDING_FIELDS, params.cursor, params.limit);

	const items = await Promise.all(
		page.items.map(async (item) => {
			const id = String(item.id);
			const orderId = String(item.orderId);
			const [expectation, projection] = await Promise.all([expectations.get(id), projections.get(`${shopId}:${orderId}`)]);
			const paidAt = projection && projection.shopId === shopId ? (projection as unknown as OrderProjection).paidAt : undefined;
			const orderName = projection && projection.shopId === shopId ? (projection as unknown as OrderProjection).orderName : undefined;
			const deadline = expectation && expectation.shopId === shopId ? (expectation as unknown as Expectation).deadline : undefined;
			return pick({ ...item, paidAt, deadline, orderName }, FINDING_LIST_FIELDS);
		}),
	);
	return { items, nextCursor: page.nextCursor };
}

// GET /findings/:id — a finding with its detector expectation, order facts, and
// non-accusatory description. Cross-tenant safe.
export async function getFindingDetail(
	findings: QueryTable,
	expectations: QueryTable,
	projections: QueryTable,
	shopId: string,
	id: string,
): Promise<Record<string, unknown> | null> {
	const finding = (await findings.get(id)) as GapFinding | undefined;
	if (!finding || finding.shopId !== shopId) return null;
	const expectation = (await expectations.get(id)) as Expectation | undefined;
	const projection = (await projections.get(`${shopId}:${finding.orderId}`)) as OrderProjection | undefined;
	return {
		...pick(finding as unknown as Record<string, unknown>, FINDING_FIELDS),
		description: describeFinding(finding),
		expectation:
			expectation && expectation.shopId === shopId ? pick(expectation as unknown as Record<string, unknown>, EXPECTATION_FIELDS) : null,
		projection: projection ? pick(projection as unknown as Record<string, unknown>, PROJECTION_FIELDS) : null,
	};
}

export interface OrderQueryParams {
	state?: string;
	minAgeHours?: number;
	// Upper bound on age, so an aging BUCKET link can reproduce the bucket rather
	// than an open-ended threshold. The buckets are half-open intervals; without
	// this, "Under 24h: 1" opened the entire awaiting list.
	maxAgeHours?: number;
	sort?: 'oldest' | 'newest';
	cursor?: string;
	limit?: unknown;
}

// GET /orders — the operational worklist the Overview's counts drill into.
//
// Sorted and filtered in the DATABASE on the indexed `lastEventAt`, `paidAt` and
// `state` columns. Post-filtering in code was the alternative and is wrong here:
// it returns short pages and a `nextCursor` that implies more matches than exist.
//
// The SORT KEY is `lastEventAt`, which the projection reducer always writes —
// never `paidAt`, which is nullable. `orders/create` is subscribed and `paidAt`
// is only latched on payment, so every pending, authorized-not-captured, COD or
// draft order sits in this table with no `paidAt` at all; keysetting on it made
// the cursor for such a row undecodable and the worklist paged the same rows
// forever (C3). `sort` therefore means order of LAST OBSERVED ACTIVITY —
// 'newest' = most recent activity first, 'oldest' = least recent first, which is
// still what triage wants, because a quiet awaiting order's last activity IS its
// payment. The UI names the column it sorts on.
//
// `paidAt` remains a pure FILTER (minAgeHours), and `ageHours` stays derived from
// it per row rather than stored, because it changes every hour and a stored copy
// would be stale the moment it was written.
export async function listOrders(projections: QueryTable, shopId: string, now: number, params: OrderQueryParams): Promise<Page> {
	const windowStart = now - WINDOW_MS;
	const conditions: QuerySpec['conditions'] = [
		{ attribute: 'shopId', value: shopId },
		// Same window bound the flow lanes and the Overview tiles use (windowCondition),
		// so the worklist and the lane counts describe the same set of orders.
		windowCondition(windowStart),
	];
	if (params.state) conditions.push({ attribute: 'state', value: params.state });
	// Age bounds. `ageHours` floors, so the pair is exactly the half-open interval
	// [min, max) the aging buckets use, and the four buckets partition the awaiting
	// set with no gap and no double-count:
	//   "at least N hours old"      → paid at or before now − N hours
	//   "less than N hours old"     → paid strictly after   now − N hours
	// At the boundary paidAt = now − 48h: minAgeHours=48 includes it (<=),
	// maxAgeHours=48 excludes it (>), so it lands in exactly one bucket. Both are
	// filters on this shop's own rows, never a scope — shopId still comes from the
	// authenticated principal above.
	if (params.minAgeHours !== undefined && Number.isFinite(params.minAgeHours)) {
		conditions.push({ attribute: 'paidAt', value: now - params.minAgeHours * 3_600_000, comparator: 'less_than_equal' });
	}
	if (params.maxAgeHours !== undefined && Number.isFinite(params.maxAgeHours)) {
		conditions.push({ attribute: 'paidAt', value: now - params.maxAgeHours * 3_600_000, comparator: 'greater_than' });
	}

	const page = await keysetPage(
		projections,
		conditions,
		'lastEventAt',
		'id',
		ORDER_LIST_FIELDS,
		params.cursor,
		params.limit,
		params.sort !== 'oldest',
	);
	return {
		items: page.items.map((item) => {
			const hours = ageHours(item.paidAt as number | undefined, now);
			return hours === undefined ? item : { ...item, ageHours: hours };
		}),
		nextCursor: page.nextCursor,
	};
}

// GET /orders/:orderId — one order's latched facts, its normalized events in the
// window (newest first, bounded), and any findings about it. This is the
// order-centric forensics view: everything Sightline observed about one order,
// without needing a finding to exist first.
export async function getOrderDetail(
	projections: QueryTable,
	events: QueryTable,
	findings: QueryTable,
	shopId: string,
	now: number,
	orderId: string,
): Promise<Record<string, unknown> | null> {
	// Keyed by `${shopId}:${orderId}`, so a manipulated orderId can only ever miss.
	const projection = await projections.get(`${shopId}:${orderId}`);
	if (!projection || projection.shopId !== shopId) return null;

	const windowStart = now - WINDOW_MS;
	const eventRows: Array<Record<string, unknown>> = [];
	for await (const row of events.search({
		conditions: [
			{ attribute: 'shopId', value: shopId },
			{ attribute: 'resourceId', value: orderId },
			// Same window bound every other ledger view honors — retention purge lag
			// can otherwise leave older rows queryable after the window they belong to.
			{ attribute: 'occurredAt', value: windowStart, comparator: 'greater_than_equal' },
		],
		operator: 'and',
		sort: { attribute: 'occurredAt', descending: true },
		limit: MAX_LIMIT,
	})) {
		eventRows.push(pick(row, EVENT_FIELDS));
	}

	const findingRows: Array<Record<string, unknown>> = [];
	for await (const row of findings.search({
		conditions: [
			{ attribute: 'shopId', value: shopId },
			{ attribute: 'orderId', value: orderId },
		],
		operator: 'and',
	})) {
		findingRows.push({ ...pick(row, FINDING_FIELDS), description: describeFinding(row as unknown as GapFinding) });
	}

	// ageHours is computed per request, same as listOrders — it changes every
	// hour and a stored copy would be stale the moment it was written. Omitted
	// entirely (not zero) for an order that was never paid.
	const hours = ageHours(projection.paidAt as number | undefined, now);
	return {
		...pick(projection, ORDER_FIELDS),
		...(hours === undefined ? {} : { ageHours: hours }),
		events: eventRows,
		findings: findingRows,
	};
}

async function countWhere(table: QueryTable, conditions: QuerySpec['conditions']): Promise<number> {
	let n = 0;
	for await (const _r of table.search({ conditions, operator: 'and', select: conditions.length ? [conditions[0].attribute] : undefined }))
		n++;
	return n;
}

const DAY_MS = 86_400_000;
export const ACTIVITY_DOMAINS = ['order', 'fulfillment', 'inventory', 'refund'] as const;

// Reconciliation freshness for one shop, from the durable Shop record written by
// the reconcile sweep. `stale` uses the same threshold the operator-side health
// check uses, so the merchant-visible banner and the ops alert agree. A shop that
// has never completed a sweep is stale with a null age — the UI must not render
// that as "reconciled just now".
export interface ReconciliationView {
	lastReconciledAt?: number;
	ageMs: number | null;
	stale: boolean;
	state: string;
}
export function reconciliationView(shop: Shop | undefined, now: number): ReconciliationView {
	const lastReconciledAt = shop?.lastReconciledAt;
	const ageMs = lastReconciledAt === undefined ? null : Math.max(0, now - lastReconciledAt);
	return {
		...(lastReconciledAt === undefined ? {} : { lastReconciledAt }),
		ageMs,
		stale: ageMs === null || ageMs > RECONCILE_STALE_MS,
		state: shop?.reconciliationState ?? 'pending',
	};
}

// Per-day event counts by domain across the read window — the Overview's
// "activity over time" (screen spec §2). Bounded to WINDOW_DAYS buckets, and
// derived from the same single event scan that produces the window total, so it
// adds no extra pass over the ledger. Buckets are ascending (oldest first).
function emptyBuckets(windowStart: number): Array<Record<string, number>> {
	return Array.from({ length: WINDOW_DAYS }, (_unused, i) => {
		const bucket: Record<string, number> = { startAt: windowStart + i * DAY_MS, total: 0 };
		for (const domain of ACTIVITY_DOMAINS) bucket[domain] = 0;
		return bucket;
	});
}

// One definition of "in the read window" for every order-derived count, so the
// Overview's tiles, the flow lanes, and the worklist can never describe different
// sets of orders. Retention usually keeps expired projections out of the table
// anyway, but "usually" is not a guarantee: a purge run capped at
// MAX_DELETES_PER_RUN leaves residue behind, and that residue must not surface in
// one panel and not another.
//
// The same predicate is available as an INDEXABLE condition, and the two order
// scans below push it into the search (windowCondition) as well as keeping this
// code-side check as a belt. Without it, getSummary — which runs on every screen
// load behind a 15s cache — scanned every projection the shop had ever stored and
// filtered in code.
function inWindow(p: OrderProjection, windowStart: number): boolean {
	return (p.lastEventAt ?? 0) >= windowStart;
}

// listOrders uses the identical condition, so all three surfaces bound the set the
// same way, in the database. `lastEventAt` is @indexed for exactly this.
function windowCondition(windowStart: number): QuerySpec['conditions'][number] {
	return { attribute: 'lastEventAt', value: windowStart, comparator: 'greater_than_equal' };
}

// GET /summary — the Overview screen's counts. Recorder health is separate from
// the finding count: an unhealthy recorder cannot claim "no gaps" (screen spec).
export async function getSummary(
	tables: { events: QueryTable; projections: QueryTable; findings: QueryTable; deliveries: QueryTable; shops: QueryTable },
	shopId: string,
	now: number,
): Promise<Record<string, unknown>> {
	const windowStart = now - WINDOW_MS;
	const buckets = emptyBuckets(windowStart);
	let eventsTotal = 0;
	// Capture-integrity tally. An event whose only source is a reconciliation sweep
	// is one that did NOT arrive as a webhook — the failure class merchants cannot
	// otherwise see. It is evidence about OUR capture path, not proof about anyone
	// else's: every app's subscription is independent, and our own downtime is an
	// alternative explanation. The UI copy carries that boundary.
	let webhookEvents = 0;
	let reconciliationOnlyEvents = 0;
	for await (const e of tables.events.search({
		conditions: [
			{ attribute: 'shopId', value: shopId },
			{ attribute: 'occurredAt', value: windowStart, comparator: 'greater_than_equal' },
		],
		operator: 'and',
		select: ['occurredAt', 'domain', 'source'],
	})) {
		eventsTotal++;
		// `else` is a CATCH-ALL, not a test for 'webhook': any future `source` value
		// would be silently counted as webhook-observed. That is tolerable only while
		// this number is a denominator on the integrity panel and links nowhere —
		// EventSource has exactly two values today, and the two counts sum to the
		// total, which is the property the panel relies on. Give `webhookEvents` a link
		// into a filtered event list and this becomes a real defect (a count that
		// opens a smaller set than it claims): add the explicit `=== 'webhook'` branch
		// and a third bucket at that point, not after.
		if (String(e.source) === 'reconciliation') reconciliationOnlyEvents++;
		else webhookEvents++;
		const index = Math.min(WINDOW_DAYS - 1, Math.max(0, Math.floor((Number(e.occurredAt) - windowStart) / DAY_MS)));
		const bucket = buckets[index];
		bucket.total++;
		const domain = String(e.domain);
		if (domain in bucket) bucket[domain]++;
	}
	const deadLettered = await countWhere(tables.deliveries, [
		{ attribute: 'shopId', value: shopId },
		{ attribute: 'status', value: 'dead_letter' },
	]);
	const shop = (await tables.shops.get(shopId)) as Shop | undefined;

	let ordersTracked = 0;
	let paid = 0;
	let fulfilled = 0;
	let awaitingConfirmation = 0;
	// Aging of the awaiting set, so the Overview can show what is heading for the
	// 72-hour deadline while it can still be acted on — not just what already
	// blew it. Zero-filled so every bucket renders.
	const agingCounts: Record<string, number> = Object.fromEntries(AGE_BUCKETS.map((b) => [b.key, 0]));
	for await (const p of tables.projections.search({
		conditions: [{ attribute: 'shopId', value: shopId }, windowCondition(windowStart)],
		operator: 'and',
	})) {
		const proj = p as unknown as OrderProjection;
		if (!inWindow(proj, windowStart)) continue;
		ordersTracked++;
		if (proj.paidAt !== undefined) paid++;
		// "Fulfilled" here means the lane, not just "has a fulfilledAt" — an order
		// fulfilled and then cancelled or fully refunded must not count as both.
		// deriveOrderLane is the same finality-ordered definition computeFlows and
		// listOrders' state column use, so this tile and those two can never
		// disagree about the same order.
		if (deriveOrderLane(proj) === 'fulfilled') fulfilled++;
		if (isAwaitingConfirmation(proj)) {
			awaitingConfirmation++;
			const key = ageBucketKey(proj.paidAt, now);
			if (key !== undefined) agingCounts[key]++;
		}
	}

	const findingCounts: Record<string, number> = { unconfirmed: 0, resolved: 0, suppressed: 0 };
	// Failed attempts are counted separately as well as inside `unconfirmed`: they
	// are DIRECT evidence (Shopify recorded an attempt that did not succeed) rather
	// than an inference from absence, so they deserve their own headline — but they
	// are still unconfirmed findings, so removing them from that count would make
	// the two numbers contradict each other.
	let failedAttempts = 0;
	for await (const f of tables.findings.search({ conditions: [{ attribute: 'shopId', value: shopId }] })) {
		const finding = f as unknown as GapFinding;
		if (finding.status in findingCounts) findingCounts[finding.status]++;
		if (finding.detector === DETECTOR_FAILED && finding.status === 'unconfirmed') failedAttempts++;
	}

	return {
		shop: shopId,
		windowDays: WINDOW_DAYS,
		events: { total: eventsTotal },
		orders: { tracked: ordersTracked, paid, fulfilled, awaitingConfirmation },
		aging: { buckets: AGE_BUCKETS.map((b) => ({ key: b.key, label: b.label, count: agingCounts[b.key] })) },
		findings: { ...findingCounts, failedAttempts },
		recorder: { healthy: deadLettered === 0, deadLetteredDeliveries: deadLettered },
		reconciliation: reconciliationView(shop, now),
		activity: { days: WINDOW_DAYS, domains: [...ACTIVITY_DOMAINS], buckets },
		integrity: { webhookEvents, reconciliationOnlyEvents },
	};
}

// GET /flows — bounded lane counts derived from order projections in the window.
// A pure function of the projections, so it reconciles to fixtures and rebuilds.
// Lanes come from deriveOrderLane, the same definition the worklist and the
// summary use, so the three views cannot disagree.
export async function computeFlows(projections: QueryTable, shopId: string, now: number): Promise<Record<string, unknown>> {
	const windowStart = now - WINDOW_MS;
	const lanes = { paid: 0, fulfilled: 0, awaitingConfirmation: 0, noFulfillmentExpected: 0, cancelled: 0, refunded: 0 };
	for await (const p of projections.search({
		conditions: [{ attribute: 'shopId', value: shopId }, windowCondition(windowStart)],
		operator: 'and',
	})) {
		const proj = p as unknown as OrderProjection;
		if (!inWindow(proj, windowStart)) continue;
		if (proj.paidAt !== undefined) lanes.paid++;
		switch (deriveOrderLane(proj)) {
			case 'fulfilled':
				lanes.fulfilled++;
				break;
			// Paid, live, no fulfillment observed and none expected (a digital order).
			// It gets its own lane rather than being folded into 'fulfilled', which
			// would assert a fulfillment nobody observed, or left out of the breakdown
			// entirely, which would make a digital-only store's flow panel read as all
			// zeroes beside a non-zero Paid count.
			case 'no_fulfillment_expected':
				lanes.noFulfillmentExpected++;
				break;
			case 'cancelled':
				lanes.cancelled++;
				break;
			case 'refunded':
				lanes.refunded++;
				break;
			case 'awaiting':
				lanes.awaitingConfirmation++;
				break;
			default:
				break;
		}
	}
	return { shop: shopId, windowDays: WINDOW_DAYS, lanes };
}

// Customer fields Sightline deliberately never records. Stated positively on the
// Privacy screen so a merchant (and an app reviewer) can see the exclusion list,
// not just the inclusion list (screen spec §5).
export const EXCLUDED_CUSTOMER_FIELDS = ['customer name', 'customer email', 'customer phone', 'shipping & billing address'] as const;

// GET /privacy — the app's data-handling contract, this shop's footprint, and the
// capture/reconciliation health that makes the zero-configuration service
// auditable (screen spec §5). Deliberately returns NO secrets, token material,
// internal host/cluster names, or cross-tenant metrics: scopes are the granted
// OAuth scope strings, and every count is constrained to this shop.
// The outbox keeps a longer, separate retention than the seven-day ledger purge
// (OUTBOX_RETENTION_DAYS, src/ledgerTargets.ts) — duplicated here as a literal
// rather than an import, because ledgerTargets.ts pulls in db.ts's `import {
// databases } from 'harper'`, a module with no resolvable file under plain node
// (see test/ledgerTargets.test.ts, which hits the same wall). A test in
// queries.test.ts reads that file's source and pins this literal against the
// real constant, so the two numbers cannot silently drift apart.
const DIGEST_OUTBOX_RETENTION_DAYS = 30;

export async function getPrivacy(
	tables: {
		events: QueryTable;
		findings: QueryTable;
		projections: QueryTable;
		deliveries: QueryTable;
		shops: QueryTable;
		digestSubscriptions?: QueryTable;
	},
	shopId: string,
	now: number,
): Promise<Record<string, unknown>> {
	const footprint = {
		events: await countWhere(tables.events, [{ attribute: 'shopId', value: shopId }]),
		orders: await countWhere(tables.projections, [{ attribute: 'shopId', value: shopId }]),
		findings: await countWhere(tables.findings, [{ attribute: 'shopId', value: shopId }]),
	};
	const shop = (await tables.shops.get(shopId)) as Shop | undefined;

	// Whether a notification address is on file for this shop — stated, never
	// echoed. The address is the merchant's own and is shown on the Notifications
	// screen; repeating it here would make an audit endpoint into a second place it
	// can leak from.
	const subscription = tables.digestSubscriptions ? await tables.digestSubscriptions.get(shopId) : undefined;
	const notifications = {
		emailStored: Boolean(subscription && subscription.shopId === shopId && subscription.email),
		...(subscription && subscription.shopId === shopId && typeof subscription.cadence === 'string'
			? { cadence: subscription.cadence }
			: {}),
		status: subscription && subscription.shopId === shopId && subscription.status === 'active' ? 'active' : 'paused',
	};

	let received = 0;
	let processed = 0;
	let deadLettered = 0;
	let lastReceivedAt: number | undefined;
	for await (const d of tables.deliveries.search({
		conditions: [{ attribute: 'shopId', value: shopId }],
		select: ['status', 'receivedAt'],
	})) {
		received++;
		const status = String(d.status);
		if (status === 'processed') processed++;
		else if (status === 'dead_letter') deadLettered++;
		const at = Number(d.receivedAt);
		if (Number.isFinite(at) && (lastReceivedAt === undefined || at > lastReceivedAt)) lastReceivedAt = at;
	}

	return {
		shop: shopId,
		retentionDays: WINDOW_DAYS,
		storesCustomerPii: false,
		// Shopify returns granted scopes as a comma-separated string.
		scopes: (shop?.scopes ?? '')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean),
		// Exactly what the pipeline stores, in merchant language. Every entry here
		// must be true of the current schema — this list is read by merchants and by
		// App Store reviewers, so a stale entry is a compliance defect, not cosmetics.
		dataCategories: [
			'order status & timestamps',
			'order name (e.g. #1001)',
			'order value & currency',
			'fulfillment status, location, tracking presence & carrier',
			'inventory levels',
			'refund status',
			'SKUs, product & variant titles & quantities',
			'notification email you supply for digests (merchant contact, not customer data)',
		],
		excludedFields: [...EXCLUDED_CUSTOMER_FIELDS],
		deletion: {
			onUninstall: 'shop data erased',
			onRequest: 'shop/customer redaction (targeted delete)',
			// Two separate windows, both real: the ledger's seven-day purge, and the
			// digest outbox's own, independently-tracked 30-day purge (it outlives the
			// ledger on purpose — see DigestOutbox in docs/data-inventory.md). Stating
			// only one would understate retention for the other.
			automatic: `${WINDOW_DAYS}-day retention purge; digest outbox rows are kept separately for ${DIGEST_OUTBOX_RETENTION_DAYS} days, then removed`,
		},
		notifications,
		footprint,
		webhooks: {
			received,
			processed,
			deadLettered,
			healthy: deadLettered === 0,
			...(lastReceivedAt === undefined ? {} : { lastReceivedAt }),
		},
		reconciliation: reconciliationView(shop, now),
	};
}

// GET /setup — the first-open screen's progress (screen spec §1). Every step is
// derived from DURABLE backend state, never a client timer: the shop record for
// install, an observed delivery for capture, and the reconcile sweep's own
// completion marker for the initial check. `action` names the one safe recovery a
// merchant can take when a step is stuck — reauthorization is surfaced only from
// the credential's own status, and no token material is read or returned.
export async function getSetup(
	tables: { shops: QueryTable; deliveries: QueryTable; credentials: QueryTable },
	shopId: string,
	now: number,
): Promise<Record<string, unknown>> {
	const shop = (await tables.shops.get(shopId)) as Shop | undefined;
	const credential = (await tables.credentials.get(shopId)) as { status?: string } | undefined;
	const reconciliation = reconciliationView(shop, now);

	let deliveriesSeen = 0;
	for await (const _d of tables.deliveries.search({ conditions: [{ attribute: 'shopId', value: shopId }], select: ['id'], limit: 1 })) {
		deliveriesSeen++;
	}

	const installed = shop?.status === 'active' && shop.installedAt !== undefined;
	const reauthNeeded = credential?.status === 'reauthorization_required' || shop?.status === 'reauthorization_required';
	// "Connected" is the credential, not a delivery. Shopify registers the declared
	// subscriptions during install, so a usable credential IS the durable proof the
	// subscriptions are in place. Deliveries are the 7-day ledger and get purged —
	// keying this step on them would flip a perfectly healthy but QUIET store back
	// to "not set up" a week after install. Whether anything has actually arrived is
	// reported separately as `eventsObserved`, so the UI can say "connected, no
	// events yet" without ever claiming capture it has not seen.
	const connected = credential !== undefined && !reauthNeeded;
	const initialCheckDone = reconciliation.state === 'ready' && reconciliation.lastReconciledAt !== undefined;

	const steps = [
		{ key: 'installed', label: 'Installed', state: installed ? 'done' : 'pending' },
		{
			key: 'capture',
			label: 'Webhooks connected',
			state: reauthNeeded ? 'blocked' : connected ? 'done' : 'waiting',
		},
		{
			key: 'initialCheck',
			label: 'Initial check',
			state: reauthNeeded ? 'blocked' : initialCheckDone ? 'done' : 'running',
		},
	];

	return {
		shop: shopId,
		complete: steps.every((s) => s.state === 'done'),
		steps,
		eventsObserved: deliveriesSeen > 0,
		action: reauthNeeded ? 'reauthorize' : 'none',
	};
}
