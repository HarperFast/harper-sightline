import type { EventSku, OperationalEvent } from '../domain/model.ts';
import { normalizeDelivery, isOperationalTopic, PermanentNormalizeError } from './normalize.ts';
import { writeEventWithSkus, type WritableTable } from './eventSkus.ts';
import { indexCachedInventoryEvent, type EnrichReadTable } from './inventoryEnrich.ts';
import { isOrderLinked } from './projection.ts';
import { refreshOrder, type OrderTables } from './orderRefresh.ts';
import { isRedacted, type TombstoneTable } from '../privacy/tombstone.ts';
import { log, metrics, M } from '../observability/observe.ts';
import type { DeliveryRow, ProcessDeps } from './processor.ts';

export interface DeliveryPatchTable {
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
	return {
		markProcessed: (row) => mark(row, { status: 'processed' }),
		markFailed: (row, attempts, dead) => mark(row, { attempts, status: dead ? 'dead_letter' : 'accepted' }),
	};
}

// The drain's unit of work (ProcessDeps.handle): normalize one stored delivery and
// write its event, SKU rows and order projection. Deps-injected and free of `../db.ts`
// so tests can drive it with FakeTables; jobs.ts wires the real tables.
export interface DeliveryHandlerDeps {
	events: WritableTable<OperationalEvent>;
	eventSkus: WritableTable<EventSku>;
	inventoryItems: Pick<EnrichReadTable, 'get'>;
	orders: OrderTables;
	tombstones: Pick<TombstoneTable, 'get'>;
	deliveries: DeliveryPatchTable;
	uninstall(shopId: string): Promise<void>;
	// Given an order id or an inventory item id.
	eraseResource(shopId: string, resourceId: string): Promise<unknown>;
	now?: () => number;
}

export function createDeliveryHandler(deps: DeliveryHandlerDeps): (row: DeliveryRow) => Promise<void> {
	const { now = Date.now } = deps;
	// A redacted delivery is dropped silently: a counter, no log line (it would name
	// the order), and its stored body cleared. The drain then marks it processed.
	const drop = async (row: DeliveryRow) => {
		metrics.inc(M.processRedactedDropped);
		await patchDelivery(deps.deliveries, row, { payload: null });
	};
	return async (row) => {
		if (!row.topic || !row.webhookId || row.receivedAt == null) {
			// For a redacted shop this is a row a mark wrote back over a deleted one: the mark
			// deletes it, where a dead letter would alert for a normalizer fault for seven days.
			if (await isRedacted(deps.tombstones, row.shopId, undefined, row.receivedAt ?? 0)) return;
			throw new PermanentNormalizeError(`delivery ${row.id} missing normalization metadata`);
		}
		// Non-operational topics are handled elsewhere (compliance) or invalidate the shop.
		if (!isOperationalTopic(row.topic)) {
			if (row.topic === 'app/uninstalled') await deps.uninstall(row.shopId);
			return;
		}
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
				await drop(row);
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
				if (event.resourceId) await deps.eraseResource(row.shopId, event.resourceId);
				await drop(row);
			}
		}
	};
}
