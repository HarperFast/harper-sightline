import type { EventSku, OperationalEvent } from '../domain/model.ts';
import { normalizeDelivery, isOperationalTopic, PermanentNormalizeError } from './normalize.ts';
import { writeEventWithSkus, type WritableTable } from './eventSkus.ts';
import { indexCachedInventoryEvent, type EnrichReadTable } from './inventoryEnrich.ts';
import { isOrderLinked } from './projection.ts';
import { refreshOrder, type OrderTables } from './orderRefresh.ts';
import { isRedacted, type TombstoneTable } from '../privacy/tombstone.ts';
import { log, metrics, M } from '../observability/observe.ts';
import type { DeliveryRow } from './processor.ts';

// The drain's unit of work (ProcessDeps.handle): normalize one stored delivery and
// write its event, SKU rows and order projection. Deps-injected and free of `../db.ts`
// so tests can drive it with FakeTables; jobs.ts wires the real tables.
export interface DeliveryHandlerDeps {
	events: WritableTable<OperationalEvent>;
	eventSkus: WritableTable<EventSku>;
	inventoryItems: Pick<EnrichReadTable, 'get'>;
	orders: OrderTables;
	tombstones: Pick<TombstoneTable, 'get'>;
	deliveries: { patch(id: string, partial: { payload: null }): Promise<void> };
	uninstall(shopId: string): Promise<void>;
	// Erases one order's ledger rows, for a redaction that landed while this handler wrote them.
	eraseOrder(shopId: string, orderId: string): Promise<unknown>;
	now?: () => number;
}

export function createDeliveryHandler(deps: DeliveryHandlerDeps): (row: DeliveryRow) => Promise<void> {
	const { now = Date.now } = deps;
	// A redacted delivery is dropped silently: a counter, no log line (it would name
	// the order), and its stored body cleared. The drain then marks it processed.
	const drop = async (id: string) => {
		metrics.inc(M.processRedactedDropped);
		await deps.deliveries.patch(id, { payload: null });
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
			if (orderId === undefined) continue;
			await refreshOrder(deps.orders, event.shopId, orderId, now());
			// A redaction that landed during these writes may have searched before they
			// committed, so look again and erase the order here. Not closed across nodes:
			// the tombstone and the ledger replicate asynchronously.
			if (await isRedacted(deps.tombstones, row.shopId, orderId, meta.receivedAt)) {
				await deps.eraseOrder(row.shopId, orderId);
				await drop(row.id);
			}
		}
	};
}
