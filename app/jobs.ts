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
import type { Expectation, GapFinding, OperationalEvent } from './src/domain/model.ts';
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
import { isOrderLinked, rebuildProjection } from './src/ingest/projection.ts';
import { uninstallShop } from './src/shopify/lifecycle.ts';
import { evaluateOrder, detectorKey, FAILED_RULE, evaluateFailedFulfillment } from './src/domain/detector.ts';
import { purgeExpired, OUTBOX_RETENTION_DAYS, type PurgeResult } from './src/retention/retention.ts';
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
import { runInventoryEnrichment as runEnrichmentSweep, type EnrichDeps, type EnrichReadTable } from './src/ingest/inventoryEnrich.ts';
import { runStateBackfill, type BackfillDeps, type BackfillResult } from './src/jobs/stateBackfill.ts';
import {
	runDigestBuild as runDigestBuildSweep,
	scrubEmailShaped,
	type DigestBuildDeps,
	type DigestBuildResult,
} from './src/digest/digestBuild.ts';
import { log, metrics, M } from './src/observability/observe.ts';
import { computeOpsHealth, type OpsHealth } from './src/observability/opsHealth.ts';
import { createTicker, type Ticker } from './src/jobs/tick.ts';
import type { QueryTable } from './src/api/queries.ts';

// ── SCHEDULING ────────────────────────────────────────────────────────────────
//
// Every periodic sweep is a Harper scheduler job declared in config.yaml and
// exported below as a `*Job` handler. This module is imported on every worker
// thread, so a setInterval here would run on every thread of every node; the
// scheduler runs each occurrence once, on the elected leader's primary worker.
//
// The lease has no compare-and-set, so a failover can briefly leave two leaders
// running the same occurrence. Every handler is idempotent (ADR-002) for that
// reason, and delivery processing keeps one partition slot: two leaders cannot
// learn distinct slots, so partitioning would not make them disjoint.
//
// The accepted cost is ingest latency across a leader failover (~6.5 minutes),
// which ops.snapshot reports truthfully as a stale backlog.
//
// WHY THE TICKER STAYS. The scheduler serialises occurrences of one job on the
// leader but has no stall timeout: a handler that never settles stops that job
// cluster-wide until restart. job() bounds the wait at the ticker's stall budget.
//
// WHY HANDLERS IGNORE `context.scheduledAt`. An overdue occurrence carries a
// scheduledAt in the past; feeding it in would age ops.snapshot against a stale
// clock and stamp reconcile's `lastReconciledAt` behind real time. The wall clock
// stays the source of truth; `scheduledAt`/`catchUp` are only logged.

// Every background loop runs at most one pass at a time, but must never be able
// to wedge permanently if a pass fails to settle (src/jobs/tick.ts). A detected stall
// is logged at error level — now genuinely visible via read_log — so a stuck loop
// alerts instead of going quiet.
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

// What Harper's scheduler passes a handler. Every field is optional here so the
// same function is directly callable with no argument — which is what the purge's
// post-deploy one-shot and any future manual trigger do.
export interface JobContext {
	jobName?: string;
	scheduledAt?: Date;
	catchUp?: boolean;
}

// Adapt a sweep to a scheduler handler: keep the stall-guarded ticker, and
// return a promise the scheduler can await so a slow pass delays the next
// occurrence rather than stacking on top of it, up to the ticker's stall budget.
//
// A skipped tick (`run` returns null) is not an error and not logged as one: on
// the leader the scheduler already serialises occurrences, so the only way to
// reach a live ticker is a duplicate delivery across a failover — precisely the
// case where doing nothing is correct.
function job(name: string, t: Ticker, work: () => Promise<void>): (context?: JobContext) => Promise<void> {
	return async (context: JobContext = {}) => {
		// A catch-up occurrence means an interval was actually missed (failover,
		// restart, a pass that overran). Worth a line — it is the difference between
		// "the schedule is healthy" and "we are running late".
		if (context.catchUp) log('info', 'job.catchup', { job: context.jobName ?? name, scheduledAt: context.scheduledAt?.toISOString() });
		await t.runBounded(work);
	};
}

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

