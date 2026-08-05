import { Deliveries, Events, Projections, Expectations, Findings, Checkpoints, Shops } from './src/db.ts';
import type { Expectation, GapFinding, OperationalEvent } from './src/model.ts';
import { processAcceptedBatch, type ProcessDeps, type DeliveryRow } from './src/processor.ts';
import { normalizeDelivery, isOperationalTopic, PermanentNormalizeError } from './src/normalize.ts';
import { isOrderLinked, rebuildProjection } from './src/projection.ts';
import { uninstallShop } from './src/lifecycle.ts';
import { evaluateOrder, detectorKey } from './src/detector.ts';
import { purgeExpired, type PurgeResult } from './src/retention.ts';
import { RETENTION_TARGETS } from './src/ledgerTargets.ts';
import { loadAccessToken } from './src/credentialStore.ts';
import { fetchOrdersUpdatedSince } from './src/adminApi.ts';
import { synthesizeEvents } from './src/reconcile.ts';

// Rebuild an order's projection from ALL its normalized events (#12). Rebuilding
// from the ledger (rather than an incremental read-modify-write) is order-safe
// and far more robust to concurrent writers: every writer recomputes the full
// state from the persisted events, so a lost write self-heals on the next event.
// The reducer is commutative, so query order is irrelevant.
async function updateOrderProjection(shopId: string, orderId: string): Promise<void> {
	const events: OperationalEvent[] = [];
	for await (const e of Events.search({
		conditions: [
			{ attribute: 'shopId', value: shopId },
			{ attribute: 'resourceId', value: orderId },
		],
		operator: 'and',
	})) {
		events.push(e as unknown as OperationalEvent);
	}
	const projection = rebuildProjection(events);
	if (projection) await Projections.put(projection);
}

// Run the fulfillment-confirmation detector for one order (#14): evaluate its
// projection against the rule and upsert the expectation + finding. Deterministic
// keys make this idempotent; evidence is the order's normalized event ids.
async function runDetectorForOrder(shopId: string, orderId: string, now = Date.now()): Promise<void> {
	const projection = await Projections.get(`${shopId}:${orderId}`);
	if (!projection) return;
	const id = detectorKey(orderId);
	const [expectation, finding] = await Promise.all([Expectations.get(id), Findings.get(id)]);
	const evidenceEventIds: string[] = [];
	for await (const e of Events.search({
		conditions: [
			{ attribute: 'shopId', value: shopId },
			{ attribute: 'resourceId', value: orderId },
		],
		operator: 'and',
		select: ['eventId'],
	})) {
		const eid = (e as { eventId?: unknown }).eventId;
		if (typeof eid === 'string') evidenceEventIds.push(eid);
	}
	evidenceEventIds.sort();
	const result = evaluateOrder({
		projection,
		now,
		evidenceEventIds,
		prior: { expectation: expectation as Expectation | undefined, finding: finding as GapFinding | undefined },
	});
	if (result.expectation) await Expectations.put(result.expectation);
	if (result.finding) await Findings.put(result.finding);
}

