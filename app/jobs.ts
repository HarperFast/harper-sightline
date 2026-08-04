import { Deliveries } from './src/db.ts';
import { processAcceptedBatch, type ProcessDeps, type DeliveryRow } from './src/processor.ts';

// Harper-backed processing deps. `handle` is a no-op for now — normalization
// (payload → OperationalEvent) lands in #10; #9 proves the durable pipeline:
// scan accepted deliveries, process idempotently, mark processed / dead-letter.
const deps: ProcessDeps = {
	async listAccepted(limit) {
		const rows: DeliveryRow[] = [];
		for await (const r of Deliveries.search({ conditions: [{ attribute: 'status', value: 'accepted' }], limit })) {
			rows.push({ id: r.id, shopId: r.shopId, topic: r.topic, status: r.status, attempts: r.attempts });
		}
		return rows;
	},
	async markProcessed(id) {
		await Deliveries.patch(id, { status: 'processed' });
	},
	async markFailed(id, attempts, dead) {
		await Deliveries.patch(id, { attempts, status: dead ? 'dead_letter' : 'accepted' });
	},
	async handle() {
		// no-op until #10
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

startProcessingLoop();