// Run every detector for one order (#14 + failed-attempt detector): evaluate the
// projection against each rule and upsert its expectation/finding. Deterministic
// keys make this idempotent; evidence is the order's normalized event ids.
//
// The failed-attempt detector writes NO expectation — it has no deadline, so
// there is nothing for the periodic sweep to expire. It is therefore evaluated
// only on order events (which is sufficient: its state changes only when a new
// fulfillment/cancel/refund event arrives).
async function runDetectorForOrder(shopId: string, orderId: string, now = Date.now()): Promise<void> {
	const projection = await Projections.get(`${shopId}:${orderId}`);
	if (!projection) return;
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

	const confirmationId = detectorKey(shopId, orderId);
	const [expectation, finding] = await Promise.all([Expectations.get(confirmationId), Findings.get(confirmationId)]);
	const result = evaluateOrder({
		projection,
		now,
		evidenceEventIds,
		prior: { expectation: expectation as Expectation | undefined, finding: finding as GapFinding | undefined },
	});
	if (result.expectation) await Expectations.put(result.expectation);
	if (result.finding) await Findings.put(result.finding);

	const failedId = detectorKey(shopId, orderId, FAILED_RULE);
	const priorFailed = (await Findings.get(failedId)) as GapFinding | undefined;
	const failed = evaluateFailedFulfillment({
		projection,
		now,
		evidenceEventIds,
		prior: { finding: priorFailed },
	});
	if (failed.finding) await Findings.put(failed.finding);
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
			await writeEventWithSkus({ events: Events, eventSkus: EventSkus }, event);
			// Maintain the order projection (#12), then evaluate the detector (#14)
			// so paid/fulfilled/cancelled transitions are reflected immediately.
			if (isOrderLinked(event)) {
				await updateOrderProjection(event.shopId, event.resourceId as string);
				await runDetectorForOrder(event.shopId, event.resourceId as string);
			}
		}
	},
};

// Sized to the 10s `sightline-process` interval in config.yaml, leaving headroom
// so one occurrence ends before the next is due.
const PROCESS_BUDGET_MS = 8_000;
const processTicker = ticker('process', 5 * 60_000);

export function processDeliveries(into: DrainResult = emptyDrainResult()): Promise<DrainResult> {
	return drainAccepted(deps, { budgetMs: PROCESS_BUDGET_MS }, into);
}

export const processDeliveriesJob = job('process', processTicker, async () => {
	await runProcessCycle({ drain: processDeliveries, log, metrics });
});

// Seven-day retention purge (ADR-003). Hourly, from config.yaml's
// `sightline-purge` job. The purge is idempotent, so a duplicate occurrence
// across a failover is safe — no lease needed.
const PURGE_INITIAL_DELAY_MS = 30_000;
const purgeTicker = ticker('purge', 30 * 60_000);

export function runPurge(now = Date.now()): Promise<PurgeResult> {
	return purgeExpired(RETENTION_TARGETS, now);
}

// The digest outbox keeps 30 days, not the ledger's 7: a digest is a record of
// what the merchant was told, worth keeping after the events it described expire.
export function runOutboxPurge(now = Date.now()): Promise<PurgeResult> {
	return purgeExpired(OUTBOX_RETENTION_TARGETS, now, OUTBOX_RETENTION_DAYS);
}

// The two sweeps' independence (a ledger-purge failure must never stop the
// outbox sweep, and vice versa) lives in src/retention/purgeCycle.ts, deps-injected so it
// is unit-testable without the Harper runtime — jobs.ts just wires the real
// purge functions, log, and metrics, and keeps the ticker.
export const purgeJob = job('purge', purgeTicker, async () => {
	await runPurgeCycle({ purge: runPurge, outboxPurge: runOutboxPurge, log, metrics }, Date.now());
});

