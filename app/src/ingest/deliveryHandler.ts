import type { EventSku, OperationalEvent } from '../domain/model.ts';
import { normalizeDelivery, isOperationalTopic, PermanentNormalizeError } from './normalize.ts';
import { writeEventWithSkus, type WritableTable } from './eventSkus.ts';
import { indexCachedInventoryEvent, type EnrichReadTable } from './inventoryEnrich.ts';
import { isOrderLinked } from './projection.ts';
import { refreshOrder, type OrderTables } from './orderRefresh.ts';
import { isRedacted, type TombstoneTable } from '../privacy/tombstone.ts';
import { log, metrics, M } from '../observability/observe.ts';
import type { DeliveryRow, ProcessDeps } from './processor.ts';

interface DeliveryPatchTable {
	patch(id: string, partial: Record<string, unknown>): Promise<void>;
}

export interface DeliveryMarkTable extends DeliveryPatchTable {
	delete(id: string): Promise<unknown>;
}

// shop/redact can delete a delivery while the drain holds it, on this node or by
// replication, and Harper turns a patch on a missing key into a row of only the patched
// fields, not even the key attribute unless patched. With id, shopId and receivedAt in
// every patch, the drain, a later redaction and the purge can all still find such a row.
function patchDelivery(table: DeliveryPatchTable, row: DeliveryRow, partial: Record<string, unknown>): Promise<void> {
	return table.patch(row.id, {
		...partial,
		id: row.id,
		...(row.shopId ? { shopId: row.shopId } : {}),
		...(row.receivedAt != null ? { receivedAt: row.receivedAt } : {}),
	});
}

// A mark that lands after shop/redact deleted the row would write it back, so a
// redacted shop's row is deleted once marked. The erase deletes the shop's tombstone
// and rewrites it, so a check between those two writes still misses.
export function deliveryMarks(
	table: DeliveryMarkTable,
	tombstones: Pick<TombstoneTable, 'get'>,
): Pick<ProcessDeps, 'markProcessed' | 'markFailed'> {
	const mark = async (row: DeliveryRow, partial: Record<string, unknown>) => {
		await patchDelivery(table, row, partial);
		if (await isRedacted(tombstones, row.shopId, undefined, row.receivedAt ?? 0)) await table.delete(row.id);
	};
	// A delivery about a redacted order dead-letters when its erase keeps failing, after
	// customers/redact's scrub has run, so nothing else would clear its body.
	const aboutRedactedOrder = async (row: DeliveryRow) => {
		if (typeof row.payload !== 'string' || !row.topic || !row.webhookId || row.receivedAt == null) return false;
		try {
			const meta = { shopId: row.shopId, topic: row.topic, webhookId: row.webhookId, receivedAt: row.receivedAt };
			for (const event of normalizeDelivery(meta, JSON.parse(row.payload))) {
				if (isOrderLinked(event) && (await isRedacted(tombstones, row.shopId, event.resourceId, row.receivedAt))) return true;
			}
		} catch {
			// an unreadable body is what dead-lettered it; the operator needs it
		}
		return false;
	};
	return {
		// A processed body is not needed again; a dead letter keeps its body for the operator until the purge.
		markProcessed: (row) => mark(row, { status: 'processed', payload: null }),
		markFailed: async (row, attempts, dead) =>
			mark(row, {
				attempts,
				status: dead ? 'dead_letter' : 'accepted',
				...(dead && (await aboutRedactedOrder(row)) ? { payload: null } : {}),
			}),
	};
}

// The drain's unit of work (ProcessDeps.handle): normalize one stored delivery and
// write its event, SKU rows and order projection.
export interface DeliveryHandlerDeps {
	events: WritableTable<OperationalEvent>;
	eventSkus: WritableTable<EventSku>;
	inventoryItems: Pick<EnrichReadTable, 'get'>;
	orders: OrderTables;
	tombstones: Pick<TombstoneTable, 'get'>;
	uninstall(shopId: string): Promise<void>;
	// Erases what this handler may have written for a redacted resource: an order or an inventory item.
	eraseResource(shopId: string, resourceId: string): Promise<{ failures: string[] }>;
	now?: () => number;
}

export function createDeliveryHandler(deps: DeliveryHandlerDeps): (row: DeliveryRow) => Promise<void> {
	const { now = Date.now } = deps;
	// A redacted delivery is dropped silently: a counter and no log line (it would name
	// the order). Whatever an earlier attempt wrote for it is erased first, and an erase
	// that leaves rows throws so the delivery is retried rather than marked processed,
	// which also clears its body.
	const drop = async (shopId: string, resourceId: string | undefined) => {
		if (resourceId) {
			const { failures } = await deps.eraseResource(shopId, resourceId);
			if (failures.length) throw new Error(`redacted delivery not erased: ${failures.join('; ')}`);
		}
		metrics.inc(M.processRedactedDropped);
	};
	return async (row) => {
		if (!row.topic || !row.webhookId || row.receivedAt == null) {
			// A redacted shop's row: the mark deletes it, where a dead letter would raise a normalizer alert.
			if (await isRedacted(deps.tombstones, row.shopId, undefined, row.receivedAt ?? 0)) return;
			throw new PermanentNormalizeError(`delivery ${row.id} missing normalization metadata`);
		}
		// Non-operational topics are handled elsewhere (compliance) or invalidate the shop.
		if (!isOperationalTopic(row.topic)) {
			if (row.topic === 'app/uninstalled') await deps.uninstall(row.shopId);
			return;
		}
		// Only the processed mark and the redaction scrub write a null body. An accepted row
		// holding one was set back by a mark that failed after its patch, so it is done.
		if (row.payload === null) return;
		// Transient, not permanent: a payload column missing after a redeploy heals,
		// and a truly body-less delivery dead-letters at MAX_ATTEMPTS.
		if (row.payload === undefined) {
			throw new Error(`delivery ${row.id} has no stored payload yet`);
		}
		let payload: unknown;
		try {
			payload = JSON.parse(row.payload);
		} catch {
			throw new PermanentNormalizeError(`delivery ${row.id} payload is not valid JSON`);
		}
		const meta = { shopId: row.shopId, topic: row.topic, webhookId: row.webhookId, receivedAt: row.receivedAt };
		for (const event of normalizeDelivery(meta, payload)) {
			const orderId = isOrderLinked(event) ? event.resourceId : undefined;
			if (await isRedacted(deps.tombstones, row.shopId, orderId, meta.receivedAt)) {
				await drop(row.shopId, event.resourceId);
				continue;
			}
			if (event.skusDropped) {
				metrics.inc(M.processSkusDropped, event.skusDropped);
				log('warn', 'process.skus_dropped', {
					shop: event.shopId,
					eventId: event.eventId,
					kept: event.skus?.length,
					dropped: event.skusDropped,
				});
			}
			await writeEventWithSkus({ events: deps.events, eventSkus: deps.eventSkus }, event);
			await indexCachedInventoryEvent({ inventoryItems: deps.inventoryItems, eventSkus: deps.eventSkus }, event);
			if (orderId !== undefined) await refreshOrder(deps.orders, event.shopId, orderId, now());
			// A redaction that landed during these writes may have searched before they
			// committed, so look again and erase them here. Not closed across nodes:
			// the tombstone and the ledger replicate asynchronously.
			if (await isRedacted(deps.tombstones, row.shopId, orderId, meta.receivedAt)) {
				await drop(row.shopId, event.resourceId);
			}
		}
	};
}
