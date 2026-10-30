import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTable } from './fakeTable.ts';
import { drainAccepted, pendingKey, type ProcessDeps, type PendingRow } from '../src/ingest/processor.ts';
import { createDeliveryHandler, deliveryMarks, type DeliveryHandlerDeps } from '../src/ingest/deliveryHandler.ts';
import { handleCompliance, type ComplianceDeps } from '../src/privacy/compliance.ts';
import {
	redactShop,
	redactOrders,
	scrubDeliveries,
	SCRUB_SCAN_LIMIT,
	SCRUB_YIELD_EVERY,
	type RedactTarget,
	type ScrubTables,
} from '../src/privacy/redaction.ts';
import { tombstoneOrders, tombstoneShop, tombstoneId, type TombstoneTable } from '../src/privacy/tombstone.ts';
import { purgeExpired, DAY_MS } from '../src/retention/retention.ts';
import { metrics, M } from '../src/observability/observe.ts';
import type { OrderTables } from '../src/ingest/orderRefresh.ts';

// customers/redact and shop/redact racing deliveries the drain has not written yet.
// The drain, handler, compliance dispatcher and redaction are the real modules; only
// the tables are fakes.

const NOW = 1_800_000_000_000;
const A = 'a.myshopify.com';
const B = 'b.myshopify.com';

// Mirrors the computed WebhookDelivery.pendingKey: Harper sets it on every write while
// a row is accepted and clears it otherwise.
class DeliveryTable extends FakeTable {
	private keyed(row: Record<string, unknown>) {
		const key = row.status === 'accepted' ? pendingKey(row as unknown as PendingRow) : undefined;
		return { ...row, pendingKey: key };
	}
	override async put(record: Record<string, unknown>) {
		await super.put(this.keyed(record));
	}
	override async patch(id: string, partial: Record<string, unknown>) {
		this.rows.set(id, this.keyed({ ...this.rows.get(id), ...partial }));
	}
}

