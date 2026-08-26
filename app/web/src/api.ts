// Data client for the read API (#15). App Bridge patches window.fetch to inject
// `Authorization: Bearer`, which Harper 401s before our resource runs — so
// index.html captures the native fetch into `window.__sightlineFetch` BEFORE
// App Bridge loads, and we use that here with our own X-Shopify-Session-Token.
// Session tokens are short-lived (~1 min), so a fresh one is fetched per call.

declare const shopify: { idToken(): Promise<string> };

declare global {
	interface Window {
		__sightlineFetch?: typeof fetch;
		__SIGHTLINE_SESSION__?: Session;
	}
}

const nativeFetch = (): typeof fetch => (window.__sightlineFetch ?? window.fetch).bind(window);

// What a failing response actually says. Harper reports an error as
// `{type, code, title, status, instance}` — the message is in `title` — and our own
// resources throw with a plain message that serializes as a bare JSON string. This
// used to read only `error`, which neither shape has, so EVERY failure reached the
// merchant as a bare "500" with no cause: diagnosing a real one (a query Harper
// refused to run) cost a round trip through the live instance. Empty on an
// unreadable body, so the status alone is still shown rather than nothing.
export function errorDetail(body: unknown): string {
	if (typeof body === 'string') return body.trim();
	if (body && typeof body === 'object') {
		const { title, error, message } = body as { title?: unknown; error?: unknown; message?: unknown };
		for (const candidate of [title, error, message]) {
			if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
		}
	}
	return '';
}

async function get<T>(path: string): Promise<T> {
	const token = await shopify.idToken();
	const res = await nativeFetch()(path, { headers: { 'X-Shopify-Session-Token': token } });
	if (!res.ok) {
		let detail = '';
		try {
			detail = errorDetail(await res.json());
		} catch {
			// no JSON body
		}
		throw new Error(`${res.status}${detail ? ` ${detail}` : ''}`);
	}
	return res.json() as Promise<T>;
}

export interface Session {
	shop: string;
	user: string;
	capabilities: Record<string, boolean>;
	// The store's configured IANA timezone. Absent until the first reconcile sweep
	// caches it; callers fall back to the viewer's zone.
	timezone?: string;
	// Support channels, absent when the deployment has not configured them. Never
	// a fabricated address.
	support?: { email?: string; url?: string };
}
export interface Reconciliation {
	lastReconciledAt?: number;
	ageMs: number | null;
	stale: boolean;
	state: string;
}
export interface ActivityBucket {
	startAt: number;
	total: number;
	[domain: string]: number;
}
export interface Summary {
	shop: string;
	windowDays: number;
	events: { total: number };
	orders: { tracked: number; paid: number; fulfilled: number; awaitingConfirmation: number };
	aging: { buckets: Array<{ key: string; label: string; count: number }> };
	findings: { unconfirmed: number; resolved: number; suppressed: number; failedAttempts: number };
	recorder: { healthy: boolean; deadLetteredDeliveries: number };
	reconciliation: Reconciliation;
	activity: { days: number; domains: string[]; buckets: ActivityBucket[] };
	integrity: { webhookEvents: number; reconciliationOnlyEvents: number };
}
export interface SetupStep {
	key: string;
	label: string;
	state: 'done' | 'pending' | 'waiting' | 'running' | 'blocked';
}
export interface Setup {
	shop: string;
	complete: boolean;
	steps: SetupStep[];
	// Whether any delivery has actually been observed. Distinct from the capture
	// step's "connected": a quiet store is connected with nothing observed yet.
	eventsObserved: boolean;
	action: 'reauthorize' | 'none';
}
export interface Flows {
	lanes: { paid: number; fulfilled: number; awaitingConfirmation: number; cancelled: number; refunded: number };
}
export interface EventItem {
	eventId: string;
	domain: string;
	topic?: string;
	resourceId?: string;
	sku?: string;
	// The full SKU list, hydrated from the EventSku index. Preferred over `sku`
	// (a scalar populated only for a single-SKU event) whenever present.
	skus?: string[];
	quantity?: number;
	fulfillableItemCount?: number;
	state?: string;
	source: string;
	occurredAt: number;
	receivedAt: number;
}
export interface EventDetail extends EventItem {
	relatedEventIds: string[];
	affectedProjection: boolean;
	affectedFinding: boolean;
	// Present only for an inventory event whose item id / location id resolved
	// against this shop's cache.
	inventorySku?: string;
	productTitle?: string;
	locationName?: string;
}
export interface FindingItem {
	id: string;
	orderId: string;
	orderName?: string;
	// Which detector wrote this finding ('fulfillment_confirmation' | 'fulfillment_attempt_failed').
	// Absent on rows written before this column existed — those must still be
	// treated as the absence detector (src/detector.ts DETECTOR), never as unknown.
	detector?: string;
	ruleVersion?: number;
	status: string;
	detectedAt?: number;
	resolvedAt?: number;
	evidenceEventIds?: string[];
	paidAt?: number;
	deadline?: number;
}
export interface FindingDetail extends FindingItem {
	description: string;
	expectation: { state?: string; deadline?: number; createdAt?: number; resolvedAt?: number } | null;
	projection: {
		orderId?: string;
		paidAt?: number;
		requiresFulfillment?: boolean;
		fulfilledAt?: number;
		cancelledAt?: number;
		fullyRefundedAt?: number;
		orderName?: string;
	} | null;
}
export interface Privacy {
	shop: string;
	retentionDays: number;
	storesCustomerPii: boolean;
	scopes: string[];
	dataCategories: string[];
	excludedFields: string[];
	deletion: Record<string, string>;
	notifications: { emailStored: boolean; cadence?: string; status: string };
	footprint: { events: number; orders: number; findings: number };
	webhooks: { received: number; processed: number; deadLettered: number; healthy: boolean; lastReceivedAt?: number };
	reconciliation: Reconciliation;
}
export interface OrderItem {
	orderId: string;
	orderName?: string;
	state: string;
	paidAt?: number;
	fulfilledAt?: number;
	cancelledAt?: number;
	fullyRefundedAt?: number;
	fulfillmentFailedAt?: number;
	hasTracking?: boolean;
	trackingCompany?: string;
	orderTotal?: number;
	currency?: string;
	lastEventAt?: number;
	ageHours?: number;
}
export interface OrderDetail extends OrderItem {
	requiresFulfillment?: boolean;
	fulfillableItemCount?: number;
	events: EventItem[];
	findings: Array<FindingItem & { description: string }>;
}
export interface Page<T> {
	items: T[];
	nextCursor?: string;
}
export interface DigestSettings {
	email?: string;
	cadence: string;
	status: string;
	lastBuiltAt?: number;
}

