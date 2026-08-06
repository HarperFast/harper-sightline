import { Deliveries, Events, Projections, Expectations, Findings, Checkpoints, Shops, Credentials } from './src/db.ts';
import type { Expectation, GapFinding, OperationalEvent } from './src/model.ts';
import { processAcceptedBatch, type ProcessDeps, type DeliveryRow } from './src/processor.ts';
import { normalizeDelivery, isOperationalTopic, PermanentNormalizeError } from './src/normalize.ts';
import { isOrderLinked, rebuildProjection } from './src/projection.ts';
import { uninstallShop } from './src/lifecycle.ts';
import { evaluateOrder, detectorKey } from './src/detector.ts';
import { purgeExpired, type PurgeResult } from './src/retention.ts';
import { RETENTION_TARGETS } from './src/ledgerTargets.ts';
import { loadAccessToken } from './src/credentialStore.ts';
import { fetchOrdersUpdatedSince, fetchShopTimezone } from './src/adminApi.ts';
import { synthesizeEvents } from './src/reconcile.ts';
import { log, metrics, M } from './src/observe.ts';
import { computeOpsHealth } from './src/opsHealth.ts';
import type { QueryTable } from './src/queries.ts';

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
	const id = detectorKey(shopId, orderId);
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
				metrics.inc(M.processProcessed, r.processed);
				metrics.inc(M.processFailed, r.failed);
				metrics.inc(M.processDeadLettered, r.deadLettered);
				if (r.processed || r.failed)
					log('trace', 'process.tick', { processed: r.processed, failed: r.failed, deadLettered: r.deadLettered });
			})
			.catch((e: unknown) => {
				metrics.inc(M.processError);
				log('error', 'process.error', { message: (e as Error).message });
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
			metrics.inc(M.purgeDeleted, r.deleted);
			if (r.failures.length) metrics.inc(M.purgeFailure, r.failures.length);
			if (r.deleted) {
				const perTable = Object.fromEntries(
					Object.entries(r.byTable)
						.filter(([, x]) => x.deleted)
						.map(([t, x]) => [t, x.deleted]),
				);
				log('trace', 'purge.tick', { deleted: r.deleted, perTable });
			}
			// Residue = expired rows still present after a run (purge lag). Alertable
			// via this warn line; the ops.snapshot also reflects it via backlog/age.
			if (r.residue) log('warn', 'purge.residue', { residue: r.residue });
			if (r.failures.length) log('warn', 'purge.failures', { count: r.failures.length, failures: r.failures });
		})
		.catch((e: unknown) => {
			metrics.inc(M.purgeError);
			log('error', 'purge.error', { message: (e as Error).message });
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
			metrics.inc(M.detectEvaluated, due);
			if (due) log('trace', 'detect.tick', { evaluated: due });
		})
		.catch((e: unknown) => {
			metrics.inc(M.detectError);
			log('error', 'detect.error', { message: (e as Error).message });
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
	// Cache the store's configured timezone once, so merchant-facing timestamps
	// render in the shop's zone rather than the viewer's. Display-only: a failure
	// is swallowed and simply retried on the next sweep — it must never be able to
	// fail reconciliation, and the UI falls back to the viewer's zone meanwhile.
	const shopRow = await Shops.get(shopId);
	let ianaTimezone: string | undefined;
	if (shopRow && !shopRow.ianaTimezone) {
		try {
			ianaTimezone = await fetchShopTimezone(shopId, token);
		} catch {
			// retried next sweep
		}
	}
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
	// Durable per-shop completion marker. This is what the merchant-facing setup
	// stepper and the Overview's "reconciled N ago" / stale banner read (#16
	// follow-ups) — the checkpoint alone is an internal cursor, and a shop is only
	// 'ready' once a full sweep has finished for it.
	await Shops.patch(shopId, {
		lastReconciledAt: now,
		reconciliationState: 'ready',
		...(ianaTimezone ? { ianaTimezone } : {}),
	});
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
	const startedAt = Date.now();
	void runReconcileSweep()
		.then((r) => {
			metrics.observeMs(M.reconcileMs, Date.now() - startedAt);
			metrics.inc(M.reconcileShops, r.shops);
			metrics.inc(M.reconcileOrders, r.orders);
			if (r.orders) log('trace', 'reconcile.tick', { shops: r.shops, orders: r.orders });
		})
		.catch((e: unknown) => {
			metrics.inc(M.reconcileError);
			log('error', 'reconcile.error', { message: (e as Error).message });
		})
		.finally(() => {
			reconciling = false;
		});
}

export function startReconcileLoop(): void {
	setTimeout(reconcileTick, RECONCILE_INITIAL_DELAY_MS);
	setInterval(reconcileTick, RECONCILE_INTERVAL_MS);
}

// Observability heartbeat (#22). Periodically derives the aggregate ops-health
// (backlog age/count, dead letters, reconciliation staleness, reauth) from tables
// and emits it — with the cumulative metrics tally — as a single structured line.
// The staging log pipeline turns these snapshots into dashboards/alerts (#25).
// A warn line when unhealthy so an operator alert can key off it directly.
const OPS_SNAPSHOT_INTERVAL_MS = 60_000; // once a minute
const OPS_SNAPSHOT_INITIAL_DELAY_MS = 20_000;
let snapshotting = false;

export async function runOpsSnapshot(now = Date.now()): Promise<void> {
	const health = await computeOpsHealth(
		{
			deliveries: Deliveries as unknown as QueryTable,
			checkpoints: Checkpoints as unknown as QueryTable,
			credentials: Credentials as unknown as QueryTable,
		},
		now,
	);
	log(health.healthy ? 'info' : 'warn', 'ops.snapshot', { health, metrics: metrics.snapshot() });
}

function opsSnapshotTick(): void {
	if (snapshotting) return;
	snapshotting = true;
	void runOpsSnapshot()
		.catch((e: unknown) => {
			log('error', 'ops.snapshot.error', { message: (e as Error).message });
		})
		.finally(() => {
			snapshotting = false;
		});
}

export function startOpsSnapshotLoop(): void {
	setTimeout(opsSnapshotTick, OPS_SNAPSHOT_INITIAL_DELAY_MS);
	setInterval(opsSnapshotTick, OPS_SNAPSHOT_INTERVAL_MS);
}

startProcessingLoop();
startPurgeLoop();
startDetectorLoop();
startReconcileLoop();
startOpsSnapshotLoop();