function world({ scrubLimit = SCRUB_SCAN_LIMIT } = {}) {
	const deliveries = new DeliveryTable('id');
	const events = new FakeTable('eventId');
	// Every event write, so a test can tell a dropped delivery from one written and then erased.
	const written: string[] = [];
	const putEvent = events.put.bind(events);
	events.put = async (row) => {
		written.push(`${row.shopId}:${row.resourceId}`);
		await putEvent(row);
	};
	const eventSkus = new FakeTable('id');
	const inventoryItems = new FakeTable('id');
	const projections = new FakeTable('id');
	const expectations = new FakeTable('id');
	const findings = new FakeTable('id');
	const tombstones = new FakeTable('id');
	const tombstoneTable = tombstones as unknown as TombstoneTable;
	const orders = { events, projections, expectations, findings } as unknown as OrderTables;
	const targets: RedactTarget[] = [
		{ name: 'WebhookDelivery', keyField: 'id', shopField: 'shopId', table: deliveries },
		{ name: 'OperationalEvent', keyField: 'eventId', shopField: 'shopId', orderField: 'resourceId', table: events },
		{ name: 'EventSku', keyField: 'id', shopField: 'shopId', orderField: 'resourceId', table: eventSkus },
		{ name: 'OrderProjection', keyField: 'id', shopField: 'shopId', orderField: 'orderId', table: projections },
		{ name: 'Expectation', keyField: 'id', shopField: 'shopId', orderField: 'orderId', table: expectations },
		{ name: 'GapFinding', keyField: 'id', shopField: 'shopId', orderField: 'orderId', table: findings },
		{ name: 'RedactionTombstone', keyField: 'id', shopField: 'shopId', table: tombstones },
	];
	let clock = NOW;
	const handle = createDeliveryHandler({
		events: events as unknown as DeliveryHandlerDeps['events'],
		eventSkus: eventSkus as unknown as DeliveryHandlerDeps['eventSkus'],
		inventoryItems,
		orders,
		tombstones,
		uninstall: async () => {},
		eraseResource: (shopId, resourceId) => redactOrders(targets, shopId, [resourceId]),
		now: () => clock,
	});
	// The jobs.ts read: a range of the pendingKey index.
	const processDeps: ProcessDeps = {
		async listPending(after, limit) {
			const rows: PendingRow[] = [];
			for await (const r of deliveries.search({
				conditions: [{ attribute: 'pendingKey', comparator: 'greater_than', value: after }],
				sort: { attribute: 'pendingKey' },
				limit,
			}))
				rows.push(r as unknown as PendingRow);
			return rows;
		},
		...deliveryMarks(deliveries, tombstones),
		handle,
	};
	const scrubTables = { deliveries, events } as unknown as ScrubTables;
	const compliance: ComplianceDeps = {
		redactShop: (sid) => redactShop(targets, sid),
		redactOrders: (sid, ids) => redactOrders(targets, sid, ids),
		tombstoneOrders: (sid, ids) => tombstoneOrders(tombstoneTable, sid, ids, clock),
		tombstoneShop: (sid) => tombstoneShop(tombstoneTable, sid, clock),
		scrubDeliveries: (sid, ids) => scrubDeliveries(scrubTables, sid, ids, scrubLimit),
		audit: async () => {},
	};
	const accept = (shopId: string, webhookId: string, topic: string, body: unknown) =>
		deliveries.put({
			id: `${shopId}:${webhookId}`,
			shopId,
			webhookId,
			topic,
			receivedAt: clock,
			status: 'accepted',
			attempts: 0,
			payload: JSON.stringify(body),
		});
	const drain = () => drainAccepted(processDeps, { budgetMs: 60_000 });
	const forOrder = (table: FakeTable, field: string, shopId: string, orderId: string) =>
		[...table.rows.values()].filter((r) => r.shopId === shopId && r[field] === orderId).length;
	const ledger = (shopId: string, orderId: string) => ({
		events: forOrder(events, 'resourceId', shopId, orderId),
		eventSkus: forOrder(eventSkus, 'resourceId', shopId, orderId),
		projections: forOrder(projections, 'orderId', shopId, orderId),
		expectations: forOrder(expectations, 'orderId', shopId, orderId),
	});
	const redactCustomer = (shopId: string, ids: number[]) =>
		handleCompliance('customers/redact', shopId, { orders_to_redact: ids }, compliance);
	return {
		deliveries,
		events,
		shopDeliveries: (shopId: string) => [...deliveries.rows.keys()].filter((id) => id.startsWith(`${shopId}:`)),
		eventSkus,
		inventoryItems,
		written,
		tombstones,
		projections,
		processDeps,
		accept,
		drain,
		ledger,
		redactCustomer,
		redactShop: (shopId: string) => handleCompliance('shop/redact', shopId, { shop_domain: shopId }, compliance),
		purge: () => purgeExpired([{ name: 'RedactionTombstone', keyField: 'id', tsField: 'redactedAt', table: tombstones }], clock),
		advance(ms: number) {
			clock += ms;
		},
	};
}

const paid = (id: number) => ({ id, name: `#${id}`, financial_status: 'paid', line_items: [{ sku: `S${id}`, quantity: 1 }] });
const NONE = { events: 0, eventSkus: 0, projections: 0, expectations: 0 };
const dropped = () => metrics.snapshot().counters[M.processRedactedDropped] ?? 0;

