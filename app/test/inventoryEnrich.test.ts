import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	ENRICH_BATCH,
	ENRICH_READ_LIMIT,
	checkpointId,
	indexCachedInventoryEvent,
	inventoryItemRow,
	oldestByReceivedAt,
	locationRow,
	runInventoryEnrichment,
	skuRowsForInventoryEvent,
	unresolvedIds,
	type EnrichDeps,
} from '../src/ingest/inventoryEnrich.ts';
import type { OperationalEvent } from '../src/domain/model.ts';
import { FakeTable } from './fakeTable.ts';
import { setLogSink } from '../src/observability/observe.ts';
import { PermanentAdminApiError } from '../src/shopify/adminApi.ts';

const NOW = 1_775_000_000_000;

test('unresolved ids are distinct, exclude already-resolved items, and are capped', () => {
	const events = [{ resourceId: 'i1' }, { resourceId: 'i2' }, { resourceId: 'i1' }, { resourceId: undefined }];
	assert.deepEqual(unresolvedIds(events, new Set(['i2'])), ['i1']);
	const many = Array.from({ length: ENRICH_BATCH + 10 }, (_u, i) => ({ resourceId: `i${i}` }));
	assert.equal(unresolvedIds(many, new Set()).length, ENRICH_BATCH);
});

test('an inventory item row is keyed by shop and item and carries the product facts', () => {
	const row = inventoryItemRow('s1', { inventoryItemId: 'i1', sku: 'TSHIRT', productTitle: 'T-Shirt', variantTitle: 'M / Black' }, NOW);
	assert.equal(row.id, 's1:i1');
	assert.equal(row.shopId, 's1');
	assert.equal(row.sku, 'TSHIRT');
	assert.equal(row.productTitle, 'T-Shirt');
	assert.equal(row.variantTitle, 'M / Black');
	assert.equal(row.updatedAt, NOW);
});

test('a location row is keyed by shop and location', () => {
	const row = locationRow('s1', { locationId: 'l1', name: 'Brooklyn' }, NOW);
	assert.equal(row.id, 's1:l1');
	assert.equal(row.name, 'Brooklyn');
});

test('an enriched inventory event gets exactly one SKU index row', () => {
	const event: OperationalEvent = {
		eventId: 's1:w9',
		shopId: 's1',
		domain: 'inventory',
		topic: 'inventory_levels/update',
		resourceId: 'i1',
		quantity: 4,
		source: 'webhook',
		occurredAt: NOW,
		receivedAt: NOW,
	};
	const rows = skuRowsForInventoryEvent(event, 'TSHIRT');
	assert.equal(rows.length, 1);
	assert.equal(rows[0].id, 's1:w9:TSHIRT');
	assert.equal(rows[0].sku, 'TSHIRT');
	assert.equal(rows[0].domain, 'inventory');
	assert.equal(rows[0].receivedAt, NOW);
});

// ─── runInventoryEnrichment: convergence behind the durable checkpoint ─────────
// These cover the deps-injected sweep itself (moved here from jobs.ts precisely
// so it can be exercised with FakeTables and fake fetchers, with no Harper
// runtime and no network — see the module comment in src/ingest/inventoryEnrich.ts).

function inventoryEvent(overrides: Partial<OperationalEvent> & { eventId: string; resourceId: string }): Record<string, unknown> {
	return {
		shopId: 's1',
		domain: 'inventory',
		topic: 'inventory_levels/update',
		quantity: 1,
		source: 'webhook',
		occurredAt: NOW,
		receivedAt: NOW,
		...overrides,
	};
}

function harness() {
	const shops = new FakeTable('shopId', [{ shopId: 's1', status: 'active' }]);
	const events = new FakeTable('eventId');
	const inventoryItems = new FakeTable('id');
	const shopLocations = new FakeTable('id');
	const eventSkus = new FakeTable('id');
	const checkpoints = new FakeTable('id');
	const deliveries = new FakeTable('id');
	return { shops, events, inventoryItems, shopLocations, eventSkus, checkpoints, deliveries };
}

