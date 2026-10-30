import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadCache, READ_CACHE_TTL_MS } from '../src/api/readCache.ts';
import { FakeTable } from './fakeTable.ts';
import { computeFlows, getPrivacy, getSummary, type PrivacyCounts } from '../src/api/queries.ts';

const NOW = 1_760_000_000_000;

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

test('the TTL is inside the 15-30 s the read-scaling decision allows', () => {
	assert.ok(READ_CACHE_TTL_MS >= 15_000 && READ_CACHE_TTL_MS <= 30_000);
});

test('concurrent callers for one shop share a single in-flight computation', async () => {
	const cache = createReadCache<number>({ now: () => NOW });
	const gate = deferred<number>();
	let calls = 0;
	const compute = () => {
		calls++;
		return gate.promise;
	};
	const a = cache.get('shop-a', compute);
	const b = cache.get('shop-a', compute);
	const c = cache.get('shop-a', compute);
	gate.resolve(7);
	assert.deepEqual(await Promise.all([a, b, c]), [7, 7, 7]);
	assert.equal(calls, 1, 'one scan served all three requests');
});

test('a completed result is served until the TTL expires, then recomputed', async () => {
	let clock = NOW;
	const cache = createReadCache<number>({ ttlMs: 20_000, now: () => clock });
	let calls = 0;
	const compute = async () => ++calls;
	assert.equal(await cache.get('shop-a', compute), 1);
	clock = NOW + 19_999;
	assert.equal(await cache.get('shop-a', compute), 1, 'still fresh one ms before expiry');
	clock = NOW + 20_000;
	assert.equal(await cache.get('shop-a', compute), 2, 'expired: the next request computes again');
	assert.equal(calls, 2);
});

// The TTL runs from when the result is ready, not from when the scan started: a scan
// slower than the TTL must still be reused, or a big shop would never get a hit.
test('the TTL counts from completion, so a slow scan is still reused', async () => {
	let clock = NOW;
	const cache = createReadCache<number>({ ttlMs: 20_000, now: () => clock });
	const gate = deferred<number>();
	let calls = 0;
	const first = cache.get('shop-a', () => {
		calls++;
		return gate.promise;
	});
	clock = NOW + 25_000;
	gate.resolve(1);
	assert.equal(await first, 1);
	clock = NOW + 30_000;
	assert.equal(await cache.get('shop-a', async () => ++calls), 1);
	assert.equal(calls, 1);
});

test('a failed computation is not cached: every waiter sees the error, the next call retries', async () => {
	const cache = createReadCache<number>({ now: () => NOW });
	const gate = deferred<number>();
	const a = cache.get('shop-a', () => gate.promise);
	const b = cache.get('shop-a', () => Promise.resolve(99));
	gate.reject(new Error('scan failed'));
	await assert.rejects(a, /scan failed/);
	await assert.rejects(b, /scan failed/, 'a caller that joined the failed flight gets its error');
	assert.equal(await cache.get('shop-a', async () => 5), 5, 'the error was not remembered');
});

test('a computation that throws synchronously rejects instead of escaping get()', async () => {
	const cache = createReadCache<number>({ now: () => NOW });
	await assert.rejects(
		cache.get('shop-a', () => {
			throw new Error('sync');
		}),
		/sync/,
	);
	assert.equal(await cache.get('shop-a', async () => 1), 1);
});

test('entries are keyed by shop: one shop never receives another shop’s result', async () => {
	const cache = createReadCache<string>({ now: () => NOW });
	const gate = deferred<string>();
	const a = cache.get('victim.myshopify.com', () => gate.promise);
	const b = cache.get('attacker.myshopify.com', async () => 'attacker data');
	gate.resolve('victim data');
	assert.equal(await a, 'victim data');
	assert.equal(await b, 'attacker data');
	assert.equal(await cache.get('victim.myshopify.com', async () => 'recomputed'), 'victim data');
	assert.equal(await cache.get('attacker.myshopify.com', async () => 'recomputed'), 'attacker data');
});