test('a customers/redact that lands before the drain leaves nothing for the redacted order', async () => {
	const w = world();
	await w.accept(A, 'p-703', 'orders/paid', paid(703));
	await w.accept(A, 'p-704', 'orders/paid', paid(704));
	await w.redactCustomer(A, [703]);
	await w.drain();
	assert.deepEqual(w.ledger(A, '703'), NONE);
	assert.equal(w.ledger(A, '704').projections, 1, 'another customer of the shop is processed');
	// Scrubbed at redact time: body cleared and out of the queue, so the drain never read it.
	assert.equal(w.deliveries.rows.get(`${A}:p-703`)?.payload, null);
	assert.equal(w.deliveries.rows.get(`${A}:p-703`)?.status, 'processed');
	assert.equal(w.deliveries.rows.get(`${A}:p-704`)?.status, 'processed');
});

test('a processed delivery keeps no body, and a dead-lettered one keeps it until the purge', async () => {
	const w = world();
	await w.accept(A, 'p-704', 'orders/paid', paid(704));
	await w.deliveries.put({
		id: `${A}:bad`,
		shopId: A,
		webhookId: 'bad',
		topic: 'orders/paid',
		receivedAt: NOW,
		status: 'accepted',
		attempts: 0,
		payload: '{not json',
	});
	await w.drain();
	const processed = w.deliveries.rows.get(`${A}:p-704`);
	assert.equal(processed?.status, 'processed');
	assert.equal(processed?.payload, null);
	const dead = w.deliveries.rows.get(`${A}:bad`);
	assert.equal(dead?.status, 'dead_letter');
	assert.equal(dead?.payload, '{not json');
});

test('a delivery the drain already holds when the redaction lands is dropped, not written', async () => {
	const w = world();
	await w.accept(A, 'p-703', 'orders/paid', paid(703));
	await w.accept(A, 'p-704', 'orders/paid', paid(704));
	// The redaction runs between the drain's read of the queue and its first write.
	const listPending = w.processDeps.listPending;
	w.processDeps.listPending = async (after, limit) => {
		const rows = await listPending(after, limit);
		if (rows.length) await w.redactCustomer(A, [703]);
		return rows;
	};
	const before = dropped();
	const r = await w.drain();
	assert.deepEqual(w.ledger(A, '703'), NONE);
	assert.equal(w.ledger(A, '704').projections, 1);
	assert.equal(dropped() - before, 1, 'counted');
	assert.ok(!w.written.includes(`${A}:703`), 'dropped before any write');
	// Dropped rows are marked processed, so they neither retry nor dead-letter.
	assert.equal(r.failed, 0);
	assert.equal(w.deliveries.rows.get(`${A}:p-703`)?.status, 'processed');
	assert.equal(w.deliveries.rows.get(`${A}:p-703`)?.payload, null);
});

test('a redaction that lands while the handler is writing is erased by the handler', async () => {
	const w = world();
	await w.accept(A, 'p-703', 'orders/paid', paid(703));
	// The redaction runs after the event is written and before the projection is.
	const put = w.projections.put.bind(w.projections);
	let raced = false;
	w.projections.put = async (row) => {
		if (!raced) {
			raced = true;
			await w.redactCustomer(A, [703]);
		}
		await put(row);
	};
	await w.drain();
	assert.ok(raced);
	assert.deepEqual(w.ledger(A, '703'), NONE);
	assert.equal(w.deliveries.rows.get(`${A}:p-703`)?.payload, null);
});

test('a delivery for a redacted order that arrives after the request is dropped', async () => {
	const w = world();
	await w.redactCustomer(A, [703]);
	w.advance(60_000);
	await w.accept(A, 'u-703', 'orders/updated', paid(703));
	await w.accept(A, 'f-703', 'fulfillments/create', { id: 9, order_id: 703, status: 'success' });
	await w.drain();
	assert.deepEqual(w.ledger(A, '703'), NONE);
	assert.equal(w.deliveries.rows.get(`${A}:u-703`)?.status, 'processed');
	assert.equal(w.deliveries.rows.get(`${A}:f-703`)?.payload, null);
	assert.deepEqual(w.written, [], 'dropped before any write');
});

