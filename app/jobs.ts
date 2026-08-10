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
import type { Expectation, GapFinding, OperationalEvent } from './src/model.ts';
import { processAcceptedBatch, type ProcessDeps, type DeliveryRow } from './src/processor.ts';
import { normalizeDelivery, isOperationalTopic, PermanentNormalizeError } from './src/normalize.ts';
import { writeEventWithSkus } from './src/eventSkus.ts';
import { isOrderLinked, rebuildProjection } from './src/projection.ts';
import { uninstallShop } from './src/lifecycle.ts';
import { evaluateOrder, detectorKey, FAILED_RULE, evaluateFailedFulfillment } from './src/detector.ts';
import { purgeExpired, type PurgeResult } from './src/retention.ts';
import { RETENTION_TARGETS, OUTBOX_RETENTION_DAYS, OUTBOX_RETENTION_TARGETS } from './src/ledgerTargets.ts';
import { getUsableAccessToken, isAuthError } from './src/accessToken.ts';
import { tokenDeps, rotateShopCredential } from './src/tokenDeps.ts';
import { fetchOrdersUpdatedSince, fetchShopTimezone, fetchInventoryItems, fetchLocations } from './src/adminApi.ts';
import { synthesizeEvents } from './src/reconcile.ts';
import { runInventoryEnrichment as runEnrichmentSweep, type EnrichDeps, type EnrichReadTable } from './src/inventoryEnrich.ts';
import { runStateBackfill, type BackfillDeps, type BackfillResult } from './src/stateBackfill.ts';
import {
	runDigestBuild as runDigestBuildSweep,
	scrubEmailShaped,
	type DigestBuildDeps,
	type DigestBuildResult,
} from './src/digestBuild.ts';
import { log, metrics, M } from './src/observe.ts';
import { computeOpsHealth } from './src/opsHealth.ts';
import { createTicker } from './src/tick.ts';
import type { QueryTable } from './src/queries.ts';

// Every background loop runs at most one pass at a time, but must never be able
// to wedge permanently if a pass fails to settle (src/tick.ts). A detected stall
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
const processTicker = ticker('process', 5 * 60_000);

export function startProcessingLoop(): void {
	setInterval(() => {
		void processTicker.run(async () => {
			try {
				const r = await processDeliveries();
				metrics.inc(M.processProcessed, r.processed);
				metrics.inc(M.processFailed, r.failed);
				metrics.inc(M.processDeadLettered, r.deadLettered);
				if (r.processed || r.failed)
					log('trace', 'process.tick', { processed: r.processed, failed: r.failed, deadLettered: r.deadLettered });
			} catch (e: unknown) {
				metrics.inc(M.processError);
				log('error', 'process.error', { message: (e as Error).message });
			}
		});
	}, INTERVAL_MS);
}

// Seven-day retention purge (ADR-003). Runs shortly after boot (to clear any
// backlog from downtime, and so it is verifiable after a deploy) and then hourly.
// The purge is idempotent, so concurrent runs across threads/nodes are safe — no
// lease needed; the `purging` guard just avoids overlap on one thread.
const PURGE_INTERVAL_MS = 3_600_000; // hourly
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