test('memory is bounded: past maxEntries the oldest shop is evicted', async () => {
	const cache = createReadCache<string>({ maxEntries: 3, now: () => NOW });
	for (const shop of ['s1', 's2', 's3', 's4']) await cache.get(shop, async () => shop);
	assert.equal(cache.size(), 3);
	assert.equal(await cache.get('s1', async () => 'recomputed'), 'recomputed', 'the oldest entry made room');
	assert.equal(await cache.get('s4', async () => 'recomputed'), 's4', 'the newest entry survived');
});

test('expired entries are reclaimed before a live one is evicted', async () => {
	let clock = NOW;
	const cache = createReadCache<string>({ maxEntries: 2, ttlMs: 1000, now: () => clock });
	await cache.get('old', async () => 'old');
	clock = NOW + 500;
	await cache.get('live', async () => 'live');
	clock = NOW + 1200;
	await cache.get('new', async () => 'new');
	assert.equal(await cache.get('live', async () => 'recomputed'), 'live', 'the expired entry went, not the live one');
});

// An evicted flight must not write itself back when it settles: that would let the map
// grow past its bound and resurrect a key that was just made room for.
test('an evicted in-flight computation still answers its callers but is not re-inserted', async () => {
	const cache = createReadCache<string>({ maxEntries: 1, now: () => NOW });
	const gate = deferred<string>();
	const first = cache.get('s1', () => gate.promise);
	await cache.get('s2', async () => 's2');
	gate.resolve('s1');
	assert.equal(await first, 's1');
	assert.equal(cache.size(), 1);
	assert.equal(await cache.get('s1', async () => 'recomputed'), 'recomputed');
});

// ── wired into the query layer ───────────────────────────────────────────────

function world() {
	const events = new FakeTable('eventId', [
		{
			eventId: 'v:e1',
			shopId: 'victim',
			domain: 'order',
			topic: 'orders/paid',
			resourceId: 'o1',
			source: 'webhook',
			occurredAt: NOW - 1000,
		},
		{
			eventId: 'a:e1',
			shopId: 'attacker',
			domain: 'order',
			topic: 'orders/paid',
			resourceId: 'o9',
			source: 'webhook',
			occurredAt: NOW - 1000,
		},
		{
			eventId: 'a:e2',
			shopId: 'attacker',
			domain: 'order',
			topic: 'orders/paid',
			resourceId: 'o8',
			source: 'webhook',
			occurredAt: NOW - 900,
		},
	]);
	const projections = new FakeTable('id', [
		{ id: 'victim:o1', shopId: 'victim', orderId: 'o1', paidAt: NOW - 1000, requiresFulfillment: true, lastEventAt: NOW - 1000 },
		{ id: 'attacker:o9', shopId: 'attacker', orderId: 'o9', paidAt: NOW - 1000, requiresFulfillment: true, lastEventAt: NOW - 1000 },
		{ id: 'attacker:o8', shopId: 'attacker', orderId: 'o8', paidAt: NOW - 900, requiresFulfillment: true, lastEventAt: NOW - 900 },
	]);
	const findings = new FakeTable('id', []);
	const deliveries = new FakeTable('id', [
		{ id: 'victim:w1', shopId: 'victim', status: 'processed', receivedAt: NOW - 1000 },
		{ id: 'attacker:w1', shopId: 'attacker', status: 'processed', receivedAt: NOW - 1000 },
		{ id: 'attacker:w2', shopId: 'attacker', status: 'dead_letter', receivedAt: NOW - 900 },
	]);
	const shops = new FakeTable('shopId', [
		{ shopId: 'victim', scopes: 'read_orders', reconciliationState: 'ready', lastReconciledAt: NOW - 1000 },
		{ shopId: 'attacker', scopes: 'read_orders,read_all', reconciliationState: 'ready', lastReconciledAt: NOW - 1000 },
	]);
	return { events, projections, findings, deliveries, shops };
}