// Harper-backed processing deps. `handle` normalizes a delivery's stored payload
// into OperationalEvent rows (#10); the durable pipeline (#9) scans accepted
// deliveries, processes idempotently, and marks processed / dead-letter.
const deps: ProcessDeps = {
	async listAccepted(limit) {
		const rows: DeliveryRow[] = [];
		for await (const r of Deliveries.search({ conditions: [{ attribute: 'status', value: 'accepted' }], limit })) {
			rows.push({
				id: r.id,
				shopId: r.shopId,
				topic: r.topic,
				status: r.status,
				attempts: r.attempts,
				webhookId: r.webhookId,
				receivedAt: r.receivedAt,
				payload: r.payload,
			});
		}
		return rows;
	},
	async markProcessed(id) {
		await Deliveries.patch(id, { status: 'processed' });
	},
	async markFailed(id, attempts, dead) {
		await Deliveries.patch(id, { attempts, status: dead ? 'dead_letter' : 'accepted' });
	},
	async handle(row) {
		if (!row.topic || !row.webhookId || row.receivedAt == null) {
			throw new PermanentNormalizeError(`delivery ${row.id} missing normalization metadata`);
		}
		// Lifecycle topics: app/uninstalled invalidates the shop (idempotent);
		// other non-operational topics (compliance) are handled by their own
		// endpoint and produce no operational event here.
		if (!isOperationalTopic(row.topic)) {
			if (row.topic === 'app/uninstalled') await uninstallShop(row.shopId);
			return;
		}
		// Operational topic with no stored payload: treat as TRANSIENT (retry),
		// not permanent. The realistic cause is an infra glitch — e.g. the payload
		// column momentarily missing after a redeploy — where retrying recovers
		// once the schema heals; a genuinely body-less delivery just retries to the
		// MAX_ATTEMPTS ceiling and then dead-letters. Losing evidence on the first
		// attempt would be worse than a bounded retry.
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
		// Deterministic eventId → idempotent upsert on reprocessing (ADR-002).
		for (const event of normalizeDelivery(meta, payload)) {
			await Events.put(event);
			// Maintain the order projection (#12), then evaluate the detector (#14)
			// so paid/fulfilled/cancelled transitions are reflected immediately.
			if (isOrderLinked(event)) {
				await updateOrderProjection(event.shopId, event.resourceId as string);
				await runDetectorForOrder(event.shopId, event.resourceId as string);
			}
		}
	},
};

export function processDeliveries(): Promise<{ processed: number; failed: number; deadLettered: number }> {
	return processAcceptedBatch(deps);
}

// Background processing loop. This module is imported by resources.ts, so Harper
// loads it on each worker thread. Processing is idempotent (only 'accepted' rows
// are listed; downstream writes are keyed deterministically), so concurrent
// ticks across threads/nodes are safe — that idempotency, not a lease, is the
// correctness guarantee (ADR-002). A single-active lease is a future efficiency
// optimization. The `running` guard prevents overlapping ticks on one thread.
const INTERVAL_MS = 10_000;
let running = false;

export function startProcessingLoop(): void {
	setInterval(() => {
		if (running) return;
		running = true;
		void processDeliveries()
			.then((r) => {
				if (r.processed || r.failed) {
					console.log(`[sightline:process] processed=${r.processed} failed=${r.failed} dead=${r.deadLettered}`);
				}
			})
			.catch((e: unknown) => {
				console.error('[sightline:process] error', (e as Error).message);
			})
			.finally(() => {
				running = false;
			});
	}, INTERVAL_MS);
}

// Seven-day retention purge (ADR-003). Runs shortly after boot (to clear any
// backlog from downtime, and so it is verifiable after a deploy) and then hourly.
// The purge is idempotent, so concurrent runs across threads/nodes are safe — no
// lease needed; the `purging` guard just avoids overlap on one thread.
const PURGE_INTERVAL_MS = 3_600_000; // hourly
const PURGE_INITIAL_DELAY_MS = 30_000;
let purging = false;

export function runPurge(now = Date.now()): Promise<PurgeResult> {
	return purgeExpired(RETENTION_TARGETS, now);
}

function purgeTick(): void {
	if (purging) return;
	purging = true;
	void runPurge()
		.then((r) => {
			if (r.deleted) {
				const per = Object.entries(r.byTable)
					.filter(([, x]) => x.deleted)
					.map(([t, x]) => `${t}=${x.deleted}`)
					.join(' ');
				console.log(`[sightline:purge] deleted ${r.deleted} expired rows (${per})`);
			}
			if (r.residue) console.error(`[sightline:purge] purge-behind: ${r.residue} expired rows still present after run`);
			if (r.failures.length) console.error(`[sightline:purge] failures: ${r.failures.join('; ')}`);
		})
		.catch((e: unknown) => {
			console.error('[sightline:purge] error', (e as Error).message);
		})
		.finally(() => {
			purging = false;
		});
}

export function startPurgeLoop(): void {
	setTimeout(purgeTick, PURGE_INITIAL_DELAY_MS);
	setInterval(purgeTick, PURGE_INTERVAL_MS);
}

// Detector sweep (#14). Event-driven evaluation in handle() catches paid/
// fulfilled/cancelled transitions immediately; this periodic sweep catches
// pending expectations whose deadline passes with NO new event, flipping them to
// expired and creating the unconfirmed finding. Idempotent (deterministic keys).
const DETECTOR_INTERVAL_MS = 300_000; // every 5 minutes
let detecting = false;

