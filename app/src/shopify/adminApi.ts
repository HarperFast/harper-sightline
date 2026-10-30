// Shopify Admin GraphQL client for reconciliation. Read-only, using the stored
// offline token; only fields we already normalize.

const API_VERSION = '2026-07';

// Node's fetch has no default timeout; an unbounded hang wedged the reconcile sweep
// (src/jobs/tick.ts). Bounding it makes the hang an ordinary error the next tick retries.
export const ADMIN_TIMEOUT_MS = 30_000;

interface GraphqlBody<T> {
	data?: T;
	errors?: Array<{ message: string; extensions?: { code?: unknown } }>;
}

// A GraphQL "Access denied for <field>" error means the token's scopes do not cover
// the field: no retry succeeds until the app requests the scope and the merchant
// re-authorizes. This is the one failure that must be distinguishable from a blip.
const ACCESS_DENIED_RE = /access denied/i;

// Duck-typed `permanent` flag, as PermanentNormalizeError (src/ingest/normalize.ts),
// so callers need no shared class hierarchy.
export class PermanentAdminApiError extends Error {
	readonly permanent = true;
	constructor(message: string) {
		super(message);
		this.name = 'PermanentAdminApiError';
	}
}

export function isPermanentAdminError(err: unknown): boolean {
	return typeof err === 'object' && err !== null && (err as { permanent?: unknown }).permanent === true;
}

// Shopify rate limiting: transient, but counted apart from a fault because it means
// the sweep asked for more than the shop's quota. Carries no retry-after: the sweep
// aborts, the 10-minute schedule retries (far longer than the throttle window), and
// sweepOrdersSince persists partial progress, so sleeping would only stall a tick.
export class ThrottledAdminApiError extends Error {
	readonly throttled = true;
	readonly statusCode: number | undefined;
	constructor(message: string, statusCode?: number) {
		super(message);
		this.name = 'ThrottledAdminApiError';
		this.statusCode = statusCode;
	}
}

export function isThrottledAdminError(err: unknown): boolean {
	return typeof err === 'object' && err !== null && (err as { throttled?: unknown }).throttled === true;
}

export async function adminGraphql<T>(
	shop: string,
	token: string,
	query: string,
	variables: Record<string, unknown>,
	fetchImpl: typeof fetch = fetch,
): Promise<T> {
	const res = await fetchImpl(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
		body: JSON.stringify({ query, variables }),
		// A timeout rejects like any transient failure; it has no statusCode, so isAuthError
		// does not burn a token rotation on it.
		signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS),
	});
	if (!res.ok) {
		if (res.status === 429) throw new ThrottledAdminApiError(`admin graphql ${res.status}`, res.status);
		const e = new Error(`admin graphql ${res.status}`) as Error & { statusCode: number };
		e.statusCode = res.status;
		throw e;
	}
	const body = (await res.json()) as GraphqlBody<T>;
	if (body.errors?.length) {
		const message = body.errors.map((x) => x.message).join('; ');
		if (ACCESS_DENIED_RE.test(message)) throw new PermanentAdminApiError(`admin graphql errors: ${message}`);
		// A GraphQL throttle is an HTTP 200 with extensions.code, invisible to the status
		// check above; match the code, not the message.
		if (body.errors.some((x) => String(x.extensions?.code).toUpperCase() === 'THROTTLED')) {
			throw new ThrottledAdminApiError(`admin graphql errors: ${message}`);
		}
		throw new Error(`admin graphql errors: ${message}`);
	}
	if (!body.data) throw new Error('admin graphql: empty data');
	return body.data;
}

export interface ReconcileOrder {
	orderId: string;
	financialStatus?: string;
	fulfillmentStatus?: string;
	createdAt?: number;
	updatedAt?: number;
	cancelledAt?: number;
	fulfillableUnits: number;
	fulfilledAt?: number;
}

// gid://shopify/Order/123 -> "123", matching the webhooks' numeric resourceId.
export function numericId(gid: unknown): string | undefined {
	if (typeof gid !== 'string') return undefined;
	const m = gid.match(/(\d+)\s*$/);
	return m ? m[1] : undefined;
}

function epoch(iso: unknown): number | undefined {
	if (typeof iso !== 'string') return undefined;
	const ms = Date.parse(iso);
	return Number.isNaN(ms) ? undefined : ms;
}

interface OrderNode {
	id?: unknown;
	createdAt?: unknown;
	updatedAt?: unknown;
	cancelledAt?: unknown;
	displayFinancialStatus?: unknown;
	displayFulfillmentStatus?: unknown;
	lineItems?: { nodes?: Array<{ quantity?: unknown; requiresShipping?: unknown }> };
	fulfillments?: Array<{ status?: unknown; createdAt?: unknown }>;
}

