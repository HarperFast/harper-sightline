import type { EventDomain, Expectation, GapFinding, OperationalEvent, OrderProjection, Shop } from '../domain/model.ts';
import { eventKind, MATCH_MARGIN_MS } from '../domain/eventKind.ts';
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
import { describeFinding, detectorKey, DETECTOR_FAILED } from '../domain/detector.ts';
import { AGE_BUCKETS, ageBucketKey, ageHours, deriveOrderLane, isAwaitingConfirmation } from '../domain/orders.ts';
import { OUTBOX_RETENTION_DAYS } from '../retention/retention.ts';
import { RECONCILE_STALE_MS } from '../observability/opsHealth.ts';

// Minimal search/get surface a Harper table exposes to the read layer. Every query
// derives shopId from the authenticated principal and constrains the search by it.
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

// Keyset pagination over a numeric sort field with the row id as tiebreak; the
// over-fetched buffer lets equal-timestamp rows page correctly.
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
		// A cursor must be one decodeCursor accepts: a row with no sort value would encode
		// "NaN|<id>", decode to no boundary, and page the same rows forever. End the list instead.
		if (Number.isFinite(sortValue)) nextCursor = encodeCursor(sortValue, String(last[idField]));
	}
	return { items, nextCursor };
}

// `skus` is not a column (an order has many; the row holds one scalar only for a
// single-SKU event), so the list is assembled from the EventSku index with one OR
// query per page. The tenant is re-checked per index row because the query keys on event id.
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
		// Harper rejects an `or` over fewer than two conditions, so a single id uses `and`.
		operator: ids.length > 1 ? 'or' : 'and',
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
		// Sorted so index scan order cannot reorder a cell.
		return skus && skus.length > 0 ? { ...item, skus: [...skus].sort() } : item;
	});
}

export interface EventQueryParams {
	domain?: string;
	topic?: string;
	resourceId?: string;
	sku?: string;
	source?: string;
	// Fulfillment state ('error' | 'failure' | 'success' | ...), searchable among raw events.
	state?: string;
	since?: number;
	until?: number;
	cursor?: string;
	limit?: unknown;
}

// GET /events: the 7-day tenant-scoped ledger, cursor-paginated; the window floor is
// max(caller since, now - 7 days).
//
// A `sku` filter pages the EventSku index (an order has many SKUs) and then hydrates
// the events. `state` is not an EventSku column, so on that path it is applied after
// hydration from the event row, which can return a short page with `nextCursor` set.
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
	// Conditions every EventSku row also carries; `state` is not one of them.
	for (const [attr, val] of [
		['domain', params.domain],
		['topic', params.topic],
		['resourceId', params.resourceId],
		// webhook-observed versus reconciliation-recovered evidence.
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
		// Gets are issued together; awaiting inside the loop serialized up to MAX_EXPORT_ROWS round trips.
		const fetched = await Promise.all(indexPage.items.map((row) => events.get(String(row.eventId))));
		const hydrated: Array<Record<string, unknown>> = [];
		for (const event of fetched) {
			// Skip an index row whose event was purged or has not landed.
			if (!event || event.shopId !== shopId) continue;
			if (params.state && event.state !== params.state) continue;
			hydrated.push(pick(event, EVENT_FIELDS));
		}
		return { items: await hydrateSkus(eventSkus, shopId, hydrated), nextCursor: indexPage.nextCursor };
	}

	// Off the index path `state` is a column on the event row.
	if (params.state) conditions.push({ attribute: 'state', value: params.state });

	// No EventSku table wired or no sku filter: fall back to the scalar `sku` column,
	// which is only set for a single-SKU event.
	if (params.sku) conditions.push({ attribute: 'sku', value: params.sku });

	const page = await keysetPage(events, conditions, 'occurredAt', 'eventId', EVENT_FIELDS, params.cursor, params.limit);
	return { items: eventSkus ? await hydrateSkus(eventSkus, shopId, page.items) : page.items, nextCursor: page.nextCursor };
}

// GET /events/:id: one event plus relations; an event of another tenant returns null.
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

	// Keyed gets on this shop's own cache rows; a miss omits the field.
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
	// Hydrated like the list so detail and list agree on a multi-SKU event.
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

// GET /findings: tenant-scoped, filterable by status. Each row gets the order's paid
// time and the confirmation deadline via a keyed get on the expectation (same key as
// the finding), tenant-checked before any field is copied.
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

// GET /findings/:id: a finding with its expectation and order facts. Cross-tenant safe.
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
	// Upper age bound, so an aging bucket link reproduces its half-open interval.
	maxAgeHours?: number;
	sort?: 'oldest' | 'newest';
	cursor?: string;
	limit?: unknown;
}