export async function runDetectorSweep(now = Date.now()): Promise<number> {
	const pending: Expectation[] = [];
	for await (const exp of Expectations.search({ conditions: [{ attribute: 'state', value: 'pending' }] })) {
		pending.push(exp as unknown as Expectation);
	}
	let due = 0;
	for (const exp of pending) {
		if ((exp.deadline ?? Number.POSITIVE_INFINITY) <= now) {
			await runDetectorForOrder(exp.shopId, exp.orderId, now);
			due += 1;
		}
	}
	return due;
}

function detectorTick(): void {
	if (detecting) return;
	detecting = true;
	void runDetectorSweep()
		.then((due) => {
			if (due) console.log(`[sightline:detect] evaluated ${due} due expectation(s)`);
		})
		.catch((e: unknown) => {
			console.error('[sightline:detect] error', (e as Error).message);
		})
		.finally(() => {
			detecting = false;
		});
}

export function startDetectorLoop(): void {
	setInterval(detectorTick, DETECTOR_INTERVAL_MS);
}

// Reconciliation (#13). Reads authoritative order state from the Admin GraphQL
// API and fills gaps from missed webhooks; the first run per shop backfills the
// retention window (install backfill). Synthesized reconciliation events feed the
// SAME projection reducer + detector, so they merge idempotently with webhook
// state (the reducer is monotonic — reconciliation never regresses a projection).
// Requires the offline token (bootstrapped on app load); shops without one are
// skipped. A durable checkpoint tracks the updated-at cursor per shop.
const RECONCILE_INTERVAL_MS = 600_000; // 10 minutes
const RECONCILE_INITIAL_DELAY_MS = 40_000;
const RECONCILE_BACKFILL_MS = 7 * 24 * 60 * 60 * 1000; // first run: last 7 days
let reconciling = false;

export async function reconcileShop(shopId: string, now = Date.now()): Promise<{ orders: number } | null> {
	const token = await loadAccessToken(shopId);
	if (!token) return null; // no Admin credential yet — capture-only
	const checkpointId = `reconcile:${shopId}`;
	const checkpoint = await Checkpoints.get(checkpointId);
	const sinceMs = checkpoint?.cursor ? Number(checkpoint.cursor) : now - RECONCILE_BACKFILL_MS;
	let cursor: string | undefined;
	let latest = sinceMs;
	let orders = 0;
	do {
		const page = await fetchOrdersUpdatedSince(shopId, token, sinceMs, cursor);
		for (const order of page.orders) {
			for (const event of synthesizeEvents(shopId, order)) await Events.put(event);
			await updateOrderProjection(shopId, order.orderId);
			await runDetectorForOrder(shopId, order.orderId, now);
			if (order.updatedAt && order.updatedAt > latest) latest = order.updatedAt;
			orders += 1;
		}
		cursor = page.nextCursor;
	} while (cursor);
	await Checkpoints.put({ id: checkpointId, cursor: String(latest), updatedAt: now });
	return { orders };
}

export async function runReconcileSweep(now = Date.now()): Promise<{ shops: number; orders: number }> {
	let shops = 0;
	let orders = 0;
	for await (const s of Shops.search({ conditions: [{ attribute: 'status', value: 'active' }] })) {
		const result = await reconcileShop((s as { shopId: string }).shopId, now);
		if (result) {
			shops += 1;
			orders += result.orders;
		}
	}
	return { shops, orders };
}

function reconcileTick(): void {
	if (reconciling) return;
	reconciling = true;
	void runReconcileSweep()
		.then((r) => {
			if (r.orders) console.log(`[sightline:reconcile] ${r.shops} shop(s), ${r.orders} order(s) reconciled`);
		})
		.catch((e: unknown) => {
			console.error('[sightline:reconcile] error', (e as Error).message);
		})
		.finally(() => {
			reconciling = false;
		});
}

export function startReconcileLoop(): void {
	setTimeout(reconcileTick, RECONCILE_INITIAL_DELAY_MS);
	setInterval(reconcileTick, RECONCILE_INTERVAL_MS);
}

startProcessingLoop();
startPurgeLoop();
startDetectorLoop();
startReconcileLoop();