// FakeTable's write surface is duck-typed against the model shape (Record vs.
// the concrete row types) — cast the same way the other Fake* usages in this
// suite do (test/eventSkus.test.ts) rather than widening the production interface
// for a test fixture.
function buildDeps(raw: ReturnType<typeof harness>, rest: Pick<EnrichDeps, 'getToken' | 'fetchItems' | 'fetchLocations'>): EnrichDeps {
	return {
		shops: raw.shops as unknown as EnrichDeps['shops'],
		events: raw.events as unknown as EnrichDeps['events'],
		inventoryItems: raw.inventoryItems as unknown as EnrichDeps['inventoryItems'],
		shopLocations: raw.shopLocations as unknown as EnrichDeps['shopLocations'],
		eventSkus: raw.eventSkus as unknown as EnrichDeps['eventSkus'],
		checkpoints: raw.checkpoints as unknown as EnrichDeps['checkpoints'],
		deliveries: raw.deliveries as unknown as EnrichDeps['deliveries'],
		...rest,
	};
}

test('a second tick against a converged shop makes no Admin API calls and writes no EventSku rows', async () => {
	const raw = harness();
	await raw.events.put(inventoryEvent({ eventId: 's1:e1', resourceId: 'i1' }));
	let itemCalls = 0;
	let locationCalls = 0;
	const deps = buildDeps(raw, {
		getToken: async () => 'tok',
		fetchItems: (async (_shop: string, _token: string, ids: string[]) => {
			itemCalls++;
			return ids.map((id) => ({ inventoryItemId: id, sku: `SKU-${id}` }));
		}) as EnrichDeps['fetchItems'],
		fetchLocations: (async () => {
			locationCalls++;
			return [{ locationId: 'l1', name: 'Warehouse' }];
		}) as EnrichDeps['fetchLocations'],
	});

	const first = await runInventoryEnrichment(NOW, deps);
	assert.equal(first.items, 1);
	assert.equal(first.locations, 1);
	assert.equal(first.indexed, 1);
	assert.equal(itemCalls, 1);
	assert.equal(locationCalls, 1);

	const second = await runInventoryEnrichment(NOW, deps);
	assert.equal(itemCalls, 1, 'no new Admin API item calls on the second tick');
	assert.equal(locationCalls, 1, 'no new Admin API location calls on the second tick');
	assert.equal(second.items, 0);
	assert.equal(second.indexed, 0, 'a converged shop writes no EventSku rows on the next tick');
});

test('a new event after a converged checkpoint is still indexed', async () => {
	const raw = harness();
	await raw.events.put(inventoryEvent({ eventId: 's1:e1', resourceId: 'i1' }));
	const deps = buildDeps(raw, {
		getToken: async () => 'tok',
		fetchItems: (async (_shop: string, _token: string, ids: string[]) =>
			ids.map((id) => ({ inventoryItemId: id, sku: `SKU-${id}` }))) as EnrichDeps['fetchItems'],
		fetchLocations: (async () => [{ locationId: 'l1', name: 'Warehouse' }]) as EnrichDeps['fetchLocations'],
	});

	const first = await runInventoryEnrichment(NOW, deps);
	assert.equal(first.indexed, 1);

	// A brand-new event for the SAME (already-cached) item arrives after the
	// checkpoint has advanced past the first one.
	await raw.events.put(inventoryEvent({ eventId: 's1:e2', resourceId: 'i1', occurredAt: NOW + 1000, receivedAt: NOW + 1000 }));

	const second = await runInventoryEnrichment(NOW + 1000, deps);
	assert.equal(second.items, 0, 'the item is already cached — no new Admin API call');
	assert.equal(second.indexed, 1, 'exactly the new event is indexed');
});

