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
	get(id: string): Promise<unknown>;
	patch(id: string, partial: Record<string, unknown>): Promise<void>;
}

// shop/redact can delete a delivery while the drain holds it, and Harper turns a patch
// on a missing key into a row of just the patched fields: no shopId or receivedAt, so
// neither the purge nor a later redaction finds it. A delete between the get and the
// patch still loses that race; this narrows it to that gap.
async function patchDelivery(table: DeliveryPatchTable, id: string, partial: Record<string, unknown>): Promise<void> {
	if (await table.get(id)) await table.patch(id, partial);
}

export function deliveryMarks(table: DeliveryPatchTable): Pick<ProcessDeps, 'markProcessed' | 'markFailed'> {
	return {
		markProcessed: (id) => patchDelivery(table, id, { status: 'processed' }),
		markFailed: (id, attempts, dead) => patchDelivery(table, id, { attempts, status: dead ? 'dead_letter' : 'accepted' }),
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
	// Erases the shop's ledger rows for one resource (an order, or an inventory item),
	// for a redaction that landed while this handler wrote them.
	eraseResource(shopId: string, resourceId: string): Promise<unknown>;
	now?: () => number;
}

export function createDeliveryHandler(deps: DeliveryHandlerDeps): (row: DeliveryRow) => Promise<void> {
	const { now = Date.now } = deps;
	// A redacted delivery is dropped silently: a counter, no log line (it would name
	// the order), and its stored body cleared. The drain then marks it processed.
	const drop = async (id: string) => {
		metrics.inc(M.processRedactedDropped);
		await patchDelivery(deps.deliveries, id, { payload: null });
	};
	return async (row) => {
		if (!row.topic || !row.webhookId || row.receivedAt == null) {
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
				await drop(row.id);
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
				await drop(row.id);
			}
		}
	};
}
