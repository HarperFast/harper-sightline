import type { EventDomain, OperationalEvent } from '../domain/model.ts';

// What the worker knows about a delivery independent of the payload version.
// occurredAt falls back to receivedAt when the payload carries no usable
// source timestamp, so an event always has both a source and a receipt time.
export interface DeliveryMeta {
	shopId: string;
	topic: string;
	webhookId: string;
	receivedAt: number; // epoch ms
}

// A normalization failure the worker must NOT retry: the payload shape is
// unsupported or broken, so re-running can never succeed. The processor
// dead-letters these immediately instead of burning MAX_ATTEMPTS (ADR-002).
// Detected by the duck-typed `permanent` flag, so the processor stays decoupled
// from this class.
export class PermanentNormalizeError extends Error {
	readonly permanent = true;
	constructor(message: string) {
		super(message);
		this.name = 'PermanentNormalizeError';
	}
}

type Payload = Record<string, unknown>;

// ─── defensive field readers (additive-tolerant: unknown fields are ignored) ──

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// Shopify ids arrive as numbers or numeric strings; normalize to string.
function asId(value: unknown): string | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	return asString(value);
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
	return undefined;
}

// Parse an ISO-8601 timestamp (Shopify sends RFC-3339) to epoch ms.
function asEpoch(value: unknown): number | undefined {
	const text = asString(value);
	if (!text) return undefined;
	const ms = Date.parse(text);
	return Number.isNaN(ms) ? undefined : ms;
}

// First defined epoch among the given payload fields, else the receipt time.
function occurredAt(payload: Payload, fields: string[], meta: DeliveryMeta): number {
	for (const field of fields) {
		const ms = asEpoch(payload[field]);
		if (ms !== undefined) return ms;
	}
	return meta.receivedAt;
}

interface EventFields {
	domain: EventDomain;
	resourceId: string;
	occurredAt: number;
	state?: string;
	sku?: string;
	quantity?: number;
	fulfillableItemCount?: number;
	orderName?: string;
	totalPrice?: number;
	currency?: string;
	locationId?: string;
	hasTracking?: boolean;
	trackingCompany?: string;
	shipmentStatus?: string;
	skus?: string[];
}

// Units of an order still requiring physical fulfillment, from line_items.
// `requires_shipping` defaults to true when absent; a line's remaining count is
// `fulfillable_quantity`, falling back to `quantity` on a fresh order. Returns a
// number when line_items is present (0 for a digital order) so the projection can
// distinguish "no fulfillment needed" from "no line-item data" (undefined).
function fulfillableUnits(lineItems: unknown): number | undefined {
	if (!Array.isArray(lineItems)) return undefined;
	let total = 0;
	for (const line of lineItems) {
		if (!line || typeof line !== 'object') continue;
		const item = line as Payload;
		if (item.requires_shipping === false) continue;
		total += asNumber(item.fulfillable_quantity) ?? asNumber(item.quantity) ?? 0;
	}
	return total;
}

// Cap on SKUs carried per event. An order with hundreds of line items would
// otherwise fan out into hundreds of EventSku index rows (Task 5), which is real
// storage against a 7-day window; twenty is enough to identify what is in an
// order without letting one pathological order dominate the ledger.
export const MAX_EVENT_SKUS = 20;

// Distinct SKUs from a line-item array, in first-seen order, capped. `nested`
// handles refund_line_items, where the SKU lives on an inner `line_item` object.
export function skusFromLineItems(lineItems: unknown, skuPath: 'direct' | 'nested' = 'direct'): string[] {
	if (!Array.isArray(lineItems)) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const line of lineItems) {
		if (!line || typeof line !== 'object') continue;
		const holder = skuPath === 'nested' ? (line as Payload).line_item : line;
		if (!holder || typeof holder !== 'object') continue;
		const sku = asString((holder as Payload).sku);
		if (!sku || seen.has(sku)) continue;
		seen.add(sku);
		out.push(sku);
		if (out.length >= MAX_EVENT_SKUS) break;
	}
	return out;
}

// True when the fulfillment carried any tracking number. Deliberately a
// PRESENCE boolean: "fulfilled with no tracking" is the operational signal, and
// storing the numbers themselves would be per-shipment data we have no use for.
function hasAnyTracking(payload: Payload): boolean {
	const numbers = payload.tracking_numbers;
	if (Array.isArray(numbers)) return numbers.some((n) => asString(n) !== undefined);
	return asString(payload.tracking_number) !== undefined;
}

// A normalized event plus its SKU list. `skus` is NOT an OperationalEvent column
// — the events table holds a scalar sku only — so the writer strips it and fans
// it out into EventSku index rows instead (src/ingest/eventSkus.ts).
export type NormalizedEvent = OperationalEvent & { skus?: string[] };

// One event per delivery, keyed deterministically by (shop, webhookId) so a
// reprocessed delivery upserts the same row (idempotent — ADR-002). Only the
// approved, non-PII fields from the contract are carried.
function toEvent(meta: DeliveryMeta, fields: EventFields): NormalizedEvent {
	return {
		eventId: `${meta.shopId}:${meta.webhookId}`,
		shopId: meta.shopId,
		domain: fields.domain,
		topic: meta.topic,
		resourceId: fields.resourceId,
		// The scalar `sku` column stays meaningful only when the event has exactly
		// one SKU (inventory after enrichment, a single-line order); multi-SKU
		// events are searchable through EventSku instead of by a lossy first-SKU.
		sku: fields.skus?.length === 1 ? fields.skus[0] : undefined,
		quantity: fields.quantity,
		fulfillableItemCount: fields.fulfillableItemCount,
		state: fields.state,
		source: 'webhook',
		occurredAt: fields.occurredAt,
		receivedAt: meta.receivedAt,
		orderName: fields.orderName,
		totalPrice: fields.totalPrice,
		currency: fields.currency,
		locationId: fields.locationId,
		hasTracking: fields.hasTracking,
		trackingCompany: fields.trackingCompany,
		shipmentStatus: fields.shipmentStatus,
		skus: fields.skus,
	};
}