test('a transient Admin API failure is retried next tick, not skipped', async () => {
	// A THROW is the transient case (rate limit, upstream hiccup): the item's
	// status is genuinely unknown, so it must stay retryable, never tombstoned.
	const raw = harness();
	await raw.events.put(inventoryEvent({ eventId: 's1:e1', resourceId: 'iX' }));
	let shouldThrow = true;
	const deps = buildDeps(raw, {
		getToken: async () => 'tok',
		fetchItems: (async () => {
			if (shouldThrow) throw new Error('admin api throttled');
			return [{ inventoryItemId: 'iX', sku: 'SKU-X' }];
		}) as EnrichDeps['fetchItems'],
		fetchLocations: (async () => []) as EnrichDeps['fetchLocations'],
	});

	setLogSink(() => {}); // this test deliberately triggers the warn path
	try {
		const first = await runInventoryEnrichment(NOW, deps);
		assert.equal(first.items, 0);
		assert.equal(first.indexed, 0);
		assert.equal(
			raw.checkpoints.rows.get(checkpointId('s1'))?.cursor,
			String(NOW),
			'the checkpoint holds at the unresolved event rather than advancing past it',
		);

		shouldThrow = false;
		const second = await runInventoryEnrichment(NOW + 5000, deps);
		assert.equal(second.items, 1, 'retried and resolved on the next tick');
		assert.equal(second.indexed, 1, 'now that it resolved, the event is indexed');
	} finally {
		setLogSink(null);
	}
});

test('an item Shopify no longer has (deleted) is tombstoned so the frontier advances, with no index row', async () => {
	// A SUCCESSFUL call that simply omits the id — exactly what fetchInventoryItems
	// produces for a node Shopify returns null for (adminApi.ts drops the null) —
	// means the item is permanently gone, not "not yet resolved".
	const raw = harness();
	await raw.events.put(inventoryEvent({ eventId: 's1:e1', resourceId: 'iDeleted' }));
	let itemCalls = 0;
	const deps = buildDeps(raw, {
		getToken: async () => 'tok',
		fetchItems: (async () => {
			itemCalls++;
			return [];
		}) as EnrichDeps['fetchItems'],
		fetchLocations: (async () => []) as EnrichDeps['fetchLocations'],
	});

	const first = await runInventoryEnrichment(NOW, deps);
	assert.equal(first.indexed, 0, 'no SKU is known, so no EventSku row is written for the tombstoned item');
	assert.equal(raw.inventoryItems.rows.get('s1:iDeleted')?.sku, undefined, 'tombstoned with no sku');
	assert.ok(raw.inventoryItems.rows.has('s1:iDeleted'), 'a tombstone row is written so the id counts as resolved');
	assert.notEqual(
		raw.checkpoints.rows.get(checkpointId('s1'))?.cursor,
		String(NOW),
		'the checkpoint advances past the permanently-missing item instead of pinning on it forever',
	);

	// A later event for the same (now-tombstoned) item must never re-query the
	// Admin API for it.
	await raw.events.put(inventoryEvent({ eventId: 's1:e2', resourceId: 'iDeleted', occurredAt: NOW + 1000, receivedAt: NOW + 1000 }));
	await runInventoryEnrichment(NOW + 1000, deps);
	assert.equal(itemCalls, 1, 'the tombstoned id is already resolved, so it is never requested again');
});

test('a permanent (scope-denied) Admin API failure logs at error, not warn, so it is alertable', async () => {
	const raw = harness();
	await raw.events.put(inventoryEvent({ eventId: 's1:e1', resourceId: 'i1' }));
	const deps = buildDeps(raw, {
		getToken: async () => 'tok',
		fetchItems: (async () => {
			throw new PermanentAdminApiError('admin graphql errors: Access denied for inventoryItems field.');
		}) as EnrichDeps['fetchItems'],
		fetchLocations: (async () => []) as EnrichDeps['fetchLocations'],
	});

	const levels: string[] = [];
	setLogSink((level) => levels.push(level));
	try {
		await runInventoryEnrichment(NOW, deps);
	} finally {
		setLogSink(null);
	}
	assert.ok(levels.includes('error'), 'a permanent scope failure must be visible as error, not warn');
	assert.ok(!levels.includes('warn'), 'it must not read as a routine, self-resolving blip');
});