test('redacting twice is idempotent: one tombstone, nothing left to delete', async () => {
	const w = world();
	await w.accept(A, 'p-703', 'orders/paid', paid(703));
	await w.drain();
	const first = await w.redactCustomer(A, [703]);
	const second = await w.redactCustomer(A, [703, 703]);
	assert.ok(first.deleted! > 0);
	assert.equal(second.deleted, 0);
	assert.equal(second.scrubbed, 0);
	assert.deepEqual(second.failures, []);
	assert.deepEqual([...w.tombstones.rows.keys()], [tombstoneId(A, '703')]);
	assert.deepEqual(w.ledger(A, '703'), NONE);
});

test('a tombstone stores only the shop and the order id', async () => {
	const w = world();
	await w.redactCustomer(A, [703]);
	assert.deepEqual(w.tombstones.rows.get(tombstoneId(A, '703')), { id: `${A}:703`, shopId: A, orderId: '703', redactedAt: NOW });
});

test('the purge removes a tombstone after seven days, and the order records again', async () => {
	const w = world();
	await w.redactCustomer(A, [703]);
	w.advance(7 * DAY_MS - 1);
	await w.purge();
	assert.equal(w.tombstones.rows.size, 1, 'still inside the seven days');
	w.advance(2);
	const purged = await w.purge();
	assert.equal(purged.byTable.RedactionTombstone.deleted, 1);
	assert.equal(w.tombstones.rows.size, 0);
	await w.accept(A, 'u-703', 'orders/updated', paid(703));
	await w.drain();
	assert.equal(w.ledger(A, '703').projections, 1);
});

test("a tombstone for one shop's order does not touch another shop's order with the same id", async () => {
	const w = world();
	await w.accept(A, 'p-703', 'orders/paid', paid(703));
	await w.accept(B, 'p-703', 'orders/paid', paid(703));
	await w.redactCustomer(A, [703]);
	await w.drain();
	assert.deepEqual(w.ledger(A, '703'), NONE);
	assert.equal(w.ledger(B, '703').projections, 1);
	assert.equal(w.deliveries.rows.get(`${B}:p-703`)?.status, 'processed');
});

test('customers/redact clears the bodies a processed delivery kept from before processing cleared them', async () => {
	const w = world();
	await w.accept(A, 'p-701', 'orders/paid', paid(701));
	await w.accept(A, 'f-701', 'fulfillments/create', { id: 1, order_id: 701, status: 'failure' });
	await w.accept(A, 'p-702', 'orders/paid', paid(702));
	await w.drain();
	await w.deliveries.patch(`${A}:p-701`, { payload: JSON.stringify(paid(701)) });
	await w.deliveries.patch(`${A}:f-701`, { payload: JSON.stringify({ id: 1, order_id: 701, status: 'failure' }) });
	await w.deliveries.patch(`${A}:p-702`, { payload: JSON.stringify(paid(702)) });
	const r = await w.redactCustomer(A, [701]);
	assert.equal(r.scrubbed, 2);
	assert.equal(w.deliveries.rows.get(`${A}:p-701`)?.payload, null);
	assert.equal(w.deliveries.rows.get(`${A}:f-701`)?.payload, null);
	assert.equal(typeof w.deliveries.rows.get(`${A}:p-702`)?.payload, 'string');
});

test('the queue scrub stops at its limit and says so; the tombstone drops the rest', async () => {
	const w = world({ scrubLimit: 3 });
	for (const i of [1, 2, 3]) await w.accept(A, `p-80${i}`, 'orders/paid', paid(800 + i));
	w.advance(1);
	await w.accept(A, 'p-703', 'orders/paid', paid(703));
	const scrubTables = { deliveries: w.deliveries, events: w.events } as unknown as ScrubTables;
	assert.deepEqual(await scrubDeliveries(scrubTables, A, ['703'], 3), { scrubbed: 0, capped: true });
	assert.deepEqual(await scrubDeliveries(scrubTables, A, ['703'], 4), { scrubbed: 1, capped: true });
	await w.accept(A, 'p-704', 'orders/paid', paid(704));
	const r = await w.redactCustomer(A, [704]);
	assert.equal(r.scrubbed, 0, 'the 704 row sorts after the limit');
	assert.equal(w.deliveries.rows.get(`${A}:p-704`)?.status, 'accepted');
	await w.drain();
	assert.deepEqual(w.ledger(A, '704'), NONE);
	assert.equal(w.deliveries.rows.get(`${A}:p-704`)?.payload, null);
	assert.equal(w.ledger(A, '801').projections, 1);
});

