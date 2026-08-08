// Shopify Admin GraphQL client for reconciliation (#13). Uses the stored offline
// access token to read order state directly — the gap-fill for missed webhooks
// and the install backfill. Read-only; only the fields we already normalize.

const API_VERSION = '2026-07';

// Node's fetch has NO default timeout, so a hung connection leaves the promise
// pending indefinitely. That is what allowed a stuck reconcile sweep to wedge its
// loop permanently (see src/tick.ts). Bounding the call turns an unbounded hang
// into an ordinary error that the next tick retries.
export const ADMIN_TIMEOUT_MS = 30_000;

interface GraphqlBody<T> {
	data?: T;
	errors?: Array<{ message: string }>;
}

// A GraphQL error whose message says the token's scopes don't cover the field
// requested (Shopify's Admin GraphQL wording: "Access denied for <field> field.
// Required access: `<scope>` access scope or higher.") means no retry can ever
// succeed until the app requests the scope AND the merchant re-authorizes —
// unlike a rate limit or a transient upstream error, which are worth retrying.
// Narrow and comment-only: this is not a general error taxonomy, just the one
// failure mode (missing scope) that must be distinguishable from a blip.
const ACCESS_DENIED_RE = /access denied/i;

// Mirrors PermanentNormalizeError's duck-typed `permanent` flag (src/normalize.ts)
// so a scope failure is visible to a caller without adminApi.ts and normalize.ts
// needing to share a class hierarchy.
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

// Low-level transport. Injectable `fetchImpl` for tests.
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
		// A timeout aborts the request and rejects, so the caller's catch handles it
		// like any other transient failure. No statusCode, so isAuthError correctly
		// declines to burn a token rotation on it.
		signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS),
	});
	if (!res.ok) {
		const e = new Error(`admin graphql ${res.status}`) as Error & { statusCode: number };
		e.statusCode = res.status;
		throw e;
	}
	const body = (await res.json()) as GraphqlBody<T>;
	if (body.errors?.length) {
		const message = body.errors.map((x) => x.message).join('; ');
		if (ACCESS_DENIED_RE.test(message)) throw new PermanentAdminApiError(`admin graphql errors: ${message}`);
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

// gid://shopify/Order/123 → "123" (matches the numeric resourceId from webhooks).
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

// Shape a raw GraphQL order node into the minimal reconcile record (approved
// fields only). Exported for contract-fixture tests.
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

// One page of orders updated at/after `sinceMs`, oldest-updated first.
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

// A trivial authenticated call used to prove the offline token works.
export async function fetchShopName(shop: string, token: string, fetchImpl: typeof fetch = fetch): Promise<string> {
	const data = await adminGraphql<{ shop: { name: string } }>(shop, token, `{shop{name}}`, {}, fetchImpl);
	return data.shop.name;
}

// The store's configured IANA timezone, so merchant-facing timestamps render in
// the shop's zone rather than the viewer's (screen spec: "merchant timezone").
// A shop-level setting, not protected customer data, and readable with the scopes
// we already hold. Returns undefined rather than throwing when the field is
// missing or malformed — a timezone is a display nicety and must never be able to
// fail reconciliation.
export async function fetchShopTimezone(shop: string, token: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
	const data = await adminGraphql<{ shop: { ianaTimezone?: unknown } }>(shop, token, `{shop{ianaTimezone}}`, {}, fetchImpl);
	const tz = data.shop?.ianaTimezone;
	return typeof tz === 'string' && tz.length > 0 ? tz : undefined;
}

const INVENTORY_ITEMS_QUERY = `query($ids:[ID!]!){nodes(ids:$ids){... on InventoryItem{id sku variant{title product{title}}}}}`;

// Resolve inventory item ids to their SKU/product facts. Ids arrive as numeric
// strings (matching the webhook's inventory_item_id) and are widened to gids for
// the API. Nodes that no longer exist come back null and are skipped.
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

// A shop's locations. Small and slow-changing, so the whole set is cached in one
// call rather than resolved per event.
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