test('a failing Admin API call for one shop does not abort the sweep for the rest', async () => {
	const raw = harness();
	await raw.shops.put({ shopId: 's2', status: 'active' });
	await raw.events.put(inventoryEvent({ eventId: 's1:e1', shopId: 's1', resourceId: 'i1' }));
	await raw.events.put(inventoryEvent({ eventId: 's2:e1', shopId: 's2', resourceId: 'i2' }));
	const deps = buildDeps(raw, {
		getToken: async () => 'tok',
		fetchItems: (async (shop: string, _token: string, ids: string[]) => {
			if (shop === 's1') throw new Error('admin api throttled');
			return ids.map((id) => ({ inventoryItemId: id, sku: `SKU-${id}` }));
		}) as EnrichDeps['fetchItems'],
		fetchLocations: (async () => []) as EnrichDeps['fetchLocations'],
	});

	setLogSink(() => {}); // this test deliberately triggers the warn path
	try {
		const result = await runInventoryEnrichment(NOW, deps);
		assert.equal(result.items, 1, 's2 still resolves despite s1 throwing');
		assert.equal(result.indexed, 1, 's2 is still indexed');
		assert.equal(raw.inventoryItems.rows.has('s1:i1'), false, 's1 got no cached item after the failed call');
	} finally {
		setLogSink(null);
	}
});

test('a shop whose token fetch throws does not stop later shops from enriching', async () => {
	const raw = harness();
	await raw.shops.put({ shopId: 's2', status: 'active' });
	await raw.shops.put({ shopId: 's3', status: 'active' });
	for (const shopId of ['s1', 's2', 's3']) {
		await raw.events.put(inventoryEvent({ eventId: `${shopId}:e1`, shopId, resourceId: 'i1' }));
	}
	const deps = buildDeps(raw, {
		getToken: async (shopId: string) => {
			if (shopId === 's1') throw new Error('shopify token refresh failed: 502');
			return 'tok';
		},
		fetchItems: (async (_shop: string, _token: string, ids: string[]) =>
			ids.map((id) => ({ inventoryItemId: id, sku: `SKU-${id}` }))) as EnrichDeps['fetchItems'],
		fetchLocations: (async () => []) as EnrichDeps['fetchLocations'],
	});

	const lines: string[] = [];
	setLogSink((_level, line) => lines.push(line));
	let result;
	try {
		result = await runInventoryEnrichment(NOW, deps);
	} finally {
		setLogSink(null);
	}

	assert.equal(result.items, 2, 's2 and s3 were enriched');
	assert.equal(raw.checkpoints.rows.has('enrich:s1'), false, 'the failing shop checkpoint is untouched');
	const errors = lines.map((line) => JSON.parse(line.slice(line.indexOf('{')))).filter((entry) => entry.event === 'enrich.shop.error');
	assert.deepEqual(
		errors.map((entry) => [entry.level, entry.shop]),
		[['error', 's1']],
	);
});

function skuDeps(raw: ReturnType<typeof harness>): EnrichDeps {
	return buildDeps(raw, {
		getToken: async () => 'tok',
		fetchItems: (async (_shop: string, _token: string, ids: string[]) =>
			ids.map((id) => ({ inventoryItemId: id, sku: `SKU-${id}` }))) as EnrichDeps['fetchItems'],
		fetchLocations: (async () => []) as EnrichDeps['fetchLocations'],
	});
}

function assertNothingUnreadBelowCursor(raw: ReturnType<typeof harness>): void {
	const cursor = Number(raw.checkpoints.rows.get(checkpointId('s1'))?.cursor);
	for (const event of raw.events.rows.values()) {
		if ((event.receivedAt as number) >= cursor) continue;
		assert.ok(raw.eventSkus.rows.has(`${event.eventId}:SKU-${event.resourceId}`), `${event.eventId} is below the cursor but not indexed`);
	}
}

