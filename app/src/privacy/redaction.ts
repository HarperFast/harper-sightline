import { countMatching, deleteMatchingKeys, type PurgeableTable, type SearchQuery } from '../retention/retention.ts';
import { normalizeDelivery } from '../ingest/normalize.ts';
import { isOrderLinked } from '../ingest/projection.ts';

// Compliance deletion (ADR-003 §3): targeted DELETEs that remove data and index
// entries, idempotent (a re-run finds nothing and deletes 0).

export interface RedactTarget {
	name: string;
	keyField: string; // primary-key attribute
	shopField: string; // tenant attribute (always 'shopId' for our tables)
	orderField?: string; // order-linkage attribute for customer redaction (e.g. resourceId | orderId); absent = not order-linked
	table: PurgeableTable;
}

export interface RedactResult {
	deleted: number;
	byTable: Record<string, number>;
	failures: string[];
}

export async function redactShop(targets: RedactTarget[], shopId: string): Promise<RedactResult> {
	const byTable: Record<string, number> = {};
	const failures: string[] = [];
	let deleted = 0;
	for (const target of targets) {
		try {
			const condition = [{ attribute: target.shopField, value: shopId, comparator: 'equals' }];
			const n = await deleteMatchingKeys(target.table, target.keyField, condition);
			byTable[target.name] = n;
			deleted += n;
			// Verifies erasure (ADR-003 §4).
			const residue = await countMatching(target.table, condition, undefined, target.keyField, 1);
			if (residue > 0) failures.push(`${target.name}: shop ${shopId} records remain after redaction`);
		} catch (err) {
			failures.push(`${target.name}: ${(err as Error).message}`);
		}
	}
	return { deleted, byTable, failures };
}

// Removes records linked to the given order ids (the webhook's `orders_to_redact`).
// Order linkage is the only customer-scoped key we hold, so tables without it are skipped.
export async function redactOrders(targets: RedactTarget[], shopId: string, orderIds: string[]): Promise<RedactResult> {
	const byTable: Record<string, number> = {};
	const failures: string[] = [];
	let deleted = 0;
	for (const target of targets) {
		if (!target.orderField) continue;
		try {
			let n = 0;
			for (const orderId of orderIds) {
				const condition = [
					{ attribute: target.shopField, value: shopId, comparator: 'equals' },
					{ attribute: target.orderField, value: orderId, comparator: 'equals' },
				];
				n += await deleteMatchingKeys(target.table, target.keyField, condition, 'and');
				const residue = await countMatching(target.table, condition, 'and', target.keyField, 1);
				if (residue > 0) failures.push(`${target.name}: order ${orderId} records remain after redaction`);
			}
			byTable[target.name] = n;
			deleted += n;
		} catch (err) {
			failures.push(`${target.name}: ${(err as Error).message}`);
		}
	}
	return { deleted, byTable, failures };
}

type Row = Record<string, unknown>;

export interface ScrubTables {
	deliveries: {
		get(id: string): Promise<Row | null>;
		patch(id: string, partial: { payload: null; status?: 'processed' }): Promise<void>;
		search(query: SearchQuery & { sort?: { attribute: string } }): AsyncIterable<Row>;
	};
	events: { search(query: SearchQuery): AsyncIterable<Row> };
}

// Rows read per order's events, and from the shop's queue.
export const SCRUB_SCAN_LIMIT = 10_000;
export const SCRUB_YIELD_EVERY = 500;

export interface ScrubResult {
	scrubbed: number;
	capped: boolean; // the queue read hit SCRUB_SCAN_LIMIT; the tombstone covers the rest
}

// A macrotask boundary: I/O callbacks (incoming requests) run before it resolves.
function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

// The order a stored delivery is about, read as the worker would read it; undefined
// when it is not order-linked or the worker could not normalize it either.
function deliveryOrderId(row: Row): string | undefined {
	if (typeof row.topic !== 'string' || typeof row.payload !== 'string') return undefined;
	try {
		const meta = { shopId: String(row.shopId), topic: row.topic, webhookId: '', receivedAt: 0 };
		for (const event of normalizeDelivery(meta, JSON.parse(row.payload))) if (isOrderLinked(event)) return event.resourceId;
	} catch {
		// the worker dead-letters it, and the purge removes it
	}
	return undefined;
}

// Clears the stored body of the shop's deliveries about the given orders, so they do
// not wait out the seven-day purge. Processed ones are found through the order's
// webhook events (an event's id is its delivery's id), so this must run before the
// events are deleted. Queued ones are read from the shop's span of the pendingKey
// index and marked processed so the drain skips them; past SCRUB_SCAN_LIMIT the
// tombstone drops the rest when the drain reaches them. Dead-lettered deliveries are
// not reached: the purge removes them, and the tombstone drops a replay.
export async function scrubDeliveries(
	tables: ScrubTables,
	shopId: string,
	orderIds: string[],
	limit = SCRUB_SCAN_LIMIT,
): Promise<ScrubResult> {
	const wanted = new Set(orderIds);
	if (wanted.size === 0) return { scrubbed: 0, capped: false };
	const processed: string[] = [];
	for (const orderId of wanted) {
		for await (const event of tables.events.search({
			conditions: [{ attribute: 'resourceId', value: orderId }],
			operator: 'and',
			select: ['eventId', 'shopId', 'source'],
			limit,
		})) {
			if (event.shopId === shopId && event.source === 'webhook') processed.push(event.eventId as string);
		}
	}
	const queued: string[] = [];
	let scanned = 0;
	for await (const row of tables.deliveries.search({
		conditions: [{ attribute: 'pendingKey', comparator: 'greater_than', value: `${shopId} ` }],
		sort: { attribute: 'pendingKey' },
		limit,
	})) {
		if (row.shopId !== shopId) break;
		// The rows arrive as microtasks, so without a break the read and the parse of every
		// body hold the thread, and the webhook acks queued behind this request with it.
		if (++scanned % SCRUB_YIELD_EVERY === 0) await yieldToEventLoop();
		const orderId = deliveryOrderId(row);
		if (orderId !== undefined && wanted.has(orderId)) queued.push(row.id as string);
	}
	let scrubbed = 0;
	for (const id of processed) {
		// Only a row just read: a patch on a missing key would write a partial row.
		const delivery = await tables.deliveries.get(id);
		if (typeof delivery?.payload !== 'string') continue;
		await tables.deliveries.patch(id, { payload: null });
		scrubbed++;
	}
	for (const id of queued) {
		await tables.deliveries.patch(id, { payload: null, status: 'processed' });
		scrubbed++;
	}
	return { scrubbed, capped: scanned === limit };
}
