import { Deliveries, Events, Projections } from './src/db.ts';
import type { OperationalEvent } from './src/model.ts';
import { processAcceptedBatch, type ProcessDeps, type DeliveryRow } from './src/processor.ts';
import { normalizeDelivery, isOperationalTopic, PermanentNormalizeError } from './src/normalize.ts';
import { isOrderLinked, rebuildProjection } from './src/projection.ts';
import { purgeExpired, type PurgeResult } from './src/retention.ts';
import { RETENTION_TARGETS } from './src/ledgerTargets.ts';

// Rebuild an order's projection from ALL its normalized events (#12). Rebuilding
// from the ledger (rather than an incremental read-modify-write) is order-safe
// and far more robust to concurrent writers: every writer recomputes the full
// state from the persisted events, so a lost write self-heals on the next event.
// The reducer is commutative, so query order is irrelevant.
async function updateOrderProjection(event: OperationalEvent): Promise<void> {
	const events: OperationalEvent[] = [];
	for await (const e of Events.search({
		conditions: [
			{ attribute: 'shopId', value: event.shopId },
			{ attribute: 'resourceId', value: event.resourceId },
		],
		operator: 'and',
	})) {
		events.push(e as unknown as OperationalEvent);
	}
	const projection = rebuildProjection(events);
	if (projection) await Projections.put(projection);
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
		// Lifecycle/compliance topics carry no operational payload — nothing to do.
		if (!isOperationalTopic(row.topic)) return;
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
			// Maintain the order projection from the persisted ledger (#12).
			if (isOrderLinked(event)) await updateOrderProjection(event);
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

startProcessingLoop();
startPurgeLoop();
