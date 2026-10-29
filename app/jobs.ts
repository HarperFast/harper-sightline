import {
	Deliveries,
	Events,
	Projections,
	Expectations,
	Findings,
	Checkpoints,
	Shops,
	Credentials,
	EventSkus,
	InventoryItems,
	ShopLocations,
	DigestSubscriptions,
	DigestOutboxes,
} from './src/db.ts';
import {
	drainAccepted,
	emptyDrainResult,
	runProcessCycle,
	type DrainResult,
	type ProcessDeps,
	type DeliveryRow,
} from './src/ingest/processor.ts';
import { normalizeDelivery, isOperationalTopic, PermanentNormalizeError } from './src/ingest/normalize.ts';
import { writeEventWithSkus } from './src/ingest/eventSkus.ts';
import { isOrderLinked } from './src/ingest/projection.ts';
import { runDetectorSweep as sweepDueExpectations, type DetectorSweepDeps } from './src/jobs/detectorSweep.ts';
import { refreshOrder, runDetectorForOrder, type OrderTables } from './src/ingest/orderRefresh.ts';
import { uninstallShop } from './src/shopify/lifecycle.ts';
import { purgeExpired, OUTBOX_RETENTION_DAYS, RETENTION_DAYS, type PurgeResult } from './src/retention/retention.ts';
import { RETENTION_TARGETS, OUTBOX_RETENTION_TARGETS } from './src/retention/ledgerTargets.ts';
import { runPurgeCycle } from './src/retention/purgeCycle.ts';
import { getUsableAccessToken, isAuthError } from './src/shopify/accessToken.ts';
import { tokenDeps, rotateShopCredential } from './src/shopify/tokenDeps.ts';
import {
	fetchOrdersUpdatedSince,
	fetchShopTimezone,
	fetchInventoryItems,
	fetchLocations,
	isThrottledAdminError,
} from './src/shopify/adminApi.ts';
import { synthesizeEvents } from './src/shopify/reconcile.ts';
import { sweepOrdersSince, reconcileShops, type ReconcileShopsResult } from './src/shopify/reconcileSweep.ts';
import {
	indexCachedInventoryEvent,
	runInventoryEnrichment as runEnrichmentSweep,
	type EnrichDeps,
	type EnrichReadTable,
} from './src/ingest/inventoryEnrich.ts';
import { runStateBackfill, type BackfillDeps, type BackfillResult } from './src/jobs/stateBackfill.ts';
import {
	runDigestBuild as runDigestBuildSweep,
	scrubEmailShaped,
	type DigestBuildDeps,
	type DigestBuildResult,
} from './src/digest/digestBuild.ts';
import { log, metrics, M } from './src/observability/observe.ts';
import { computeOpsHealth, type OpsHealth, type RetentionCheck } from './src/observability/opsHealth.ts';
import { createTicker, type Ticker } from './src/jobs/tick.ts';
import type { QueryTable } from './src/api/queries.ts';

// Every periodic sweep is a Harper scheduler job declared in config.yaml and
// exported below as a `*Job` handler. The scheduler runs each occurrence once, on
// the elected leader's primary worker; a setInterval here would run on every thread.
//
// The lease has no compare-and-set, so a failover can briefly leave two leaders
// running the same occurrence. Every handler is idempotent (ADR-002) for that
// reason, and delivery processing keeps one partition slot: two leaders cannot
// learn distinct slots, so partitioning would not make them disjoint.
//
// The scheduler has no stall timeout: a handler that never settles stops that job
// cluster-wide until restart, so job() bounds the wait at the ticker's stall budget.
//
// Handlers ignore `context.scheduledAt`: an overdue occurrence carries a past
// timestamp that would age ops.snapshot and stamp `lastReconciledAt` behind real
// time. The wall clock stays the source of truth.

function ticker(name: string, stallMs: number) {
	return createTicker({
		name,
		stallMs,
		onStall: (loop, ageMs) => {
			metrics.inc(M.tickStalled);
			log('error', 'tick.stalled', { loop, ageMs, action: 'starting a new pass anyway' });
		},
	});
}

export interface JobContext {
	jobName?: string;
	scheduledAt?: Date;
	catchUp?: boolean;
}

// Most stall budgets are at least the job's interval, so when runBounded releases
// the scheduler may fire the next occurrence immediately and a slow (not hung)
// pass can overlap a second one; idempotency (ADR-002) covers correctness. A
// skipped tick (`run` returns null) is not an error.
function job(name: string, t: Ticker, work: () => Promise<void>): (context?: JobContext) => Promise<void> {
	return async (context: JobContext = {}) => {
		if (context.catchUp) log('info', 'job.catchup', { job: context.jobName ?? name, scheduledAt: context.scheduledAt?.toISOString() });
		await t.runBounded(work);
	};
}

