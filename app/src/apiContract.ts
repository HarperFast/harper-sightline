// Versioned API contract (#15). Single source of truth for the response-field
// ALLOWLISTS of every query resource — responses expose only these fields, so a
// schema change can never leak a new column. `scripts/gen-contract.mjs` writes
// contracts/sightline-api-v1.json from this module; a CI test asserts they match.

export const API_VERSION = 'v1';
export const WINDOW_DAYS = 7; // bounded read window (matches the retention window)
export const WINDOW_MS = WINDOW_DAYS * 86_400_000;
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

// ── Response field allowlists ────────────────────────────────────────────────
// No raw payloads, no customer-identifying fields (none exist in the model, but
// allowlisting keeps it that way as the schema grows).
export const EVENT_FIELDS = [
	'eventId',
	'domain',
	'topic',
	'resourceId',
	'sku',
	'quantity',
	'fulfillableItemCount',
	'state',
	'source',
	'occurredAt',
	'receivedAt',
] as const;
export const FINDING_FIELDS = ['id', 'orderId', 'ruleVersion', 'status', 'detectedAt', 'resolvedAt', 'evidenceEventIds'] as const;
// The findings LIST additionally carries the two order facts the screen spec's
// list columns need (paid time, expected confirmation). They are joined from the
// projection/expectation and allowlisted here so the join can never widen.
export const FINDING_LIST_FIELDS = [...FINDING_FIELDS, 'paidAt', 'deadline'] as const;
export const PROJECTION_FIELDS = [
	'orderId',
	'paidAt',
	'requiresFulfillment',
	'fulfilledAt',
	'cancelledAt',
	'fullyRefundedAt',
	'lastEventAt',
] as const;
export const EXPECTATION_FIELDS = ['state', 'deadline', 'createdAt', 'resolvedAt'] as const;

// The contract artifact shape (also what gen-contract.mjs serializes).
export const API_CONTRACT = {
	version: API_VERSION,
	windowDays: WINDOW_DAYS,
	pagination: { style: 'cursor', defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT },
	resources: {
		session: { path: '/api/v1/session', fields: ['shop', 'user', 'capabilities', 'timezone', 'support'] },
		setup: { path: '/api/v1/setup', fields: ['shop', 'complete', 'steps', 'eventsObserved', 'action'] },
		summary: {
			path: '/api/v1/summary',
			fields: ['shop', 'windowDays', 'events', 'orders', 'findings', 'recorder', 'reconciliation', 'activity'],
		},
		events: {
			path: '/api/v1/events',
			item: EVENT_FIELDS,
			paginated: true,
			filters: ['domain', 'topic', 'resourceId', 'sku', 'source', 'since', 'until', 'cursor', 'limit'],
		},
		eventDetail: { path: '/api/v1/events/:id', fields: [...EVENT_FIELDS, 'relatedEventIds', 'affectedProjection', 'affectedFinding'] },
		flows: { path: '/api/v1/flows', fields: ['shop', 'windowDays', 'lanes'] },
		findings: { path: '/api/v1/findings', item: FINDING_LIST_FIELDS, paginated: true, filters: ['status', 'cursor', 'limit'] },
		findingDetail: { path: '/api/v1/findings/:id', fields: [...FINDING_FIELDS, 'description', 'projection', 'expectation'] },
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
				'footprint',
				'webhooks',
				'reconciliation',
			],
		},
	},
} as const;

// Return a shallow copy of `row` with only the allowlisted keys that are present.
export function pick<T extends Record<string, unknown>>(row: T, fields: readonly string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const field of fields) {
		if (row[field] !== undefined && row[field] !== null) out[field] = row[field];
	}
	return out;
}

// Clamp a caller-supplied limit into [1, MAX_LIMIT], defaulting when absent/invalid.
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