// ─── per-domain normalizers ───────────────────────────────────────────────────

// Shopify's merchant-facing order label. `name` is authoritative ("#1001"); when
// a payload carries only the bare number, reconstruct the same shape.
function orderName(payload: Payload): string | undefined {
	const name = asString(payload.name);
	if (name) return name;
	const number = asNumber(payload.order_number);
	return number === undefined ? undefined : `#${number}`;
}

function normalizeOrder(payload: Payload, meta: DeliveryMeta): NormalizedEvent {
	const orderId = asId(payload.id);
	if (!orderId) throw new PermanentNormalizeError(`${meta.topic}: missing order id`);
	return toEvent(meta, {
		domain: 'order',
		resourceId: orderId,
		state: asString(payload.financial_status) ?? asString(payload.fulfillment_status),
		fulfillableItemCount: fulfillableUnits(payload.line_items),
		occurredAt: occurredAt(payload, ['updated_at', 'processed_at', 'cancelled_at', 'created_at'], meta),
		orderName: orderName(payload),
		// current_total_price reflects the order after edits; total_price is the
		// original. Prefer current, fall back to original.
		totalPrice: asNumber(payload.current_total_price) ?? asNumber(payload.total_price),
		currency: asString(payload.currency),
		skus: skusFromLineItems(payload.line_items),
	});
}

function normalizeFulfillment(payload: Payload, meta: DeliveryMeta): NormalizedEvent {
	// resourceId links the fulfillment to its order — the linkage the detector needs.
	const orderId = asId(payload.order_id);
	if (!orderId) throw new PermanentNormalizeError(`${meta.topic}: missing order_id`);
	return toEvent(meta, {
		domain: 'fulfillment',
		resourceId: orderId,
		state: asString(payload.status), // pending | open | success | cancelled | error | failure
		occurredAt: occurredAt(payload, ['updated_at', 'created_at'], meta),
		locationId: asId(payload.location_id),
		hasTracking: hasAnyTracking(payload),
		trackingCompany: asString(payload.tracking_company),
		shipmentStatus: asString(payload.shipment_status),
		skus: skusFromLineItems(payload.line_items),
	});
}

function normalizeInventory(payload: Payload, meta: DeliveryMeta): NormalizedEvent {
	const inventoryItemId = asId(payload.inventory_item_id);
	if (!inventoryItemId) throw new PermanentNormalizeError(`${meta.topic}: missing inventory_item_id`);
	return toEvent(meta, {
		domain: 'inventory',
		resourceId: inventoryItemId,
		quantity: asNumber(payload.available),
		occurredAt: occurredAt(payload, ['updated_at'], meta),
		locationId: asId(payload.location_id),
		// SKU is not in an inventory payload — it is resolved later from the
		// InventoryItem cache (src/ingest/inventoryEnrich.ts).
	});
}

// Sum the refunded quantity across refund_line_items (evidence of how much of an
// order was refunded). Tolerant of missing/oddly-shaped items.
function sumRefundQuantity(value: unknown): number | undefined {
	if (!Array.isArray(value)) return undefined;
	let total = 0;
	let sawAny = false;
	for (const item of value) {
		if (item && typeof item === 'object') {
			const qty = asNumber((item as Payload).quantity);
			if (qty !== undefined) {
				total += qty;
				sawAny = true;
			}
		}
	}
	return sawAny ? total : undefined;
}

function normalizeRefund(payload: Payload, meta: DeliveryMeta): NormalizedEvent {
	const orderId = asId(payload.order_id);
	if (!orderId) throw new PermanentNormalizeError(`${meta.topic}: missing order_id`);
	return toEvent(meta, {
		domain: 'refund',
		resourceId: orderId,
		state: 'refunded',
		quantity: sumRefundQuantity(payload.refund_line_items),
		occurredAt: occurredAt(payload, ['processed_at', 'created_at'], meta),
		skus: skusFromLineItems(payload.refund_line_items, 'nested'),
	});
}

// Topic → normalizer. Only the selected operational topics (shopify-contract §3)
// are here; lifecycle/compliance topics (app/uninstalled, customers/*, shop/*)
// are intentionally absent — they are accepted but produce no operational event.
const NORMALIZERS: Record<string, (payload: Payload, meta: DeliveryMeta) => NormalizedEvent> = {
	'orders/create': normalizeOrder,
	'orders/paid': normalizeOrder,
	'orders/updated': normalizeOrder,
	'orders/cancelled': normalizeOrder,
	'fulfillments/create': normalizeFulfillment,
	'fulfillments/update': normalizeFulfillment,
	'inventory_levels/update': normalizeInventory,
	'refunds/create': normalizeRefund,
};

// True for topics that carry an operational payload we normalize (vs. lifecycle
// topics we accept but don't turn into events).
export function isOperationalTopic(topic: string): boolean {
	return topic in NORMALIZERS;
}

// Normalize one delivery into its operational events. Returns [] for a topic we
// accept but don't record (lifecycle/compliance). Throws PermanentNormalizeError
// for a broken/unsupported operational payload so the worker dead-letters it.
export function normalizeDelivery(meta: DeliveryMeta, payload: unknown): NormalizedEvent[] {
	const normalize = NORMALIZERS[meta.topic];
	if (!normalize) return [];
	if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
		throw new PermanentNormalizeError(`${meta.topic}: payload is not a JSON object`);
	}
	return [normalize(payload as Payload, meta)];
}