test('the queue scrub lets other work on the thread run while it reads a long queue', async () => {
	const w = world();
	for (let i = 0; i < 3 * SCRUB_YIELD_EVERY; i++) await w.accept(A, `p-${i}`, 'orders/paid', paid(10_000 + i));
	const scrubTables = { deliveries: w.deliveries, events: w.events } as unknown as ScrubTables;
	let finished = false;
	let ranDuring = false;
	setImmediate(() => {
		ranDuring = !finished;
	});
	await scrubDeliveries(scrubTables, A, ['703']);
	finished = true;
	assert.ok(ranDuring, 'a macrotask queued before the scrub ran before it finished');
});

test('shop/redact drops what the drain holds, but a reinstalled shop records again', async () => {
	const w = world();
	await w.accept(A, 'p-703', 'orders/paid', paid(703));
	await w.accept(A, 'i-1', 'inventory_levels/update', { inventory_item_id: 5, location_id: 6, available: 1 });
	await w.accept(B, 'p-703', 'orders/paid', paid(703));
	const listPending = w.processDeps.listPending;
	let once = false;
	w.processDeps.listPending = async (after, limit) => {
		const rows = await listPending(after, limit);
		if (rows.length && !once) {
			once = true;
			await w.redactShop(A);
		}
		return rows;
	};
	await w.drain();
	assert.deepEqual(w.ledger(A, '703'), NONE);
	assert.equal(w.ledger(B, '703').projections, 1, 'another shop is untouched');
	assert.equal(w.ledger(A, '5').events, 0, 'the inventory event is dropped too');
	assert.deepEqual([...w.tombstones.rows.keys()], [tombstoneId(A)]);
	assert.deepEqual(w.shopDeliveries(A), [], 'no delivery the redaction deleted is written back');
	w.advance(DAY_MS);
	await w.accept(A, 'p-705', 'orders/paid', paid(705));
	await w.drain();
	assert.equal(w.ledger(A, '705').projections, 1);
});

test('a shop/redact that lands between an inventory event and its SKU index row is erased by the handler', async () => {
	const w = world();
	await w.inventoryItems.put({ id: `${A}:5`, shopId: A, inventoryItemId: '5', sku: 'INV-5' });
	await w.accept(A, 'i-1', 'inventory_levels/update', { inventory_item_id: 5, location_id: 6, available: 1 });
	const put = w.eventSkus.put.bind(w.eventSkus);
	let raced = false;
	w.eventSkus.put = async (row) => {
		if (!raced) {
			raced = true;
			await w.redactShop(A);
		}
		await put(row);
	};
	await w.drain();
	assert.ok(raced, 'the event was indexed from the cached item');
	assert.deepEqual(w.ledger(A, '5'), NONE);
	assert.deepEqual(w.shopDeliveries(A), []);
});

test('a shop/redact during a handler that then fails leaves no delivery row behind', async () => {
	const w = world();
	await w.accept(A, 'p-703', 'orders/paid', paid(703));
	const put = w.events.put.bind(w.events);
	w.events.put = async (row) => {
		await w.redactShop(A);
		await put(row);
		throw new Error('write failed');
	};
	const r = await w.drain();
	assert.equal(r.failed, 1);
	assert.deepEqual(w.shopDeliveries(A), []);
});