// The one property the scheduler cannot provide: a new job does NOT fire on
// deploy, it waits for its first scheduled occurrence — up to an hour for this
// one. The purge running shortly after boot was deliberate (it clears any backlog
// accumulated during downtime, and it makes retention verifiable by the
// post-deploy checks in scripts/smoke.mjs rather than an hour later), so that
// single pass is kept as a local one-shot.
//
// It is NOT a second schedule: one pass, on each thread that boots, then never
// again. The purge is idempotent and capped at MAX_DELETES_PER_RUN per table, and
// the ticker keeps it from overlapping the scheduled occurrence on this thread,
// so the redundancy is one bounded burst per deploy — not the per-thread-forever
// duplication that moving to the scheduler removed.
export function startPurgeBootPass(): void {
	setTimeout(() => void purgeJob(), PURGE_INITIAL_DELAY_MS);
}

// Detector sweep (#14). Event-driven evaluation in handle() catches paid/
// fulfilled/cancelled transitions immediately; this periodic sweep catches
// pending expectations whose deadline passes with NO new event, flipping them to
// expired and creating the unconfirmed finding. Idempotent (deterministic keys).
// Every 5 minutes, from config.yaml's `sightline-detect` job.
const detectorTicker = ticker('detect', 15 * 60_000);

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

// Reconciliation (#13). Reads authoritative order state from the Admin GraphQL
// API and fills gaps from missed webhooks; the first run per shop backfills the
// retention window (install backfill). Synthesized reconciliation events feed the
// SAME projection reducer + detector, so they merge idempotently with webhook
// state (the reducer is monotonic — reconciliation never regresses a projection).
// Requires the offline token (bootstrapped on app load); shops without one are
// skipped. A durable checkpoint tracks the updated-at cursor per shop.
// Every 10 minutes, from config.yaml's `sightline-reconcile` job.
const RECONCILE_BACKFILL_MS = 7 * 24 * 60 * 60 * 1000; // first run: last 7 days
// Stall budget deliberately larger than the 10-minute interval: a legitimate
// sweep over many shops can outlast one tick, and with ADMIN_TIMEOUT_MS bounding
// every Admin API call a genuine hang is already impossible. This is the backstop
// for a non-fetch hang.
const reconcileTicker = ticker('reconcile', 30 * 60_000);

// Reconcile one shop, resolving (and if necessary rotating) its access token
// first. Two attempts: a 401 mid-sweep means the token stopped being accepted
// between the pre-flight expiry check and the call, so rotate once and retry.
// Restarting the shop is safe — synthesized event ids are deterministic and the
// checkpoint only advances after a full pass, so a partial pass replays cleanly.
export async function reconcileShop(shopId: string, now = Date.now()): Promise<{ orders: number } | null> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const token = await getUsableAccessToken(tokenDeps, shopId, now);
		if (!token) return null; // no credential, or parked in reauthorization_required
		try {
			return await reconcileShopWithToken(shopId, token, now);
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

async function reconcileShopWithToken(shopId: string, token: string, now: number): Promise<{ orders: number } | null> {
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
	// Paging lives in src/shopify/reconcileSweep.ts so the convergence guarantee (progress
	// is persisted even when a page fetch throws) is unit-testable without the
	// Harper runtime.
	const sweep = await sweepOrdersSince(
		{
			fetchPage: (since, pageCursor) => fetchOrdersUpdatedSince(shopId, token, since, pageCursor),
			async applyOrder(order) {
				for (const event of synthesizeEvents(shopId, order)) {
					await writeEventWithSkus({ events: Events, eventSkus: EventSkus }, event);
				}
				await updateOrderProjection(shopId, order.orderId);
				await runDetectorForOrder(shopId, order.orderId, now);
			},
			// A partial pass advances `cursor` but must leave `updatedAt` alone —
			// that field is computeOpsHealth's reconcile-staleness signal, so
			// stamping it here would make a shop that never finishes a pass look
			// fresh. Preserving the prior value (undefined when a shop has never
			// completed one) keeps such a shop correctly counted as stale.
			saveCheckpoint: (cursorMs, complete) =>
				Checkpoints.put({
					id: checkpointId,
					cursor: String(cursorMs),
					updatedAt: complete ? now : checkpoint?.updatedAt,
				}),
		},
		sinceMs,
	);
	const orders = sweep.orders;
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

// A failing shop is counted and logged here, not rethrown. Its status is left
// alone (rotateCredential already parks a rejected refresh token); a shop that
// never completes a pass shows as stale in ops.snapshot via its checkpoint.
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
	return reconcileShops(active, { reconcile: (shopId) => reconcileShop(shopId, now), onFailure: recordShopFailure });
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
		// A throttle is a capacity signal, not a fault: the sweep persisted its
		// partial progress and the next tick resumes, so it is counted (and
		// logged at warn) separately from a genuine reconcile failure.
		if (isThrottledAdminError(e)) {
			metrics.inc(M.reconcileThrottled);
			log('warn', 'reconcile.throttled', { message: (e as Error).message });
		} else {
			metrics.inc(M.reconcileError);
			log('error', 'reconcile.error', { message: (e as Error).message });
		}
	}
});