function purgeTick(): void {
	void purgeTicker.run(async () => {
		try {
			const r = await runPurge();
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
		} catch (e: unknown) {
			metrics.inc(M.purgeError);
			log('error', 'purge.error', { message: (e as Error).message });
		}

		// The outbox sweep gets its OWN try/catch rather than sharing the ledger
		// purge's. Sharing one meant a ledger-purge failure skipped the outbox
		// entirely on that tick — and since a persistent ledger failure repeats
		// every tick, the 30-day digest retention this app discloses publicly
		// would quietly stop running while the only symptom logged was
		// `purge.error` about a different table. The two sweeps are independent
		// (different tables, different cutoffs), so a failure in one must not
		// decide whether the other runs. Same metrics as the ledger purge: the
		// counters are per-purge-activity, not per-table, so ops.snapshot's tally
		// reflects outbox work instead of showing nothing for it.
		try {
			const outbox = await runOutboxPurge();
			metrics.inc(M.purgeDeleted, outbox.deleted);
			if (outbox.failures.length) metrics.inc(M.purgeFailure, outbox.failures.length);
			if (outbox.deleted) log('trace', 'purge.outbox', { deleted: outbox.deleted });
			// Residue on the outbox means the same thing it means for the ledger —
			// expired rows still present after a run (purge lag) — and was the one
			// signal of the two sweeps that had no log line at all.
			if (outbox.residue) log('warn', 'purge.outbox.residue', { residue: outbox.residue });
			if (outbox.failures.length) log('warn', 'purge.outbox.failures', { count: outbox.failures.length, failures: outbox.failures });
		} catch (e: unknown) {
			metrics.inc(M.purgeError);
			log('error', 'purge.outbox.error', { message: (e as Error).message });
		}
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

function detectorTick(): void {
	void detectorTicker.run(async () => {
		try {
			const due = await runDetectorSweep();
			metrics.inc(M.detectEvaluated, due);
			if (due) log('trace', 'detect.tick', { evaluated: due });
		} catch (e: unknown) {
			metrics.inc(M.detectError);
			log('error', 'detect.error', { message: (e as Error).message });
		}
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
	let cursor: string | undefined;
	let latest = sinceMs;
	let orders = 0;
	do {
		const page = await fetchOrdersUpdatedSince(shopId, token, sinceMs, cursor);
		for (const order of page.orders) {
			for (const event of synthesizeEvents(shopId, order)) {
				await writeEventWithSkus({ events: Events, eventSkus: EventSkus }, event);
			}
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
	void reconcileTicker.run(async () => {
		const startedAt = Date.now();
		try {
			const r = await runReconcileSweep();
			metrics.observeMs(M.reconcileMs, Date.now() - startedAt);
			metrics.inc(M.reconcileShops, r.shops);
			metrics.inc(M.reconcileOrders, r.orders);
			if (r.orders) log('trace', 'reconcile.tick', { shops: r.shops, orders: r.orders });
		} catch (e: unknown) {
			metrics.inc(M.reconcileError);
			log('error', 'reconcile.error', { message: (e as Error).message });
		}
	});
}

export function startReconcileLoop(): void {
	setTimeout(reconcileTick, RECONCILE_INITIAL_DELAY_MS);
	setInterval(reconcileTick, RECONCILE_INTERVAL_MS);
}

// Inventory enrichment. An inventory webhook carries only inventory_item_id and
// a quantity, which is unreadable to a merchant and unsearchable by SKU. This
// sweep resolves unseen item ids (and the shop's locations) through the Admin API,
// caches them, and backfills EventSku rows so inventory events become
// SKU-searchable like every other domain. The orchestration itself (including the
// checkpoint that makes it converge — see src/inventoryEnrich.ts) is deps-injected
// and lives there, unit-testable without the Harper runtime, matching the
// accessToken.ts/tokenDeps.ts and processor.ts/jobs.ts split already in this
// codebase. This section only wires the real tables/Admin API/token resolution
// and schedules the tick.
const ENRICH_INTERVAL_MS = 900_000; // 15 minutes
const ENRICH_INITIAL_DELAY_MS = 60_000;
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

function enrichTick(): void {
	void enrichTicker.run(async () => {
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
}

export function startInventoryEnrichmentLoop(): void {
	setTimeout(enrichTick, ENRICH_INITIAL_DELAY_MS);
	setInterval(enrichTick, ENRICH_INTERVAL_MS);
}

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
// nothing. The sweep itself is deps-injected in src/stateBackfill.ts (same split
// as inventoryEnrich.ts) so it is unit-testable without the Harper runtime.
const BACKFILL_INTERVAL_MS = 60_000;
const BACKFILL_INITIAL_DELAY_MS = 15_000;
const backfillTicker = ticker('state.backfill', 10 * 60_000);

const backfillDeps: BackfillDeps = {
	projections: Projections as unknown as BackfillDeps['projections'],
	checkpoints: Checkpoints as unknown as BackfillDeps['checkpoints'],
};

export function runProjectionStateBackfill(now = Date.now()): Promise<BackfillResult> {
	return runStateBackfill(now, backfillDeps);
}

function backfillTick(): void {
	void backfillTicker.run(async () => {
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
}

export function startProjectionStateBackfillLoop(): void {
	setTimeout(backfillTick, BACKFILL_INITIAL_DELAY_MS);
	setInterval(backfillTick, BACKFILL_INTERVAL_MS);
}

// Digest build (Plan C). Builds each subscriber's digest for the last COMPLETE
// period and writes it to the outbox with status 'pending'. THERE IS NO
// SENDER — delivery is a separate decision with its own compliance surface, so
// this loop deliberately stops at a persisted, ready-to-send message.
//
// Idempotent by construction: the outbox id is `${shopId}:${periodStart}` and
// the build decision keys on the subscription's lastBuiltAt, so overlapping
// ticks across threads and cluster nodes converge on one row per period. The
// orchestration itself is deps-injected and lives in src/digestBuild.ts (same
// split as inventoryEnrich.ts/stateBackfill.ts) so it is unit-testable without
// the Harper runtime. This section only wires the real tables and the tick.
const DIGEST_INTERVAL_MS = 3_600_000; // hourly; the period check does the real gating
const DIGEST_INITIAL_DELAY_MS = 90_000;
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

function digestTick(): void {
	void digestTicker.run(async () => {
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
}

export function startDigestLoop(): void {
	setTimeout(digestTick, DIGEST_INITIAL_DELAY_MS);
	setInterval(digestTick, DIGEST_INTERVAL_MS);
}

// Observability heartbeat (#22). Periodically derives the aggregate ops-health
// (backlog age/count, dead letters, reconciliation staleness, reauth) from tables
// and emits it — with the cumulative metrics tally — as a single structured line.
// The staging log pipeline turns these snapshots into dashboards/alerts (#25).
// A warn line when unhealthy so an operator alert can key off it directly.
const OPS_SNAPSHOT_INTERVAL_MS = 60_000; // once a minute
const OPS_SNAPSHOT_INITIAL_DELAY_MS = 20_000;
const snapshotTicker = ticker('ops.snapshot', 5 * 60_000);

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
	void snapshotTicker.run(async () => {
		try {
			await runOpsSnapshot();
		} catch (e: unknown) {
			log('error', 'ops.snapshot.error', { message: (e as Error).message });
		}
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
startInventoryEnrichmentLoop();
startProjectionStateBackfillLoop();
startDigestLoop();
startOpsSnapshotLoop();