test('an event processed after the frontier passed its receivedAt is still indexed', async () => {
	const raw = harness();
	// w1 was received first but is still queued; w2 was received later and processed first.
	await raw.deliveries.put({ id: 's1:w1', shopId: 's1', status: 'accepted', receivedAt: NOW });
	await raw.deliveries.put({ id: 's1:w2', shopId: 's1', status: 'processed', receivedAt: NOW + 1000 });
	await raw.events.put(inventoryEvent({ eventId: 's1:e2', resourceId: 'i2', receivedAt: NOW + 1000 }));
	const deps = skuDeps(raw);

	await runInventoryEnrichment(NOW + 2000, deps);
	assert.ok(raw.eventSkus.rows.has('s1:e2:SKU-i2'));

	await raw.events.put(inventoryEvent({ eventId: 's1:e1', resourceId: 'i1', receivedAt: NOW }));
	await raw.deliveries.patch('s1:w1', { status: 'processed' });

	await runInventoryEnrichment(NOW + 3000, deps);
	assert.ok(raw.eventSkus.rows.has('s1:e1:SKU-i1'), 'the late event is indexed even though a newer one was swept first');
	assert.equal(raw.checkpoints.rows.get(checkpointId('s1'))?.cursor, String(NOW + 1001), 'once w1 is processed the frontier moves past it');
});

test('settled deliveries and other shops do not hold the frontier', async () => {
	const raw = harness();
	await raw.deliveries.put({ id: 's1:dead', shopId: 's1', status: 'dead_letter', receivedAt: NOW - 1000 });
	await raw.deliveries.put({ id: 's1:done', shopId: 's1', status: 'processed', receivedAt: NOW - 1000 });
	await raw.deliveries.put({ id: 's2:queued', shopId: 's2', status: 'accepted', receivedAt: NOW - 1000 });
	const total = ENRICH_READ_LIMIT + 5;
	for (let i = 0; i < total; i++) {
		await raw.events.put(inventoryEvent({ eventId: `s1:e${i}`, resourceId: 'i1', receivedAt: NOW + i }));
	}
	const deps = skuDeps(raw);

	await runInventoryEnrichment(NOW + total, deps);
	assert.equal(
		raw.checkpoints.rows.get(checkpointId('s1'))?.cursor,
		String(NOW + ENRICH_READ_LIMIT),
		'advances to the end of the capped read',
	);

	await runInventoryEnrichment(NOW + total, deps);
	assert.equal(raw.checkpoints.rows.get(checkpointId('s1'))?.cursor, String(NOW + total));
	assert.equal(raw.eventSkus.rows.size, total, 'the events past the read cap are indexed');
});

test('an inventory event whose item is already cached is indexed as it is written', async () => {
	const inventoryItems = new FakeTable('id', [
		{ ...inventoryItemRow('s1', { inventoryItemId: 'i1', sku: 'TSHIRT' }, NOW) },
		{ ...inventoryItemRow('s1', { inventoryItemId: 'iGone' }, NOW) },
	]);
	const eventSkus = new FakeTable('id');
	const deps = { inventoryItems, eventSkus } as unknown as Parameters<typeof indexCachedInventoryEvent>[0];
	const event = (overrides: Partial<OperationalEvent> & { eventId: string; resourceId: string }) =>
		inventoryEvent(overrides) as unknown as OperationalEvent;

	assert.equal(await indexCachedInventoryEvent(deps, event({ eventId: 's1:e1', resourceId: 'i1' })), 1);
	assert.equal(eventSkus.rows.get('s1:e1:TSHIRT')?.domain, 'inventory');
	assert.equal(
		await indexCachedInventoryEvent(deps, event({ eventId: 's1:e2', resourceId: 'iUnknown' })),
		0,
		'unknown items wait for the sweep',
	);
	assert.equal(await indexCachedInventoryEvent(deps, event({ eventId: 's1:e3', resourceId: 'iGone' })), 0, 'a tombstoned item has no SKU');
	assert.equal(
		await indexCachedInventoryEvent(deps, event({ eventId: 's1:o1', resourceId: 'i1', domain: 'order' })),
		0,
		'only inventory events resolve through the item cache',
	);
	assert.equal(eventSkus.rows.size, 1);
});