const orderTables: OrderTables = {
	events: Events as unknown as OrderTables['events'],
	projections: Projections as unknown as OrderTables['projections'],
	expectations: Expectations as unknown as OrderTables['expectations'],
	findings: Findings as unknown as OrderTables['findings'],
};

const inventoryIndexTables = {
	inventoryItems: InventoryItems as unknown as EnrichReadTable,
	eventSkus: EventSkus,
};

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
		// Non-operational topics are handled elsewhere (compliance) or invalidate the shop.
		if (!isOperationalTopic(row.topic)) {
			if (row.topic === 'app/uninstalled') await uninstallShop(row.shopId);
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
			await writeEventWithSkus({ events: Events, eventSkus: EventSkus }, event);
			await indexCachedInventoryEvent(inventoryIndexTables, event);
			if (isOrderLinked(event)) await refreshOrder(orderTables, event.shopId, event.resourceId as string, Date.now());
		}
	},
};

// Leaves headroom under the 10s `sightline-process` interval.
const PROCESS_BUDGET_MS = 8_000;
const processTicker = ticker('process', 5 * 60_000);

export function processDeliveries(into: DrainResult = emptyDrainResult()): Promise<DrainResult> {
	return drainAccepted(deps, { budgetMs: PROCESS_BUDGET_MS }, into);
}

export const processDeliveriesJob = job('process', processTicker, async () => {
	await runProcessCycle({ drain: processDeliveries, log, metrics });
});

const purgeTicker = ticker('purge', 30 * 60_000);

export function runPurge(now = Date.now()): Promise<PurgeResult> {
	return purgeExpired(RETENTION_TARGETS, now);
}

// The outbox keeps 30 days, not the ledger's 7: it records what the merchant was told.
export function runOutboxPurge(now = Date.now()): Promise<PurgeResult> {
	return purgeExpired(OUTBOX_RETENTION_TARGETS, now, OUTBOX_RETENTION_DAYS);
}

// Leader-only, like every job here: there is no boot pass, because one started at
// module load runs on every thread of every node. The 5-minute interval bounds how
// long a deploy waits for the first pass.
export const purgeJob = job('purge', purgeTicker, async () => {
	await runPurgeCycle({ purge: runPurge, outboxPurge: runOutboxPurge, log, metrics }, Date.now());
});

const detectorTicker = ticker('detect', 15 * 60_000);

export function runDetectorSweep(now = Date.now()): Promise<number> {
	return sweepDueExpectations(
		{
			expectations: Expectations as unknown as DetectorSweepDeps['expectations'],
			evaluate: (shopId, orderId) => runDetectorForOrder(orderTables, shopId, orderId, now),
		},
		now,
	);
}

export const detectJob = job('detect', detectorTicker, async () => {
	try {
		const due = await runDetectorSweep();
		metrics.inc(M.detectEvaluated, due);
		if (due) log('trace', 'detect.tick', { evaluated: due });
	} catch (e: unknown) {
		metrics.inc(M.detectError);
		log('error', 'detect.error', { message: (e as Error).message });
	}
});

const RECONCILE_BACKFILL_MS = 7 * 24 * 60 * 60 * 1000;
// Larger than the 10-minute interval: a sweep over many shops can outlast one tick.
const reconcileTicker = ticker('reconcile', 30 * 60_000);

// A 401 mid-sweep means the token stopped being accepted after the pre-flight
// expiry check, so rotate once and retry. Synthesized event ids are deterministic
// and the sweep persists its cursor, so a restarted shop replays cleanly.
export async function reconcileShop(shopId: string, now = Date.now(), deadlineMs?: number): Promise<{ orders: number } | null> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const token = await getUsableAccessToken(tokenDeps, shopId, now);
		if (!token) return null;
		try {
			return await reconcileShopWithToken(shopId, token, now, deadlineMs);
		} catch (err) {
			if (attempt === 0 && isAuthError(err)) {
				metrics.inc(M.reconcileError);
				log('warn', 'reconcile.token.rejected', { shop: shopId });
				if (await rotateShopCredential(shopId)) continue;
			}
			throw err;
		}
	}
	return null;
}