const qs = (params: Record<string, string | undefined>): string => {
	const p = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
	const s = p.toString();
	return s ? `?${s}` : '';
};

export const apiSession = () => get<Session>('/api/v1/session');
export const apiSetup = () => get<Setup>('/api/v1/setup');
export const apiSummary = () => get<Summary>('/api/v1/summary');
export const apiFlows = () => get<Flows>('/api/v1/flows');
export const apiEvents = (params: Record<string, string | undefined>) => get<Page<EventItem>>(`/api/v1/events${qs(params)}`);
export const apiEvent = (id: string) => get<EventDetail>(`/api/v1/events/${encodeURIComponent(id)}`);
export const apiFindings = (params: Record<string, string | undefined>) => get<Page<FindingItem>>(`/api/v1/findings${qs(params)}`);
export const apiFinding = (id: string) => get<FindingDetail>(`/api/v1/findings/${encodeURIComponent(id)}`);
export const apiPrivacy = () => get<Privacy>('/api/v1/privacy');
export const apiOrders = (params: Record<string, string | undefined>) => get<Page<OrderItem>>(`/api/v1/orders${qs(params)}`);
export const apiOrder = (orderId: string) => get<OrderDetail>(`/api/v1/orders/${encodeURIComponent(orderId)}`);
export const apiDigest = () => get<DigestSettings>('/api/v1/digest');

// The one write the SPA performs, and it writes Sightline's own settings.
export async function apiSaveDigest(body: { email?: string; cadence?: string; status?: string }): Promise<DigestSettings> {
	const token = await shopify.idToken();
	const res = await nativeFetch()('/api/v1/digest', {
		method: 'PUT',
		headers: { 'X-Shopify-Session-Token': token, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		let detail = '';
		try {
			detail = ((await res.json()) as { error?: string }).error ?? '';
		} catch {
			// no JSON body
		}
		throw new Error(`${res.status}${detail ? ` ${detail}` : ''}`);
	}
	return res.json() as Promise<DigestSettings>;
}

// Export is a file, not JSON, so it bypasses get<T>(): the same session-token
// header, but the body is text and the row-count/truncation signals come back as
// response headers.
export async function apiExport(
	kind: string,
	params: Record<string, string | undefined>,
): Promise<{ csv: string; truncated: boolean; rows: number; filename: string }> {
	const token = await shopify.idToken();
	const res = await nativeFetch()(`/api/v1/export/${encodeURIComponent(kind)}.csv${qs(params)}`, {
		headers: { 'X-Shopify-Session-Token': token },
	});
	// Carries the server's own detail, like get() does: an export can now be refused
	// with a wait time (rate limiting, src/auth/rateLimit.ts), and a bare "429" is not
	// something a merchant can act on.
	if (!res.ok) {
		let detail = '';
		try {
			detail = errorDetail(await res.json());
		} catch {
			// no JSON body
		}
		throw new Error(`${res.status}${detail ? ` ${detail}` : ''}`);
	}
	const disposition = res.headers.get('content-disposition') ?? '';
	const match = disposition.match(/filename="([^"]+)"/);
	return {
		csv: await res.text(),
		truncated: res.headers.get('x-sightline-truncated') === 'true',
		rows: Number(res.headers.get('x-sightline-row-count') ?? 0),
		filename: match ? match[1] : `sightline-${kind}.csv`,
	};
}
