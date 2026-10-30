// What of a webhook body is stored for the worker to normalize later. An allowlist, so a
// field Shopify adds, or a subscription that drifts from its include_fields, is never
// stored by default (shopify-contract §5, defense in depth).

const ORDER_FIELDS = [
	'id',
	'admin_graphql_api_id',
	'name',
	'order_number',
	'created_at',
	'updated_at',
	'processed_at',
	'cancelled_at',
	'closed_at',
	'confirmed',
	'financial_status',
	'fulfillment_status',
	'currency',
	'total_price',
	'current_total_price',
	'line_items',
];
const FULFILLMENT_FIELDS = [
	'id',
	'admin_graphql_api_id',
	'order_id',
	'status',
	'shipment_status',
	'location_id',
	'created_at',
	'updated_at',
	'tracking_company',
	'tracking_numbers',
	'line_items',
];

// The include_fields each topic is registered with in shopify.app.toml; a test fails if
// the two differ. A topic not listed stores nothing.
export const INCLUDE_FIELDS: Record<string, readonly string[]> = {
	'orders/create': ORDER_FIELDS,
	'orders/paid': ORDER_FIELDS,
	'orders/updated': ORDER_FIELDS,
	'orders/cancelled': ORDER_FIELDS,
	'fulfillments/create': FULFILLMENT_FIELDS,
	'fulfillments/update': FULFILLMENT_FIELDS,
	'refunds/create': ['id', 'admin_graphql_api_id', 'order_id', 'created_at', 'processed_at', 'refund_line_items', 'transactions'],
	'inventory_levels/update': ['inventory_item_id', 'location_id', 'available', 'updated_at'],
	'app/uninstalled': [],
};

// `true` keeps a scalar or a list of scalars; a nested shape keeps an object, or each
// object of a list, filtered by it.
type Shape = { [key: string]: true | Shape };

// Inside the list fields, only what src/ingest/normalize.ts reads: a line item's
// `properties` holds whatever the customer typed, and a transaction nothing we use.
const LINE_ITEM: Shape = { sku: true, quantity: true, fulfillable_quantity: true, requires_shipping: true };
const NESTED: Record<string, Shape> = {
	line_items: LINE_ITEM,
	refund_line_items: { quantity: true, line_item: { sku: true } },
	transactions: {},
};

type Scalar = string | number | boolean | null;
function isScalar(value: unknown): value is Scalar {
	const type = typeof value;
	return value === null || type === 'string' || type === 'number' || type === 'boolean';
}
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function keep(value: unknown, rule: true | Shape): unknown {
	if (rule === true) {
		if (isScalar(value)) return value;
		return Array.isArray(value) && value.every(isScalar) ? [...value] : undefined;
	}
	if (Array.isArray(value)) return value.filter(isObject).map((item) => filter(item, rule));
	return isObject(value) ? filter(value, rule) : undefined;
}

function filter(value: Record<string, unknown>, shape: Shape): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key in shape) {
		if (!Object.hasOwn(value, key)) continue;
		const kept = keep(value[key], shape[key]);
		if (kept !== undefined) out[key] = kept;
	}
	return out;
}

// Built once: ingress runs storedBody on every webhook ack.
const TOPIC_SHAPES = new Map<string, Shape>(
	Object.entries(INCLUDE_FIELDS).map(([topic, fields]) => [
		topic,
		Object.fromEntries(fields.map((field) => [field, NESTED[field] ?? true])),
	]),
);
const NOTHING: Shape = {};

// A new object holding only the allowed fields; null for a body that is not an object.
export function storedBody(topic: string, body: unknown): Record<string, unknown> | null {
	if (!isObject(body)) return null;
	return filter(body, TOPIC_SHAPES.get(topic) ?? NOTHING);
}