async function reconcileShopWithToken(shopId: string, token: string, now: number, deadlineMs?: number): Promise<{ orders: number } | null> {
	// Display-only: a failure is retried next sweep and must not fail reconciliation.
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
	const sweep = await sweepOrdersSince(
		{
			fetchPage: (since, pageCursor) => fetchOrdersUpdatedSince(shopId, token, since, pageCursor),
			async applyOrder(order) {
				for (const event of synthesizeEvents(shopId, order)) {
					await writeEventWithSkus({ events: Events, eventSkus: EventSkus }, event);
				}
				await refreshOrder(orderTables, shopId, order.orderId, now);
			},
			// A partial pass advances `cursor` but must keep `updatedAt`: it is
			// computeOpsHealth's staleness signal.
			saveCheckpoint: (cursorMs, complete) =>
				Checkpoints.put({
					id: checkpointId,
					cursor: String(cursorMs),
					updatedAt: complete ? now : checkpoint?.updatedAt,
				}),
		},
		sinceMs,
		{ deadlineMs },
	);
	const orders = sweep.orders;
	if (!sweep.complete) {
		// Out of budget with pages left: the checkpoint resumes next sweep, and the shop is not yet reconciled.
		log('info', 'reconcile.shop.budget', { shop: shopId, orders });
		if (ianaTimezone) await Shops.patch(shopId, { ianaTimezone });
		return { orders };
	}
	await Shops.patch(shopId, {
		lastReconciledAt: now,
		reconciliationState: 'ready',
		...(ianaTimezone ? { ianaTimezone } : {}),
	});
	return { orders };
}

// A failing shop is counted and logged, not rethrown; its stale checkpoint shows in ops.snapshot.
function recordShopFailure(shopId: string, err: unknown): void {
	if (isThrottledAdminError(err)) {
		metrics.inc(M.reconcileThrottled);
		log('warn', 'reconcile.shop.throttled', { shop: shopId, message: (err as Error).message });
	} else {
		metrics.inc(M.reconcileError);
		log('error', 'reconcile.shop.error', { shop: shopId, message: (err as Error).message });
	}
}

export function runReconcileSweep(now = Date.now()): Promise<ReconcileShopsResult> {
	const active = Shops.search({ conditions: [{ attribute: 'status', value: 'active' }] }) as AsyncIterable<{ shopId: string }>;
	return reconcileShops(active, {
		reconcile: (shopId, deadlineMs) => reconcileShop(shopId, now, deadlineMs),
		onFailure: recordShopFailure,
	});
}

export const reconcileJob = job('reconcile', reconcileTicker, async () => {
	const startedAt = Date.now();
	try {
		const r = await runReconcileSweep();
		metrics.observeMs(M.reconcileMs, Date.now() - startedAt);
		metrics.inc(M.reconcileShops, r.shops);
		metrics.inc(M.reconcileOrders, r.orders);
		if (r.failed) log('warn', 'reconcile.partial', { shops: r.shops, orders: r.orders, failed: r.failed });
		else if (r.orders) log('trace', 'reconcile.tick', { shops: r.shops, orders: r.orders });
	} catch (e: unknown) {
		// A throttle is a capacity signal, not a fault.
		if (isThrottledAdminError(e)) {
			metrics.inc(M.reconcileThrottled);
			log('warn', 'reconcile.throttled', { message: (e as Error).message });
		} else {
			metrics.inc(M.reconcileError);
			log('error', 'reconcile.error', { message: (e as Error).message });
		}
	}
});

const enrichTicker = ticker('inventory.enrich', 30 * 60_000);

const enrichDeps: EnrichDeps = {
	shops: Shops as unknown as EnrichReadTable,
	events: Events as unknown as EnrichReadTable,
	inventoryItems: InventoryItems as unknown as EnrichDeps['inventoryItems'],
	shopLocations: ShopLocations as unknown as EnrichDeps['shopLocations'],
	eventSkus: EventSkus,
	checkpoints: Checkpoints as unknown as EnrichDeps['checkpoints'],
	deliveries: Deliveries as unknown as EnrichReadTable,
	getToken: (shopId, now) => getUsableAccessToken(tokenDeps, shopId, now),
	fetchItems: fetchInventoryItems,
	fetchLocations: fetchLocations,
};

export function runInventoryEnrichment(now = Date.now()): Promise<{ items: number; locations: number; indexed: number }> {
	return runEnrichmentSweep(now, enrichDeps);
}