// Inventory enrichment. An inventory webhook carries only inventory_item_id and
// a quantity, which is unreadable to a merchant and unsearchable by SKU. This
// sweep resolves unseen item ids (and the shop's locations) through the Admin API,
// caches them, and backfills EventSku rows so inventory events become
// SKU-searchable like every other domain. The orchestration itself (including the
// checkpoint that makes it converge — see src/ingest/inventoryEnrich.ts) is deps-injected
// and lives there, unit-testable without the Harper runtime, matching the
// accessToken.ts/tokenDeps.ts and processor.ts/jobs.ts split already in this
// codebase. This section only wires the real tables/Admin API/token resolution
// and exposes the handler. Every 15 minutes, from config.yaml's
// `sightline-inventory-enrich` job.
const enrichTicker = ticker('inventory.enrich', 30 * 60_000);

const enrichDeps: EnrichDeps = {
	shops: Shops as unknown as EnrichReadTable,
	events: Events as unknown as EnrichReadTable,
	inventoryItems: InventoryItems as unknown as EnrichDeps['inventoryItems'],
	shopLocations: ShopLocations as unknown as EnrichDeps['shopLocations'],
	eventSkus: EventSkus,
	checkpoints: Checkpoints as unknown as EnrichDeps['checkpoints'],
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

// One-time backfill of the derived `state` column on order projections written
// before that column existed. Without it, every lane count on the Overview
// disagrees with the list it links to — getSummary/computeFlows derive the lane
// live, listOrders filters the stored column — and the worst-affected population
// is the one the worklist exists for: a paid, unfulfilled, QUIET order gets no
// further events by definition, so it never rebuilds, and reconciliation's
// cursor-scoped sweep never re-fetches it either.
//
// Runs on a short interval so a deploy converges quickly, then goes quiet: rows
// written after the deploy always carry `state`, so once the checkpoint's
// frontier reaches the present each tick reads one small batch and writes
// nothing. The sweep itself is deps-injected in src/jobs/stateBackfill.ts (same split
// as inventoryEnrich.ts) so it is unit-testable without the Harper runtime.
// Every minute, from config.yaml's `sightline-state-backfill` job.
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
		// Only speaks up while there is something to do — a converged sweep is
		// silent, which is how an operator can tell it converged.
		if (r.fixed) log('info', 'state.backfill.tick', { scanned: r.scanned, fixed: r.fixed, cursor: r.cursor });
	} catch (e: unknown) {
		metrics.inc(M.stateBackfillError);
		log('error', 'state.backfill.error', { message: (e as Error).message });
	}
});

