import type { Expectation, GapFinding, OperationalEvent, OrderProjection } from './model.ts';
import {
	clampLimit,
	decodeCursor,
	encodeCursor,
	pick,
	WINDOW_MS,
	EVENT_FIELDS,
	FINDING_FIELDS,
	PROJECTION_FIELDS,
	EXPECTATION_FIELDS,
} from './apiContract.ts';
import { describeFinding, detectorKey } from './detector.ts';

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

// Keyset pagination over a descending numeric sort field with the row id as a
// tiebreak. Over-fetches a small buffer and finalizes the cursor boundary in
// code so equal-timestamp rows page correctly.
async function keysetPageDesc(
	table: QueryTable,
	baseConditions: QuerySpec['conditions'],
	sortField: string,
	idField: string,
	fields: readonly string[],
	cursorRaw: string | undefined,
	limitRaw: unknown,
): Promise<Page> {
	const limit = clampLimit(limitRaw);
	const cursor = decodeCursor(cursorRaw);
	const conditions = [...baseConditions];
	if (cursor) conditions.push({ attribute: sortField, value: cursor.sortValue, comparator: 'less_than_equal' });

	const rows: Array<Record<string, unknown>> = [];
	for await (const row of table.search({
		conditions,
		operator: 'and',
		sort: { attribute: sortField, descending: true },
		limit: limit + 25,
	})) {
		rows.push(row);
	}
	rows.sort((a, b) => Number(b[sortField]) - Number(a[sortField]) || String(b[idField]).localeCompare(String(a[idField])));

	let start = 0;
	if (cursor) {
		start = rows.findIndex(
			(r) => Number(r[sortField]) < cursor.sortValue || (Number(r[sortField]) === cursor.sortValue && String(r[idField]) < cursor.id),
		);
		if (start < 0) start = rows.length;
	}
	const page = rows.slice(start, start + limit);
	const items = page.map((r) => pick(r, fields));
	let nextCursor: string | undefined;
	if (page.length === limit && page.length > 0) {
		const last = page[page.length - 1];
		nextCursor = encodeCursor(Number(last[sortField]), String(last[idField]));
	}
	return { items, nextCursor };
}

export interface EventQueryParams {
	domain?: string;
	topic?: string;
	resourceId?: string;
	sku?: string;
	since?: number;
	until?: number;
	cursor?: string;
	limit?: unknown;
}

// GET /events — the searchable 7-day operational ledger, tenant-scoped, filtered,
// cursor-paginated. The window floor is max(caller since, now − 7 days).
export async function listEvents(events: QueryTable, shopId: string, now: number, params: EventQueryParams): Promise<Page> {
	const windowStart = Math.max(params.since ?? 0, now - WINDOW_MS);
	const conditions: QuerySpec['conditions'] = [
		{ attribute: 'shopId', value: shopId },
		{ attribute: 'occurredAt', value: windowStart, comparator: 'greater_than_equal' },
	];
	if (params.until !== undefined) conditions.push({ attribute: 'occurredAt', value: params.until, comparator: 'less_than_equal' });
	for (const [attr, val] of [
		['domain', params.domain],
		['topic', params.topic],
		['resourceId', params.resourceId],
		['sku', params.sku],
	] as const) {
		if (val) conditions.push({ attribute: attr, value: val });
	}
	return keysetPageDesc(events, conditions, 'occurredAt', 'eventId', EVENT_FIELDS, params.cursor, params.limit);
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
	const affectedFinding = orderId ? Boolean(await findings.get(detectorKey(orderId))) : false;

	return { ...pick(row as unknown as Record<string, unknown>, EVENT_FIELDS), relatedEventIds, affectedProjection, affectedFinding };
}

export interface FindingQueryParams {
	status?: string;
	cursor?: string;
	limit?: unknown;
}