test('a capped read keeps whole receivedAt groups, so a frontier past its last row skips nothing', async () => {
	async function* rows(ats: number[]) {
		for (const [i, receivedAt] of ats.entries()) yield { eventId: `e${i}`, receivedAt };
	}
	const page = await oldestByReceivedAt(rows([9, 8, 7, 6, 5, 4, 3, 2, 2, 2, 1, 9, 9]), 3);
	assert.deepEqual(
		page.map((e) => e.receivedAt),
		[1, 2, 2, 2],
	);
	assert.deepEqual(
		(await oldestByReceivedAt(rows([3, 1, 2]), 5)).map((e) => e.receivedAt),
		[1, 2, 3],
	);

	let seed = 7;
	const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) % 20;
	for (let round = 0; round < 50; round++) {
		const ats = Array.from({ length: 60 }, random);
		const limit = 1 + (round % 10);
		const boundary = [...ats].sort((a, b) => a - b)[limit - 1];
		const expected = ats.filter((at) => at <= boundary).sort((a, b) => a - b);
		assert.deepEqual(
			(await oldestByReceivedAt(rows(ats), limit)).map((e) => e.receivedAt),
			expected,
		);
	}
});

test('a backlog larger than the read limit converges over several ticks without throwing', async () => {
	const raw = harness();
	const total = 150_000;
	for (let i = 0; i < total; i++) {
		// Three events per millisecond, so read caps fall inside a receivedAt group.
		await raw.events.put(inventoryEvent({ eventId: `s1:e${i}`, resourceId: 'i1', receivedAt: NOW + Math.floor(i / 3) }));
	}
	const deps = skuDeps(raw);
	const maxTicks = Math.ceil(total / ENRICH_READ_LIMIT) + 1;

	let ticks = 0;
	while (raw.eventSkus.rows.size < total) {
		await runInventoryEnrichment(NOW + total, deps);
		ticks++;
		assertNothingUnreadBelowCursor(raw);
		assert.ok(ticks <= maxTicks, `still unconverged after ${ticks} ticks`);
	}
	assert.ok(ticks > 1, 'each tick reads a bounded batch');
	assert.equal((await runInventoryEnrichment(NOW + total, deps)).indexed, 0, 'converged');
});

// Harper expires a read snapshot after maxTransactionOpenTime (30 s). Walking the live shop
// iterator across one slow shop's Admin calls made the next advance throw and skipped every
// shop after it, so the shop ids must be read out before any network work.
test('a slow shop cannot expire the shop read snapshot and starve the shops after it', async () => {
	const raw = harness();
	await raw.shops.put({ shopId: 's2', status: 'active' });
	await raw.shops.put({ shopId: 's3', status: 'active' });
	for (const shopId of ['s1', 's2', 's3']) {
		await raw.events.put(inventoryEvent({ eventId: `${shopId}:e1`, shopId, resourceId: 'i1' }));
	}
	const tokenFor: string[] = [];
	const deps = buildDeps(raw, {
		getToken: async (shopId: string) => {
			tokenFor.push(shopId);
			if (shopId === 's1') raw.shops.expireSnapshots(); // s1 is the slow one
			return 'tok';
		},
		fetchItems: (async (_shop: string, _token: string, ids: string[]) =>
			ids.map((id) => ({ inventoryItemId: id, sku: `SKU-${id}` }))) as EnrichDeps['fetchItems'],
		fetchLocations: (async () => []) as EnrichDeps['fetchLocations'],
	});

	const result = await runInventoryEnrichment(NOW, deps);

	assert.deepEqual(tokenFor, ['s1', 's2', 's3']);
	assert.equal(result.indexed, 3);
});
