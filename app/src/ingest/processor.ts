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
	payload?: string; // allowlisted JSON body to normalize (src/privacy/pii.ts)
}

// Permanent means re-running can never succeed; duck-typed so the processor stays
// decoupled from the normalizer's error class.
function isPermanent(err: unknown): boolean {
	return typeof err === 'object' && err !== null && (err as { permanent?: unknown }).permanent === true;
}

export interface PendingRow extends DeliveryRow {
	pendingKey: string;
}

// Mirrors the computed, indexed WebhookDelivery.pendingKey in schema.graphql: set
// only while a row is accepted, ordered by shop, then receivedAt, then id. The id
// keeps keys unique, so a read that ends inside a millisecond loses no row to the cursor.
export function pendingKey(row: Pick<DeliveryRow, 'id' | 'shopId' | 'receivedAt'>): string {
	return `${row.shopId} ${row.receivedAt} ${row.id}`;
}

// Sorts after every pending key of `shopId` and before any other shop's: a shop
// domain has no character at or below '!' (isShopDomain), and ' ' ends its part.
export function pastShop(shopId: string): string {
	return `${shopId}!`;
}

// Injected side effects: Harper tables in the component, an in-memory fake in tests.
// `listPending` returns accepted rows whose pendingKey sorts after `after`, in key
// order. `handle` is the unit of work (normalization and projection).
export interface ProcessDeps {
	listPending(after: string, limit: number): Promise<PendingRow[]>;
	markProcessed(row: DeliveryRow): Promise<void>;
	markFailed(row: DeliveryRow, attempts: number, dead: boolean): Promise<void>;
	handle(row: DeliveryRow): Promise<void>;
}

export const MAX_ATTEMPTS = 5;

// Rows one shop may start per lap of the pending keys. Each lap re-reads from the
// first key, and a range read steps over the index entries of every row processed
// since the last compaction, so a turn must be long enough to amortize that
// (DESIGN.md, Drain order).
export const SHOP_SLICE = 250;

export interface Partition {
	slot: number;
	slots: number;
}

// FNV-1a (32-bit) of the id, modulo the slot count: a pure function of the id, so
// every executor agrees on which slot owns a row without coordinating. The drain
// partitions by shop id, so one shop's rows stay with one executor, in order.
export function partitionOf(id: string, slots: number): number {
	if (!Number.isInteger(slots) || slots < 1) throw new RangeError(`slot count must be a positive integer, got ${slots}`);
	let hash = 0x811c9dc5;
	for (let i = 0; i < id.length; i++) {
		hash ^= id.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0) % slots;
}

// Where the drain is in the pending keys. The caller keeps it across occurrences,
// so a lap longer than one budget resumes at the next shop rather than the first.
export interface DrainCursor {
	after: string;
	// Carried so a drain that stops mid-turn does not hand that shop a fresh turn.
	turn?: { shop: string; left: number };
}

export interface DrainOptions {
	budgetMs: number;
	batch?: number;
	slice?: number;
	partition?: Partition;
	cursor?: DrainCursor;
	now?: () => number;
}

export interface DrainResult {
	processed: number;
	failed: number;
	deadLettered: number;
	skippedKeyless: number;
	stoppedBy: 'empty' | 'budget' | 'failures' | 'error';
}

export function emptyDrainResult(): DrainResult {
	return { processed: 0, failed: 0, deadLettered: 0, skippedKeyless: 0, stoppedBy: 'empty' };
}

// Processes accepted deliveries round-robin across shops until none are left,
// `budgetMs` elapses, or `batch` rows have failed. Each is handled idempotently; a
// transient failure increments attempts and stays accepted; after MAX_ATTEMPTS it
// dead-letters (ADR-002).
//
// A lap walks the pending keys once: each shop starts at most `slice` of its oldest
// rows, then the cursor seeks past the shop, so one shop's backlog cannot hold back
// another's. Each read asks for no more than the current shop's remaining turn, so
// no row is read only to be passed over. A shop in another slot is sought past too.
//
// A failed row is skipped for the rest of the drain so retries are spaced one per
// occurrence rather than spent at once. The failure cap bounds an outage to one
// batch of attempts per occurrence. A lap that starts nothing ends the drain.
//
// Counts accumulate into `result` row by row, so a caller keeps the work done before a throw.
export async function drainAccepted(deps: ProcessDeps, options: DrainOptions, result = emptyDrainResult()): Promise<DrainResult> {
	const { budgetMs, batch = 50, slice = SHOP_SLICE, partition = { slot: 0, slots: 1 }, cursor = { after: '' }, now = Date.now } = options;
	const startedAt = now();
	const skip = new Set<string>();
	let wholeLap = cursor.after === ''; // this lap began at the first key
	let lapStarted = false; // this lap started a row
	for (;;) {
		if (cursor.turn?.left === 0) {
			cursor.after = pastShop(cursor.turn.shop);
			cursor.turn = undefined;
		}
		const rows = await deps.listPending(cursor.after, cursor.turn?.left ?? slice);
		if (rows.length === 0) {
			if (wholeLap && !lapStarted) return result;
			cursor.after = '';
			wholeLap = true;
			lapStarted = false;
			cursor.turn = undefined;
			continue;
		}
		for (const row of rows) {
			// A row an older patch recreated over a deleted delivery holds neither its key nor its
			// shop, and a search does not return the key, so it can be neither handled nor
			// patched. It is passed over, and counted so an operator can remove it.
			if (typeof row.id !== 'string' || typeof row.shopId !== 'string' || row.shopId === '') {
				cursor.after = row.pendingKey;
				result.skippedKeyless += 1;
				continue;
			}
			// Before the turn changes hands, so a stop here leaves the turn naming the shop `after` is in.
			if (now() - startedAt >= budgetMs) {
				result.stoppedBy = 'budget';
				return result;
			}
			let turn = cursor.turn;
			if (turn?.shop !== row.shopId) {
				if (partitionOf(row.shopId, partition.slots) !== partition.slot) {
					cursor.after = pastShop(row.shopId);
					cursor.turn = undefined;
					break;
				}
				turn = cursor.turn = { shop: row.shopId, left: slice };
			}
			cursor.after = row.pendingKey;
			if (skip.has(row.id)) continue;
			turn.left -= 1;
			lapStarted = true;
			try {
				await deps.handle(row);
				await deps.markProcessed(row);
				result.processed += 1;
			} catch (err) {
				const attempts = (row.attempts ?? 0) + 1;
				// A broken payload can never succeed; dead-letter it now.
				const dead = isPermanent(err) || attempts >= MAX_ATTEMPTS;
				await deps.markFailed(row, attempts, dead);
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
	if (r.skippedKeyless) deps.metrics.inc(M.processKeylessSkipped, r.skippedKeyless);
	if (r.processed || r.failed) deps.log('trace', 'process.tick', { ...r });
	return r;
}
