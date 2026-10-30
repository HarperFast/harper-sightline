// One CSV export in flight per worker thread: a big-shop export holds its thread for
// seconds, and two interleaved on one event loop doubled the time every webhook ack on
// it waited (DESIGN.md, Measured costs). Other workers keep serving. A second concurrent
// export on the same thread is refused with a 429 and Retry-After rather than queued: a
// queued export would hold the merchant's request open for the whole of the first one.

// Long enough that an immediate retry is unlikely to hit the same export, short
// enough that a merchant waits a moment rather than a minute.
export const EXPORT_BUSY_RETRY_SECONDS = 5;

export interface ExportGate {
	// A release function, or undefined when an export is already running.
	tryAcquire(): (() => void) | undefined;
	busy(): boolean;
}

export function createExportGate(): ExportGate {
	let holder: object | undefined;
	return {
		tryAcquire() {
			if (holder) return undefined;
			const mine = {};
			holder = mine;
			// Only its own hold: a second call of a stale release frees nothing.
			return () => {
				if (holder === mine) holder = undefined;
			};
		},
		busy() {
			return holder !== undefined;
		},
	};
}

// Runs `run` holding the gate, or returns `onBusy()` without running it. The gate is
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