// GET /findings — tenant-scoped finding list, filterable by status, paginated.
export async function listFindings(findings: QueryTable, shopId: string, params: FindingQueryParams): Promise<Page> {
	const conditions: QuerySpec['conditions'] = [{ attribute: 'shopId', value: shopId }];
	if (params.status) conditions.push({ attribute: 'status', value: params.status });
	return keysetPageDesc(findings, conditions, 'detectedAt', 'id', FINDING_FIELDS, params.cursor, params.limit);
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

async function countWhere(table: QueryTable, conditions: QuerySpec['conditions']): Promise<number> {
	let n = 0;
	for await (const _r of table.search({ conditions, operator: 'and', select: conditions.length ? [conditions[0].attribute] : undefined }))
		n++;
	return n;
}

// GET /summary — the Overview screen's counts. Recorder health is separate from
// the finding count: an unhealthy recorder cannot claim "no gaps" (screen spec).
export async function getSummary(
	tables: { events: QueryTable; projections: QueryTable; findings: QueryTable; deliveries: QueryTable },
	shopId: string,
	now: number,
): Promise<Record<string, unknown>> {
	const windowStart = now - WINDOW_MS;
	const eventsTotal = await countWhere(tables.events, [
		{ attribute: 'shopId', value: shopId },
		{ attribute: 'occurredAt', value: windowStart, comparator: 'greater_than_equal' },
	]);
	const deadLettered = await countWhere(tables.deliveries, [
		{ attribute: 'shopId', value: shopId },
		{ attribute: 'status', value: 'dead_letter' },
	]);

	let ordersTracked = 0;
	let paid = 0;
	let fulfilled = 0;
	let awaitingConfirmation = 0;
	for await (const p of tables.projections.search({ conditions: [{ attribute: 'shopId', value: shopId }] })) {
		const proj = p as unknown as OrderProjection;
		ordersTracked++;
		if (proj.paidAt !== undefined) paid++;
		if (proj.fulfilledAt !== undefined) fulfilled++;
		if (
			proj.paidAt !== undefined &&
			proj.requiresFulfillment &&
			proj.fulfilledAt === undefined &&
			proj.cancelledAt === undefined &&
			proj.fullyRefundedAt === undefined
		) {
			awaitingConfirmation++;
		}
	}

	const findingCounts: Record<string, number> = { unconfirmed: 0, resolved: 0, suppressed: 0 };
	for await (const f of tables.findings.search({ conditions: [{ attribute: 'shopId', value: shopId }] })) {
		const status = (f as unknown as GapFinding).status;
		if (status in findingCounts) findingCounts[status]++;
	}

	return {
		shop: shopId,
		windowDays: WINDOW_MS / 86_400_000,
		events: { total: eventsTotal },
		orders: { tracked: ordersTracked, paid, fulfilled, awaitingConfirmation },
		findings: findingCounts,
		recorder: { healthy: deadLettered === 0, deadLetteredDeliveries: deadLettered },
	};
}

// GET /flows — bounded lane counts derived from order projections in the window.
// A pure function of the projections, so it reconciles to fixtures and rebuilds.
export async function computeFlows(projections: QueryTable, shopId: string, now: number): Promise<Record<string, unknown>> {
	const windowStart = now - WINDOW_MS;
	const lanes = { paid: 0, fulfilled: 0, awaitingConfirmation: 0, cancelled: 0, refunded: 0 };
	for await (const p of projections.search({ conditions: [{ attribute: 'shopId', value: shopId }] })) {
		const proj = p as unknown as OrderProjection;
		if ((proj.lastEventAt ?? 0) < windowStart) continue;
		if (proj.paidAt !== undefined) lanes.paid++;
		if (proj.fulfilledAt !== undefined) lanes.fulfilled++;
		if (proj.cancelledAt !== undefined) lanes.cancelled++;
		if (proj.fullyRefundedAt !== undefined) lanes.refunded++;
		if (
			proj.paidAt !== undefined &&
			proj.requiresFulfillment &&
			proj.fulfilledAt === undefined &&
			proj.cancelledAt === undefined &&
			proj.fullyRefundedAt === undefined
		) {
			lanes.awaitingConfirmation++;
		}
	}
	return { shop: shopId, windowDays: WINDOW_MS / 86_400_000, lanes };
}

// GET /privacy — the app's data-handling contract plus this shop's footprint.
export async function getPrivacy(
	tables: { events: QueryTable; findings: QueryTable; projections: QueryTable },
	shopId: string,
): Promise<Record<string, unknown>> {
	const footprint = {
		events: await countWhere(tables.events, [{ attribute: 'shopId', value: shopId }]),
		orders: await countWhere(tables.projections, [{ attribute: 'shopId', value: shopId }]),
		findings: await countWhere(tables.findings, [{ attribute: 'shopId', value: shopId }]),
	};
	return {
		shop: shopId,
		retentionDays: WINDOW_MS / 86_400_000,
		storesCustomerPii: false,
		dataCategories: [
			'order status & timestamps',
			'fulfillment status & tracking presence',
			'inventory levels',
			'refund status',
			'SKUs & quantities',
		],
		deletion: {
			onUninstall: 'shop data erased',
			onRequest: 'shop/customer redaction (targeted delete)',
			automatic: 'seven-day retention purge',
		},
		footprint,
	};
}
