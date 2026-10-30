import type { EventSku, OperationalEvent } from '../domain/model.ts';
import { normalizeDelivery, isOperationalTopic, PermanentNormalizeError } from './normalize.ts';
import { writeEventWithSkus, type WritableTable } from './eventSkus.ts';
import { indexCachedInventoryEvent, type EnrichReadTable } from './inventoryEnrich.ts';
import { isOrderLinked } from './projection.ts';
import { refreshOrder, type OrderTables } from './orderRefresh.ts';
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
	uninstall(shopId: string): Promise<void>;
	now?: () => number;
}

export function createDeliveryHandler(deps: DeliveryHandlerDeps): (row: DeliveryRow) => Promise<void> {
	const { now = Date.now } = deps;
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
			if (isOrderLinked(event)) await refreshOrder(deps.orders, event.shopId, event.resourceId as string, now());
		}
	};
}
