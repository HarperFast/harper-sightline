// Versioned API contract: the single source of the response-field allowlists, so a
// schema change cannot leak a new column. `scripts/gen-contract.mjs` writes
// contracts/sightline-api-v1.json from it; a CI test asserts they match.

import { API_REQUESTS_PER_MINUTE, EXPORTS_PER_MINUTE, RATE_WINDOW_MS } from '../auth/rateLimit.ts';

export const API_VERSION = 'v1';
export const WINDOW_DAYS = 7; // bounded read window (matches the retention window)
export const WINDOW_MS = WINDOW_DAYS * 86_400_000;
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

export const EVENT_FIELDS = [
	'eventId',
	'domain',
	'topic',
	'resourceId',
	'sku',
	'quantity',
	'fulfillableItemCount',
	'orderName',
	'totalPrice',
	'currency',
	'locationId',
	'hasTracking',
	'trackingCompany',
	'shipmentStatus',
	'state',
	'source',
	'occurredAt',
	'receivedAt',
] as const;
// The events list adds the full SKU list; `sku` stays a scalar for a single-SKU
// event. Allowlisted separately so the join cannot widen the base fields.
export const EVENT_LIST_FIELDS = [...EVENT_FIELDS, 'skus'] as const;
export const FINDING_FIELDS = [
	'id',
	'orderId',
	'detector',
	'ruleVersion',
	'status',
	'detectedAt',
	'resolvedAt',
	'evidenceEventIds',
] as const;
// The findings list adds the order's paid time and confirmation deadline, joined
// from the projection and expectation.
export const FINDING_LIST_FIELDS = [...FINDING_FIELDS, 'paidAt', 'deadline', 'orderName'] as const;
export const PROJECTION_FIELDS = [
	'orderId',
	'paidAt',
	'requiresFulfillment',
	'fulfilledAt',
	'cancelledAt',
	'fullyRefundedAt',
	'lastEventAt',
	'orderName',
	'orderTotal',
	'currency',
	'fulfillmentFailedAt',
	'hasTracking',
	'trackingCompany',
] as const;
export const EXPECTATION_FIELDS = ['state', 'deadline', 'createdAt', 'resolvedAt'] as const;

// The orders worklist. `ageHours` is computed per request, not stored.
export const ORDER_LIST_FIELDS = [
	'orderId',
	'orderName',
	'state',
	'paidAt',
	'fulfilledAt',
	'cancelledAt',
	'fullyRefundedAt',
	'fulfillmentFailedAt',
	'hasTracking',
	'trackingCompany',
	'orderTotal',
	'currency',
	'lastEventAt',
	'ageHours',
] as const;
// `fulfillableItemCount` is not here: projection.ts never writes it (the reducer
// latches `requiresFulfillment` from a positive count instead).
export const ORDER_FIELDS = [...ORDER_LIST_FIELDS, 'requiresFulfillment'] as const;

export const API_CONTRACT = {
	version: API_VERSION,
	windowDays: WINDOW_DAYS,
	pagination: { style: 'cursor', defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT },
	// Per-shop request limits (src/auth/rateLimit.ts), caller-visible: exceeding either
	// is an HTTP 429 stating how many seconds to wait. Enforced per worker thread, so a
	// deployment admits a multiple of these; they bound one shop's demand and are not a
	// DoS control.
	rateLimits: {
		windowSeconds: RATE_WINDOW_MS / 1000,
		requests: API_REQUESTS_PER_MINUTE,
		exports: EXPORTS_PER_MINUTE,
		status: 429,
	},
	resources: {
		session: { path: '/api/v1/session', fields: ['shop', 'user', 'capabilities', 'timezone', 'support'] },
		setup: { path: '/api/v1/setup', fields: ['shop', 'complete', 'steps', 'eventsObserved', 'action'] },
		summary: {
			path: '/api/v1/summary',
			fields: ['shop', 'windowDays', 'events', 'orders', 'aging', 'findings', 'recorder', 'reconciliation', 'activity', 'integrity'],
		},
		events: {
			path: '/api/v1/events',
			item: EVENT_LIST_FIELDS,
			paginated: true,
			filters: ['domain', 'topic', 'resourceId', 'sku', 'source', 'state', 'since', 'until', 'cursor', 'limit'],
		},
		eventDetail: {
			path: '/api/v1/events/:id',
			fields: [
				...EVENT_FIELDS,
				'skus',
				'relatedEventIds',
				'affectedProjection',
				'affectedFinding',
				'inventorySku',
				'productTitle',
				'locationName',
			],
		},
		flows: { path: '/api/v1/flows', fields: ['shop', 'windowDays', 'lanes'] },
		findings: { path: '/api/v1/findings', item: FINDING_LIST_FIELDS, paginated: true, filters: ['status', 'detector', 'cursor', 'limit'] },
		findingDetail: { path: '/api/v1/findings/:id', fields: [...FINDING_FIELDS, 'description', 'projection', 'expectation'] },
		orders: {
			path: '/api/v1/orders',
			item: ORDER_LIST_FIELDS,
			paginated: true,
			filters: ['state', 'minAgeHours', 'maxAgeHours', 'sort', 'cursor', 'limit'],
		},
		orderDetail: { path: '/api/v1/orders/:orderId', fields: [...ORDER_FIELDS, 'events', 'findings'] },
		export: {
			path: '/api/v1/export/:kind.csv',
			kinds: ['events', 'findings', 'orders'],
			format: 'text/csv',
			maxRows: 5000,
		},
		privacy: {
			path: '/api/v1/privacy',
			fields: [
				'shop',
				'retentionDays',
				'storesCustomerPii',
				'scopes',
				'dataCategories',
				'excludedFields',
				'deletion',
				'notifications',
				'footprint',
				'webhooks',
				'reconciliation',
			],
		},
		digest: {
			path: '/api/v1/digest',
			fields: ['email', 'cadence', 'status', 'lastBuiltAt'],
			// The app's only write surface; it writes Sightline's own configuration, never Shopify data.
			methods: ['GET', 'PUT'],
		},
	},
} as const;

export function pick<T extends Record<string, unknown>>(row: T, fields: readonly string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const field of fields) {
		if (row[field] !== undefined && row[field] !== null) out[field] = row[field];
	}
	return out;
}

export function clampLimit(limit: unknown): number {
	const n = typeof limit === 'number' ? limit : typeof limit === 'string' ? Number(limit) : NaN;
	if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
	return Math.min(Math.floor(n), MAX_LIMIT);
}

// Opaque keyset cursor over a descending numeric sort field (occurredAt /
// detectedAt) plus the row id as a tiebreak. Encoded so callers treat it as opaque.
export function encodeCursor(sortValue: number, id: string): string {
	return Buffer.from(`${sortValue}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { sortValue: number; id: string } | undefined {
	if (!cursor) return undefined;
	try {
		const [sv, ...rest] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
		const sortValue = Number(sv);
		const id = rest.join('|');
		if (!Number.isFinite(sortValue) || !id) return undefined;
		return { sortValue, id };
	} catch {
		return undefined;
	}
}