// Shapes a raw order node into the minimal reconcile record (approved fields only).
export function toReconcileOrder(node: OrderNode): ReconcileOrder | null {
	const orderId = numericId(node.id);
	if (!orderId) return null;
	let fulfillableUnits = 0;
	for (const li of node.lineItems?.nodes ?? []) {
		if (li.requiresShipping !== false) fulfillableUnits += Number(li.quantity ?? 0) || 0;
	}
	const success = (node.fulfillments ?? []).find((f) => String(f.status).toUpperCase() === 'SUCCESS');
	return {
		orderId,
		financialStatus: typeof node.displayFinancialStatus === 'string' ? node.displayFinancialStatus : undefined,
		fulfillmentStatus: typeof node.displayFulfillmentStatus === 'string' ? node.displayFulfillmentStatus : undefined,
		createdAt: epoch(node.createdAt),
		updatedAt: epoch(node.updatedAt),
		cancelledAt: epoch(node.cancelledAt),
		fulfillableUnits,
		fulfilledAt: success ? epoch(success.createdAt) : undefined,
	};
}

const ORDERS_QUERY = `query($q:String!,$cursor:String){orders(first:50,query:$q,after:$cursor,sortKey:UPDATED_AT){edges{cursor node{id createdAt updatedAt cancelledAt displayFinancialStatus displayFulfillmentStatus lineItems(first:100){nodes{quantity requiresShipping}} fulfillments(first:20){status createdAt}}}pageInfo{hasNextPage}}}`;

export async function fetchOrdersUpdatedSince(
	shop: string,
	token: string,
	sinceMs: number,
	cursor?: string,
	fetchImpl: typeof fetch = fetch,
): Promise<{ orders: ReconcileOrder[]; nextCursor?: string }> {
	const q = `updated_at:>='${new Date(sinceMs).toISOString()}'`;
	const data = await adminGraphql<{ orders: { edges: Array<{ cursor: string; node: OrderNode }>; pageInfo: { hasNextPage: boolean } } }>(
		shop,
		token,
		ORDERS_QUERY,
		{ q, cursor: cursor ?? null },
		fetchImpl,
	);
	const orders: ReconcileOrder[] = [];
	let last: string | undefined;
	for (const edge of data.orders.edges) {
		const order = toReconcileOrder(edge.node);
		if (order) orders.push(order);
		last = edge.cursor;
	}
	return { orders, nextCursor: data.orders.pageInfo.hasNextPage ? last : undefined };
}

// The store's IANA timezone, so merchant-facing timestamps render in the shop's
// zone. Returns undefined rather than throwing: it is a display nicety and must
// never fail reconciliation.
export async function fetchShopTimezone(shop: string, token: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
	const data = await adminGraphql<{ shop: { ianaTimezone?: unknown } }>(shop, token, `{shop{ianaTimezone}}`, {}, fetchImpl);
	const tz = data.shop?.ianaTimezone;
	return typeof tz === 'string' && tz.length > 0 ? tz : undefined;
}

const INVENTORY_ITEMS_QUERY = `query($ids:[ID!]!){nodes(ids:$ids){... on InventoryItem{id sku variant{title product{title}}}}}`;

// Ids arrive as numeric strings (matching the webhook) and are widened to gids;
// deleted nodes come back null and are skipped.
export async function fetchInventoryItems(
	shop: string,
	token: string,
	ids: string[],
	fetchImpl: typeof fetch = fetch,
): Promise<Array<{ inventoryItemId: string; sku?: string; productTitle?: string; variantTitle?: string }>> {
	if (ids.length === 0) return [];
	const data = await adminGraphql<{
		nodes: Array<{ id?: unknown; sku?: unknown; variant?: { title?: unknown; product?: { title?: unknown } } } | null>;
	}>(shop, token, INVENTORY_ITEMS_QUERY, { ids: ids.map((id) => `gid://shopify/InventoryItem/${id}`) }, fetchImpl);
	const out: Array<{ inventoryItemId: string; sku?: string; productTitle?: string; variantTitle?: string }> = [];
	for (const node of data.nodes ?? []) {
		if (!node) continue;
		const inventoryItemId = numericId(node.id);
		if (!inventoryItemId) continue;
		out.push({
			inventoryItemId,
			sku: typeof node.sku === 'string' && node.sku.length > 0 ? node.sku : undefined,
			productTitle: typeof node.variant?.product?.title === 'string' ? node.variant.product.title : undefined,
			variantTitle: typeof node.variant?.title === 'string' ? node.variant.title : undefined,
		});
	}
	return out;
}

const LOCATIONS_QUERY = `{locations(first:100){nodes{id name}}}`;

// Small and slow-changing, so cached as one set rather than resolved per event.
export async function fetchLocations(
	shop: string,
	token: string,
	fetchImpl: typeof fetch = fetch,
): Promise<Array<{ locationId: string; name?: string }>> {
	const data = await adminGraphql<{ locations: { nodes: Array<{ id?: unknown; name?: unknown }> } }>(
		shop,
		token,
		LOCATIONS_QUERY,
		{},
		fetchImpl,
	);
	const out: Array<{ locationId: string; name?: string }> = [];
	for (const node of data.locations?.nodes ?? []) {
		const locationId = numericId(node.id);
		if (!locationId) continue;
		out.push({ locationId, name: typeof node.name === 'string' ? node.name : undefined });
	}
	return out;
}