// Digest build (Plan C). Builds each subscriber's digest for the last COMPLETE
// period and writes it to the outbox with status 'pending'. THERE IS NO
// SENDER — delivery is a separate decision with its own compliance surface, so
// this loop deliberately stops at a persisted, ready-to-send message.
//
// Idempotent by construction: the outbox id is `${shopId}:${periodStart}` and
// the build decision keys on the subscription's lastBuiltAt, so overlapping
// ticks across threads and cluster nodes converge on one row per period. The
// orchestration itself is deps-injected and lives in src/digest/digestBuild.ts (same
// split as inventoryEnrich.ts/stateBackfill.ts) so it is unit-testable without
// the Harper runtime. This section only wires the real tables and the handler.
// Hourly, from config.yaml's `sightline-digest` job; the period check does the
// real gating.
// 180 minutes = 3x the hourly interval, matching reconcile's margin (also 3x its
// own interval): both sweep every active shop and do several full-table reads
// per shop, so a moderately slow pass should be tolerated before being flagged
// as stalled, not treated as unconditionally wedged at half the interval.
const digestTicker = ticker('digest', 180 * 60_000);

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
		// Never log the address — it is the one merchant-identifying string held.
		// notDue and quiet are logged separately (not combined into one
		// "skipped" figure): they answer different questions when digests seem
		// absent — were subscriptions even due, or did they build but decide not
		// to send? `failed` (per-subscription failures, already logged with their
		// own shopId inside runDigestBuildSweep) surfaces here too, so a sweep
		// with failures is never mistaken for a quiet, healthy one.
		if (r.built || r.skippedQuiet || r.failed)
			log('info', 'digest.built', { built: r.built, skippedQuiet: r.skippedQuiet, skippedNotDue: r.skippedNotDue, failed: r.failed });
	} catch (e: unknown) {
		// This catch is outside any per-subscription scope, so — unlike the
		// per-subscription failure log inside runDigestBuildSweep, which knows
		// the exact address to scrub — there is no specific address in hand
		// here. Scrub anything email-shaped rather than logging the message raw.
		log('error', 'digest.error', { message: scrubEmailShaped((e as Error).message) });
	}
});

// Observability heartbeat (#22). Periodically derives the aggregate ops-health
// (backlog age/count, dead letters, reconciliation staleness, reauth) from tables
// and emits it — with the cumulative metrics tally — as a single structured line.
// The staging log pipeline turns these snapshots into dashboards/alerts (#25).
// A warn line when unhealthy so an operator alert can key off it directly.
// Once a minute, from config.yaml's `sightline-ops-snapshot` job.
//
// Note the interaction with leader coordination: this heartbeat now comes from
// ONE node per minute instead of every thread on every node. That is the point —
// the snapshot was always cluster-wide (it reads replicated tables, see
// getOpsHealth below), so the extra copies said the same thing N times. But it
// does mean the heartbeat's ABSENCE is now a meaningful signal: no ops.snapshot
// line for several minutes means the scheduler has no leader, not merely that one
// node is quiet.
const snapshotTicker = ticker('ops.snapshot', 5 * 60_000);

// The same table wiring the snapshot uses, exposed so the ops endpoint
// (/api/v1/ops in resources.ts) answers from tables rather than from a log line.
// That distinction matters on a multi-node cluster: tables are replicated, so any
// node reports the whole cluster's backlog, whereas a log read only ever sees the
// node that happened to answer.
export function getOpsHealth(now = Date.now()): Promise<OpsHealth> {
	return computeOpsHealth(
		{
			deliveries: Deliveries as unknown as QueryTable,
			checkpoints: Checkpoints as unknown as QueryTable,
			credentials: Credentials as unknown as QueryTable,
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

// ── module-scope startup ──────────────────────────────────────────────────────
//
// The only side effect on import: the purge's single post-deploy pass.
startPurgeBootPass();
