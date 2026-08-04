import type { EventDomain, OperationalEvent } from './model.ts';

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
}

// One event per delivery, keyed deterministically by (shop, webhookId) so a
// reprocessed delivery upserts the same row (idempotent — ADR-002). Only the
// approved, non-PII fields from the contract are carried.
function toEvent(meta: DeliveryMeta, fields: EventFields): OperationalEvent {
	return {
		eventId: `${meta.shopId}:${meta.webhookId}`,
		shopId: meta.shopId,
		domain: fields.domain,
		topic: meta.topic,
		resourceId: fields.resourceId,
		sku: fields.sku,
		quantity: fields.quantity,
		state: fields.state,
		source: 'webhook',
		occurredAt: fields.occurredAt,
		receivedAt: meta.receivedAt,
	};
}

// ─── per-domain normalizers ───────────────────────────────────────────────────

function normalizeOrder(payload: Payload, meta: DeliveryMeta): OperationalEvent {
	const orderId = asId(payload.id);
	if (!orderId) throw new PermanentNormalizeError(`${meta.topic}: missing order id`);
	return toEvent(meta, {
		domain: 'order',
		resourceId: orderId,
		state: asString(payload.financial_status) ?? asString(payload.fulfillment_status),
		occurredAt: occurredAt(payload, ['updated_at', 'processed_at', 'cancelled_at', 'created_at'], meta),
	});
}

function normalizeFulfillment(payload: Payload, meta: DeliveryMeta): OperationalEvent {
	// resourceId links the fulfillment to its order — the linkage the detector needs.
	const orderId = asId(payload.order_id);
	if (!orderId) throw new PermanentNormalizeError(`${meta.topic}: missing order_id`);
	return toEvent(meta, {
		domain: 'fulfillment',
		resourceId: orderId,
		state: asString(payload.status), // pending | open | success | cancelled | error | failure
		occurredAt: occurredAt(payload, ['updated_at', 'created_at'], meta),
	});
}

function normalizeInventory(payload: Payload, meta: DeliveryMeta): OperationalEvent {
	const inventoryItemId = asId(payload.inventory_item_id);
	if (!inventoryItemId) throw new PermanentNormalizeError(`${meta.topic}: missing inventory_item_id`);
	return toEvent(meta, {
		domain: 'inventory',
		resourceId: inventoryItemId,
		quantity: asNumber(payload.available),
		occurredAt: occurredAt(payload, ['updated_at'], meta),
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

function normalizeRefund(payload: Payload, meta: DeliveryMeta): OperationalEvent {
	const orderId = asId(payload.order_id);
	if (!orderId) throw new PermanentNormalizeError(`${meta.topic}: missing order_id`);
	return toEvent(meta, {
		domain: 'refund',
		resourceId: orderId,
		state: 'refunded',
		quantity: sumRefundQuantity(payload.refund_line_items),
		occurredAt: occurredAt(payload, ['processed_at', 'created_at'], meta),
	});
}

// Topic → normalizer. Only the selected operational topics (shopify-contract §3)
// are here; lifecycle/compliance topics (app/uninstalled, customers/*, shop/*)
// are intentionally absent — they are accepted but produce no operational event.
const NORMALIZERS: Record<string, (payload: Payload, meta: DeliveryMeta) => OperationalEvent> = {
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
export function normalizeDelivery(meta: DeliveryMeta, payload: unknown): OperationalEvent[] {
	const normalize = NORMALIZERS[meta.topic];
	if (!normalize) return [];
	if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
		throw new PermanentNormalizeError(`${meta.topic}: payload is not a JSON object`);
	}
	return [normalize(payload as Payload, meta)];
}
