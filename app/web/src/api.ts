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

async function get<T>(path: string): Promise<T> {
	const token = await shopify.idToken();
	const res = await nativeFetch()(path, { headers: { 'X-Shopify-Session-Token': token } });
	if (!res.ok) {
		let detail = '';
		try {
			detail = ((await res.json()) as { title?: string; error?: string }).error ?? '';
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
	findings: { unconfirmed: number; resolved: number; suppressed: number };
	recorder: { healthy: boolean; deadLetteredDeliveries: number };
	reconciliation: Reconciliation;
	activity: { days: number; domains: string[]; buckets: ActivityBucket[] };
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
}
export interface FindingItem {
	id: string;
	orderId: string;
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
	footprint: { events: number; orders: number; findings: number };
	webhooks: { received: number; processed: number; deadLettered: number; healthy: boolean; lastReceivedAt?: number };
	reconciliation: Reconciliation;
}
export interface Page<T> {
	items: T[];
	nextCursor?: string;
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
