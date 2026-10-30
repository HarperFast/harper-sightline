// One CSV export in flight per node: a big-shop export holds a thread for seconds, and
// two at once doubled the time every webhook ack waited (DESIGN.md, Measured costs).
// A second concurrent export is refused with a 429 and Retry-After rather than queued:
// a queued export would hold the merchant's request open for the whole of the first one.
//
// Harper runs each node as worker threads of one process, so module state alone would
// be one export per thread. The slot is a lease in a buffer every thread shares
// (sharedExportSlot); the holder writes its expiry there with compare-and-swap, and
// a release clears only its own lease. A thread that dies mid-export cannot leave the
// slot held: after EXPORT_LEASE_MS the next export takes it.

// Long enough that an immediate retry is unlikely to hit the same export, short
// enough that a merchant waits a moment rather than a minute.
export const EXPORT_BUSY_RETRY_SECONDS = 5;

// About ten times the slowest big-shop export. An export still running past it lets one
// more start alongside: two at once, the cost this gate exists to avoid, but never a
// stuck slot.
export const EXPORT_LEASE_MS = 120_000;

// Low bits of the lease value, so two leases taken in the same millisecond still differ
// and a late release cannot clear a lease another export took.
const NONCE = 4096n;

export interface ExportGate {
	// A release function, or undefined when an export is already running.
	tryAcquire(): (() => void) | undefined;
	busy(): boolean;
}

export function createExportGate(opts: { slot?: BigInt64Array; now?: () => number; leaseMs?: number } = {}): ExportGate {
	// [0] = lease expiry (ms) x NONCE + nonce, or 0 when free.
	const slot = opts.slot ?? new BigInt64Array(1);
	const now = opts.now ?? Date.now;
	const leaseMs = opts.leaseMs ?? EXPORT_LEASE_MS;
	const held = (value: bigint, at: number) => value !== 0n && value / NONCE > BigInt(at);
	return {
		tryAcquire() {
			const at = now();
			const current = Atomics.load(slot, 0);
			if (held(current, at)) return undefined;
			const mine = BigInt(at + leaseMs) * NONCE + BigInt(Math.floor(Math.random() * Number(NONCE)));
			// Another thread took it between the load and here.
			if (Atomics.compareExchange(slot, 0, current, mine) !== current) return undefined;
			return () => {
				Atomics.compareExchange(slot, 0, mine, 0n);
			};
		},
		busy() {
			return held(Atomics.load(slot, 0), now());
		},
	};
}

// The node-wide slot: an 8-byte buffer from a table's store, the mechanism Harper uses
// for its own cross-thread counters (request ids, id allocation). Falls back to a
// per-thread slot if the store does not offer one, which weakens the limit to one
// export per thread rather than failing every export.
export function sharedExportSlot(store: { getUserSharedBuffer?(key: string, defaultBuffer: ArrayBuffer): ArrayBuffer } | undefined): {
	slot: BigInt64Array;
	shared: boolean;
} {
	if (typeof store?.getUserSharedBuffer !== 'function') return { slot: new BigInt64Array(1), shared: false };
	return { slot: new BigInt64Array(store.getUserSharedBuffer('sightline-export-lease', new ArrayBuffer(8))), shared: true };
}

// Runs `run` holding the gate, or returns `onBusy()` without running it. The slot is
// released however `run` ends: success, a thrown query error, or a client that went away
// (the export still runs to completion; the write of the response is what fails).
export async function runExclusive<T>(gate: ExportGate, run: () => Promise<T>, onBusy: () => T): Promise<T> {
	const release = gate.tryAcquire();
	if (!release) return onBusy();
	try {
		return await run();
	} finally {
		release();
	}
}

// The refusal. The body is a bare JSON string, the shape the SPA's errorDetail reads
// for this app's own errors; web/src/view.ts exportErrorMessage matches its wording.
export function exportBusyResponse(): Response {
	return new Response(JSON.stringify(`another export is in progress — retry in ${EXPORT_BUSY_RETRY_SECONDS}s`), {
		status: 429,
		headers: { 'content-type': 'application/json', 'retry-after': String(EXPORT_BUSY_RETRY_SECONDS) },
	});
}