// GET /orders: the worklist the Overview counts drill into. Sorted and filtered in
// the database; post-filtering would return short pages and a misleading `nextCursor`.
//
// The sort key is `lastEventAt`, which the reducer always writes, never the nullable
// `paidAt` (a null sort value makes the cursor undecodable). `sort` therefore means
// order of last observed activity. `paidAt` is only a filter (minAgeHours), and
// `ageHours` is derived per row because a stored value goes stale hourly.
export async function listOrders(projections: QueryTable, shopId: string, now: number, params: OrderQueryParams): Promise<Page> {
	const windowStart = now - WINDOW_MS;
	const conditions: QuerySpec['conditions'] = [
		{ attribute: 'shopId', value: shopId },
		// Same window bound as the flow lanes and Overview tiles.
		windowCondition(windowStart),
	];
	if (params.state) conditions.push({ attribute: 'state', value: params.state });
	// `ageHours` floors, so minAgeHours (<=) and maxAgeHours (>) form the half-open
	// interval [min, max) the aging buckets use: a boundary order lands in exactly one bucket.
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

// GET /orders/:orderId: the order's latched facts, its events in the window
// (newest first, bounded), and any findings about it.
export async function getOrderDetail(
	projections: QueryTable,
	events: QueryTable,
	findings: QueryTable,
	shopId: string,
	now: number,
	orderId: string,
): Promise<Record<string, unknown> | null> {
	// Keyed by shopId, so a manipulated orderId can only miss.
	const projection = await projections.get(`${shopId}:${orderId}`);
	if (!projection || projection.shopId !== shopId) return null;

	const windowStart = now - WINDOW_MS;
	const eventRows: Array<Record<string, unknown>> = [];
	for await (const row of events.search({
		conditions: [
			{ attribute: 'shopId', value: shopId },
			{ attribute: 'resourceId', value: orderId },
			// Same window bound as every other ledger view; purge lag can leave older rows queryable.
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

	// Computed per request like listOrders; omitted (not zero) for an order never paid.
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

// Reconciliation freshness from the Shop record. `stale` uses the operator health
// threshold; a shop that never completed a sweep is stale with a null age.
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

// Per-day event counts by domain across the read window (WINDOW_DAYS buckets,
// ascending), derived from the same event scan as the window total.
function emptyBuckets(windowStart: number): Array<Record<string, number>> {
	return Array.from({ length: WINDOW_DAYS }, (_unused, i) => {
		const bucket: Record<string, number> = { startAt: windowStart + i * DAY_MS, total: 0 };
		for (const domain of ACTIVITY_DOMAINS) bucket[domain] = 0;
		return bucket;
	});
}

// One definition of "in the read window" for every order-derived count. Retention
// usually keeps expired projections out, but purge residue must not surface in one
// panel and not another. The scans also push the predicate into the search
// (windowCondition) and keep this code-side check as a belt.
function inWindow(p: OrderProjection, windowStart: number): boolean {
	return (p.lastEventAt ?? 0) >= windowStart;
}

// Identical to listOrders' condition; `lastEventAt` is @indexed for it.
function windowCondition(windowStart: number): QuerySpec['conditions'][number] {
	return { attribute: 'lastEventAt', value: windowStart, comparator: 'greater_than_equal' };
}

// GET /summary: the Overview counts. Recorder health is separate from the finding
// count so an unhealthy recorder cannot claim "no gaps".
export async function getSummary(
	tables: { events: QueryTable; projections: QueryTable; findings: QueryTable; deliveries: QueryTable; shops: QueryTable },
	shopId: string,
	now: number,
): Promise<Record<string, unknown>> {
	const windowStart = now - WINDOW_MS;
	const buckets = emptyBuckets(windowStart);
	let eventsTotal = 0;
	// `webhookEvents` is a tally of rows whose `source` is not 'reconciliation' (a
	// catch-all, not a test for 'webhook'; add that branch if it ever links to a list).
	// `reconciliationOnlyEvents` counts a reconciliation event only when no webhook event
	// with the same (resourceId, kind) exists in the window (src/domain/eventKind.ts),
	// because the sweep rewrites every order it touches and a webhook twin is normal.
	//
	// Matching is best-effort: the two paths take `occurredAt` from different fields
	// (src/ingest/normalize.ts vs src/shopify/reconcile.ts), so a twin can straddle
	// `windowStart`. The query is widened by MATCH_MARGIN_MS and only `webhookKeys`
	// sees the margin rows; every tally is gated back to `occurredAt >= windowStart`.
	// There is no upper margin because the window's upper edge is `now`.
	//
	// A matched reconciliation event is counted in neither tally, so the two no longer
	// sum to `eventsTotal`.
	let webhookEvents = 0;
	const webhookKeys = new Set<string>();
	const reconciliationCandidates: Array<{ resourceId: string; kind: ReturnType<typeof eventKind> }> = [];
	for await (const e of tables.events.search({
		conditions: [
			{ attribute: 'shopId', value: shopId },
			// Widened below windowStart by MATCH_MARGIN_MS; see above.
			{ attribute: 'occurredAt', value: windowStart - MATCH_MARGIN_MS, comparator: 'greater_than_equal' },
		],
		operator: 'and',
		select: ['occurredAt', 'domain', 'source', 'resourceId', 'state', 'topic'],
	})) {
		const occurredAt = Number(e.occurredAt);
		const resourceId = typeof e.resourceId === 'string' ? e.resourceId : undefined;
		const kind = eventKind({ domain: e.domain as EventDomain, state: e.state as string | undefined, topic: e.topic as string | undefined });
		const isReconciliation = String(e.source) === 'reconciliation';
		// Recognise-only index of webhook twins, built from the widened fetch; never a tally.
		if (!isReconciliation && resourceId !== undefined && kind !== undefined) webhookKeys.add(`${resourceId}:${kind}`);
		// Margin rows are fetched only for `webhookKeys`, not counted.
		if (occurredAt < windowStart) continue;
		eventsTotal++;
		if (isReconciliation) {
			// A reconciliation event of unknown kind is never a gap candidate (eventKind.ts).
			if (resourceId !== undefined && kind !== undefined) reconciliationCandidates.push({ resourceId, kind });
		} else {
			webhookEvents++;
		}
		const index = Math.min(WINDOW_DAYS - 1, Math.max(0, Math.floor((occurredAt - windowStart) / DAY_MS)));
		const bucket = buckets[index];
		bucket.total++;
		const domain = String(e.domain);
		if (domain in bucket) bucket[domain]++;
	}
	// Counts reconciliation kinds absent from the webhook set; no second query.
	let reconciliationOnlyEvents = 0;
	for (const c of reconciliationCandidates) {
		if (!webhookKeys.has(`${c.resourceId}:${c.kind}`)) reconciliationOnlyEvents++;
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
	// Aging of the awaiting set, zero-filled so every bucket renders.
	const agingCounts: Record<string, number> = Object.fromEntries(AGE_BUCKETS.map((b) => [b.key, 0]));
	for await (const p of tables.projections.search({
		conditions: [{ attribute: 'shopId', value: shopId }, windowCondition(windowStart)],
		operator: 'and',
	})) {
		const proj = p as unknown as OrderProjection;
		if (!inWindow(proj, windowStart)) continue;
		ordersTracked++;
		if (proj.paidAt !== undefined) paid++;
		// The lane, not just "has a fulfilledAt": an order fulfilled then cancelled or
		// refunded must not count as both. deriveOrderLane is shared with computeFlows and listOrders.
		if (deriveOrderLane(proj) === 'fulfilled') fulfilled++;
		if (isAwaitingConfirmation(proj)) {
			awaitingConfirmation++;
			const key = ageBucketKey(proj.paidAt, now);
			if (key !== undefined) agingCounts[key]++;
		}
	}

	const findingCounts: Record<string, number> = { unconfirmed: 0, resolved: 0, suppressed: 0 };
	// Counted inside `unconfirmed` as well as on their own: direct evidence of a failed
	// attempt, but still unconfirmed findings.
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

// GET /flows: lane counts from the window's projections, via deriveOrderLane (the
// same definition as the worklist and summary).
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
			// Paid, live, nothing expected (a digital order): its own lane, not 'fulfilled'.
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

// Customer fields Sightline never records, stated on the Privacy screen.
export const EXCLUDED_CUSTOMER_FIELDS = ['customer name', 'customer email', 'customer phone', 'shipping & billing address'] as const;

// GET /privacy: the data-handling contract and this shop's footprint. Returns no
// secrets, token material, host names or cross-tenant metrics; counts are shop-scoped.
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

	// Stated, never echoed: the address is shown on the Notifications screen only.
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
		scopes: (shop?.scopes ?? '')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean),
		// Exactly what the pipeline stores, read by merchants and App Store reviewers: a
		// stale entry is a compliance defect.
		dataCategories: [
			'order status & timestamps',
			'order name (e.g. #1001)',
			'order value & currency',
			'fulfillment status, location, tracking presence & carrier',
			'inventory levels',
			'refund status',
			'SKUs, product & variant titles & quantities',
			'notification email you supply for digests (merchant contact, not customer data)',
			// The DigestOutbox record (no body column), distinct from the address; counts and
			// subject line only, which is why it can outlive the seven-day ledger.
			'digest record: counts and subject line only, kept 30 days (no order names or customer data)',
		],
		excludedFields: [...EXCLUDED_CUSTOMER_FIELDS],
		deletion: {
			onUninstall: 'shop data erased',
			onRequest: 'shop/customer redaction (targeted delete)',
			// Two windows: the ledger's seven-day purge and the outbox's 30-day purge
			// (docs/data-inventory.md).
			automatic: `${WINDOW_DAYS}-day retention purge; digest records (counts and subject line only, no order names or customer data) are kept separately for ${OUTBOX_RETENTION_DAYS} days, then removed`,
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

// GET /setup: first-open progress, derived from durable backend state (shop record,
// an observed delivery, the reconcile completion marker). `action` names the one
// safe recovery for a stuck step; no token material is read or returned.
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
	// "Connected" is the credential, not a delivery: deliveries are purged after a week
	// and would flip a quiet store back to "not set up". `eventsObserved` is separate.
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