test('a shop/redact delete that lands just before the status patch leaves no row of the shop', async () => {
	const w = world();
	await w.accept(A, 'p-703', 'orders/paid', paid(703));
	const patch = w.deliveries.patch.bind(w.deliveries);
	let raced = false;
	w.deliveries.patch = async (id, partial) => {
		if (!raced && partial.status === 'processed') {
			raced = true;
			await w.redactShop(A);
		}
		await patch(id, partial);
	};
	await w.drain();
	assert.ok(raced);
	assert.deepEqual(w.shopDeliveries(A), []);
});

test('a handler that fails after a shop/redact leaves no accepted row to dead-letter later', async () => {
	const w = world();
	await w.accept(A, 'p-703', 'orders/paid', paid(703));
	const put = w.events.put.bind(w.events);
	let raced = false;
	w.events.put = async (row) => {
		await put(row);
		if (!raced) {
			raced = true;
			await w.redactShop(A);
			throw new Error('write failed');
		}
	};
	await w.drain();
	const second = await w.drain();
	assert.equal(second.deadLettered, 0);
	assert.deepEqual(w.shopDeliveries(A), []);
});

test('a metadata-less row of a redacted shop (an older write-back) is removed, not dead-lettered', async () => {
	const w = world();
	await w.redactShop(A);
	await w.deliveries.put({ id: `${A}:old`, shopId: A, receivedAt: NOW, status: 'accepted', attempts: 1 });
	const r = await w.drain();
	assert.equal(r.deadLettered, 0);
	assert.deepEqual(w.shopDeliveries(A), []);
});

test('the queue scrub patches with the row key, shop and receivedAt, so a row deleted under it stays findable', async () => {
	const w = world();
	await w.accept(A, 'p-703', 'orders/paid', paid(703));
	const patch = w.deliveries.patch.bind(w.deliveries);
	w.deliveries.patch = async (id, partial) => {
		await w.deliveries.delete(id);
		await patch(id, partial);
	};
	await w.redactCustomer(A, [703]);
	const row = w.deliveries.rows.get(`${A}:p-703`);
	assert.equal(row?.id, `${A}:p-703`);
	assert.equal(row?.shopId, A);
	assert.equal(row?.receivedAt, NOW);
	assert.equal(row?.status, 'processed');
});

test('a retry after an attempt that wrote rows and then failed erases them, not only drops the delivery', async () => {
	const w = world();
	await w.accept(A, 'p-703', 'orders/paid', paid(703));
	const put = w.projections.put.bind(w.projections);
	let failed = false;
	w.projections.put = async (row) => {
		if (!failed) {
			failed = true;
			// The redaction's search ran before the event committed, so only its tombstone lands.
			await w.tombstones.put({ id: tombstoneId(A, '703'), shopId: A, orderId: '703', redactedAt: NOW });
			throw new Error('projection write failed');
		}
		await put(row);
	};
	await w.drain();
	assert.equal(w.ledger(A, '703').events, 1, 'attempt 1 left its event');
	w.advance(1);
	await w.drain();
	assert.deepEqual(w.ledger(A, '703'), NONE);
	assert.equal(w.deliveries.rows.get(`${A}:p-703`)?.status, 'processed');
});

test('an erase that reports failures leaves the delivery to retry rather than marking it processed', async () => {
	const w = world();
	await w.accept(A, 'p-703', 'orders/paid', paid(703));
	const put = w.projections.put.bind(w.projections);
	let raced = false;
	w.projections.put = async (row) => {
		if (!raced) {
			raced = true;
			await w.redactCustomer(A, [703]);
			w.projections.delete = async () => {
				throw new Error('table unavailable');
			};
		}
		await put(row);
	};
	const r = await w.drain();
	assert.equal(r.failed, 1);
	assert.equal(w.deliveries.rows.get(`${A}:p-703`)?.status, 'accepted');
});
