import type { DeliveryStatus } from './model.ts';

export interface DeliveryRow {
	id: string;
	shopId: string;
	topic?: string;
	status: DeliveryStatus;
	attempts?: number;
	webhookId?: string;
	receivedAt?: number;
	payload?: string; // PII-stripped JSON body to normalize (#10)
}

// A thrown error is "permanent" when re-running can never succeed (a broken or
// unsupported payload shape). Duck-typed so the processor stays decoupled from
// the normalizer's error class. Permanent errors dead-letter immediately.
function isPermanent(err: unknown): boolean {
	return typeof err === 'object' && err !== null && (err as { permanent?: unknown }).permanent === true;
}

// Injected side effects — backed by Harper tables in the component, and by an
// in-memory fake in tests. `handle` is the pluggable unit of work (normalization
// lands in #10; for now it's a no-op that just marks the delivery processed).
export interface ProcessDeps {
	listAccepted(limit: number): Promise<DeliveryRow[]>;
	markProcessed(id: string): Promise<void>;
	markFailed(id: string, attempts: number, dead: boolean): Promise<void>;
	handle(row: DeliveryRow): Promise<void>;
}

export const MAX_ATTEMPTS = 5;

// Process a batch of accepted deliveries. Each is handled idempotently and
// marked processed; a transient failure increments attempts and stays accepted
// for retry; after MAX_ATTEMPTS it moves to a visible dead-letter state (ADR-002).
export async function processAcceptedBatch(
	deps: ProcessDeps,
	limit = 50,
): Promise<{ processed: number; failed: number; deadLettered: number }> {
	const rows = await deps.listAccepted(limit);
	let processed = 0;
	let failed = 0;
	let deadLettered = 0;
	for (const row of rows) {
		try {
			await deps.handle(row);
			await deps.markProcessed(row.id);
			processed += 1;
		} catch (err) {
			const attempts = (row.attempts ?? 0) + 1;
			// A broken payload can never succeed — dead-letter it now rather than
			// burning MAX_ATTEMPTS. Transient failures retry until the ceiling.
			const dead = isPermanent(err) || attempts >= MAX_ATTEMPTS;
			await deps.markFailed(row.id, attempts, dead);
			failed += 1;
			if (dead) deadLettered += 1;
		}
	}
	return { processed, failed, deadLettered };
}
