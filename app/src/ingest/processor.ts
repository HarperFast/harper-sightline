import type { DeliveryStatus } from '../domain/model.ts';
import { M, type LogLevel } from '../observability/observe.ts';

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

// Permanent means re-running can never succeed; duck-typed so the processor stays
// decoupled from the normalizer's error class.
function isPermanent(err: unknown): boolean {
	return typeof err === 'object' && err !== null && (err as { permanent?: unknown }).permanent === true;
}

// Injected side effects: Harper tables in the component, an in-memory fake in tests.
// `handle` is the unit of work (normalization and projection).
export interface ProcessDeps {
	listAccepted(limit: number): Promise<DeliveryRow[]>;
	markProcessed(id: string): Promise<void>;
	markFailed(id: string, attempts: number, dead: boolean): Promise<void>;
	handle(row: DeliveryRow): Promise<void>;
}

export const MAX_ATTEMPTS = 5;

export interface Partition {
	slot: number;
	slots: number;
}

// FNV-1a (32-bit) of the id, modulo the slot count: a pure function of the id, so
// every executor agrees on which slot owns a row without coordinating.
export function partitionOf(id: string, slots: number): number {
	if (!Number.isInteger(slots) || slots < 1) throw new RangeError(`slot count must be a positive integer, got ${slots}`);
	let hash = 0x811c9dc5;
	for (let i = 0; i < id.length; i++) {
		hash ^= id.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0) % slots;
}

export interface DrainOptions {
	budgetMs: number;
	batch?: number;
	partition?: Partition;
	now?: () => number;
}

export interface DrainResult {
	processed: number;
	failed: number;
	deadLettered: number;
	stoppedBy: 'empty' | 'budget' | 'failures' | 'error';
}

export function emptyDrainResult(): DrainResult {
	return { processed: 0, failed: 0, deadLettered: 0, stoppedBy: 'empty' };
}

// Processes accepted deliveries in batches until none are left, `budgetMs` elapses,
// or `batch` rows have failed. Each is handled idempotently; a transient failure
// increments attempts and stays accepted; after MAX_ATTEMPTS it dead-letters (ADR-002).
//
// A failed row, or one in another slot, is skipped for the rest of the drain so
// retries are spaced one per occurrence rather than spent at once. The read limit
// grows by the skipped count so skipped rows at the head cannot hide those behind.
// The failure cap bounds an outage to one batch of attempts per occurrence.
//
// Counts accumulate into `result` row by row, so a caller keeps the work done before a throw.
export async function drainAccepted(deps: ProcessDeps, options: DrainOptions, result = emptyDrainResult()): Promise<DrainResult> {
	const { budgetMs, batch = 50, partition = { slot: 0, slots: 1 }, now = Date.now } = options;
	const startedAt = now();
	const skip = new Set<string>();
	for (;;) {
		const rows: DeliveryRow[] = [];
		for (const row of await deps.listAccepted(batch + skip.size)) {
			if (skip.has(row.id)) continue;
			if (partitionOf(row.id, partition.slots) === partition.slot) rows.push(row);
			else skip.add(row.id);
		}
		if (rows.length === 0) return result;
		for (const row of rows) {
			if (now() - startedAt >= budgetMs) {
				result.stoppedBy = 'budget';
				return result;
			}
			try {
				await deps.handle(row);
				await deps.markProcessed(row.id);
				result.processed += 1;
			} catch (err) {
				const attempts = (row.attempts ?? 0) + 1;
				// A broken payload can never succeed; dead-letter it now.
				const dead = isPermanent(err) || attempts >= MAX_ATTEMPTS;
				await deps.markFailed(row.id, attempts, dead);
				result.failed += 1;
				if (dead) result.deadLettered += 1;
				skip.add(row.id);
				if (result.failed >= batch) {
					result.stoppedBy = 'failures';
					return result;
				}
			}
		}
	}
}

export interface ProcessCycleDeps {
	drain(into: DrainResult): Promise<unknown>;
	log(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
	metrics: { inc(name: string, by?: number): void };
}

// One scheduler occurrence. Never throws: a failure is counted and logged, and
// the next occurrence retries from the durable backlog.
export async function runProcessCycle(deps: ProcessCycleDeps): Promise<DrainResult> {
	const r = emptyDrainResult();
	try {
		await deps.drain(r);
	} catch (e: unknown) {
		r.stoppedBy = 'error';
		deps.metrics.inc(M.processError);
		deps.log('error', 'process.error', { message: (e as Error).message });
	}
	deps.metrics.inc(M.processProcessed, r.processed);
	deps.metrics.inc(M.processFailed, r.failed);
	deps.metrics.inc(M.processDeadLettered, r.deadLettered);
	if (r.processed || r.failed) deps.log('trace', 'process.tick', { ...r });
	return r;
}