export const inventoryEnrichJob = job('inventory.enrich', enrichTicker, async () => {
	try {
		const r = await runInventoryEnrichment();
		metrics.inc(M.enrichItems, r.items);
		metrics.inc(M.enrichLocations, r.locations);
		metrics.inc(M.enrichIndexed, r.indexed);
		if (r.items || r.locations || r.indexed) log('trace', 'enrich.tick', r);
	} catch (e: unknown) {
		metrics.inc(M.enrichError);
		log('error', 'enrich.error', { message: (e as Error).message });
	}
});

// Backfills the derived `state` column on projections written before it existed.
// Quiet paid-unfulfilled orders never rebuild and the reconcile cursor never
// revisits them, so without this the Overview lane counts disagree with the list.
const backfillTicker = ticker('state.backfill', 10 * 60_000);

const backfillDeps: BackfillDeps = {
	projections: Projections as unknown as BackfillDeps['projections'],
	checkpoints: Checkpoints as unknown as BackfillDeps['checkpoints'],
};

export function runProjectionStateBackfill(now = Date.now()): Promise<BackfillResult> {
	return runStateBackfill(now, backfillDeps);
}

export const stateBackfillJob = job('state.backfill', backfillTicker, async () => {
	try {
		const r = await runProjectionStateBackfill();
		metrics.inc(M.stateBackfillScanned, r.scanned);
		metrics.inc(M.stateBackfillFixed, r.fixed);
		// Silent once converged.
		if (r.fixed) log('info', 'state.backfill.tick', { scanned: r.scanned, fixed: r.fixed, cursor: r.cursor });
	} catch (e: unknown) {
		metrics.inc(M.stateBackfillError);
		log('error', 'state.backfill.error', { message: (e as Error).message });
	}
});

// Writes each subscriber's digest to the outbox as 'pending'. There is no sender:
// delivery has its own compliance surface. Idempotent: the outbox id is
// `${shopId}:${periodStart}` and the build keys on lastBuiltAt.
// 3x the 15-minute interval, matching reconcile's margin for full-table reads per shop.
const digestTicker = ticker('digest', 45 * 60_000);

const digestBuildDeps: DigestBuildDeps = {
	subscriptions: DigestSubscriptions as unknown as DigestBuildDeps['subscriptions'],
	outboxes: DigestOutboxes,
	projections: Projections as unknown as QueryTable,
	findings: Findings as unknown as QueryTable,
	events: Events as unknown as QueryTable,
	deliveries: Deliveries as unknown as QueryTable,
};

export function runDigestBuild(now = Date.now()): Promise<DigestBuildResult> {
	return runDigestBuildSweep(now, digestBuildDeps);
}

export const digestJob = job('digest', digestTicker, async () => {
	try {
		const r = await runDigestBuild();
		// Never log the address: it is the one merchant-identifying string held.
		if (r.built || r.skippedQuiet || r.failed)
			log('info', 'digest.built', { built: r.built, skippedQuiet: r.skippedQuiet, skippedNotDue: r.skippedNotDue, failed: r.failed });
	} catch (e: unknown) {
		// No specific address in hand here, so scrub anything email-shaped.
		log('error', 'digest.error', { message: scrubEmailShaped((e as Error).message) });
	}
});

// Heartbeat: emits ops health and the metrics tally as one structured line, warn
// when unhealthy. It comes from one node per minute, so its absence means the
// scheduler has no leader.
const snapshotTicker = ticker('ops.snapshot', 5 * 60_000);

const retentionChecks: RetentionCheck[] = [
	...RETENTION_TARGETS.map((t) => ({ ...t, retentionDays: RETENTION_DAYS })),
	...OUTBOX_RETENTION_TARGETS.map((t) => ({ ...t, retentionDays: OUTBOX_RETENTION_DAYS })),
];

// Shared with /api/v1/ops, which answers from replicated tables rather than a log line.
export function getOpsHealth(now = Date.now()): Promise<OpsHealth> {
	return computeOpsHealth(
		{
			deliveries: Deliveries as unknown as QueryTable,
			checkpoints: Checkpoints as unknown as QueryTable,
			credentials: Credentials as unknown as QueryTable,
			retention: retentionChecks,
		},
		now,
	);
}

export async function runOpsSnapshot(now = Date.now()): Promise<void> {
	const health = await getOpsHealth(now);
	log(health.healthy ? 'info' : 'warn', 'ops.snapshot', { health, metrics: metrics.snapshot() });
}

export const opsSnapshotJob = job('ops.snapshot', snapshotTicker, async () => {
	try {
		await runOpsSnapshot();
	} catch (e: unknown) {
		log('error', 'ops.snapshot.error', { message: (e as Error).message });
	}
});