test('getSummary, computeFlows and getPrivacy with a shared cache keep each shop’s counts its own', async () => {
	const w = world();
	const summaries = createReadCache<Record<string, unknown>>({ now: () => NOW });
	const flows = createReadCache<Record<string, unknown>>({ now: () => NOW });
	const privacy = createReadCache<PrivacyCounts>({ now: () => NOW });
	for (let round = 0; round < 2; round++) {
		const [sv, sa] = await Promise.all([getSummary(w, 'victim', NOW, summaries), getSummary(w, 'attacker', NOW, summaries)]);
		assert.equal(sv.shop, 'victim');
		assert.deepEqual(sv.events, { total: 1 }, `round ${round}: victim summary`);
		assert.deepEqual(sa.events, { total: 2 }, `round ${round}: attacker summary`);
		assert.deepEqual(sv.recorder, { healthy: true, deadLetteredDeliveries: 0 });

		const [fv, fa] = await Promise.all([
			computeFlows(w.projections, 'victim', NOW, flows),
			computeFlows(w.projections, 'attacker', NOW, flows),
		]);
		assert.equal((fv.lanes as Record<string, number>).paid, 1, `round ${round}: victim flows`);
		assert.equal((fa.lanes as Record<string, number>).paid, 2, `round ${round}: attacker flows`);

		const [pv, pa] = await Promise.all([getPrivacy(w, 'victim', NOW, privacy), getPrivacy(w, 'attacker', NOW, privacy)]);
		assert.deepEqual(pv.footprint, { events: 1, orders: 1, findings: 0 }, `round ${round}: victim privacy`);
		assert.deepEqual(pa.footprint, { events: 2, orders: 2, findings: 0 }, `round ${round}: attacker privacy`);
		assert.deepEqual(pv.scopes, ['read_orders']);
		assert.equal((pv.webhooks as Record<string, unknown>).deadLettered, 0);
		assert.equal((pa.webhooks as Record<string, unknown>).deadLettered, 1);
	}
});

test('a cached summary is the scan result; a second request in the TTL does not rescan', async () => {
	const w = world();
	const cache = createReadCache<Record<string, unknown>>({ now: () => NOW });
	const first = await getSummary(w, 'victim', NOW, cache);
	await w.events.put({
		eventId: 'v:e2',
		shopId: 'victim',
		domain: 'order',
		topic: 'orders/paid',
		resourceId: 'o2',
		source: 'webhook',
		occurredAt: NOW - 10,
	});
	const second = await getSummary(w, 'victim', NOW + 1000, cache);
	assert.deepEqual(second.events, first.events, 'served from the cache');
	const uncached = await getSummary(w, 'victim', NOW + 1000);
	assert.deepEqual(uncached.events, { total: 2 }, 'without a cache every call scans');
});

// Only the scans are cached. The keyed reads (shop record, digest subscription) are
// cheap and are what a merchant changes and then expects to see: saving digest
// settings and opening Privacy must not show the old status for 20 s.
test('the keyed reads stay per request: notifications and reconciliation are never served stale', async () => {
	const w = world();
	const digestSubscriptions = new FakeTable('shopId', [{ shopId: 'victim', email: 'ops@example.com', cadence: 'daily', status: 'paused' }]);
	const privacyCache = createReadCache<PrivacyCounts>({ now: () => NOW });
	const summaryCache = createReadCache<Record<string, unknown>>({ now: () => NOW });
	const before = await getPrivacy({ ...w, digestSubscriptions }, 'victim', NOW, privacyCache);
	assert.equal((before.notifications as Record<string, unknown>).status, 'paused');
	await getSummary(w, 'victim', NOW, summaryCache);

	await digestSubscriptions.patch('victim', { status: 'active' });
	await w.shops.patch('victim', { lastReconciledAt: NOW + 500 });

	const after = await getPrivacy({ ...w, digestSubscriptions }, 'victim', NOW + 1000, privacyCache);
	assert.equal((after.notifications as Record<string, unknown>).status, 'active');
	assert.equal((after.reconciliation as Record<string, unknown>).lastReconciledAt, NOW + 500);
	const summary = await getSummary(w, 'victim', NOW + 1000, summaryCache);
	assert.equal((summary.reconciliation as Record<string, unknown>).lastReconciledAt, NOW + 500);
	assert.equal((summary.reconciliation as Record<string, unknown>).ageMs, 500, 'age is measured from this request, not the cached scan');
});
