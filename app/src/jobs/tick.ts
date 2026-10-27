// A "one run at a time" guard for background loops that CANNOT wedge forever.
//
// WHY. Every loop in jobs.ts used the same shape:
//
//   let running = false;
//   if (running) return;
//   running = true;
//   void work().finally(() => { running = false; });
//
// which is correct only if `work()` always settles. `reconcileShop` calls the
// Admin API through `fetch`, which has NO default timeout, so a hung connection
// leaves the promise pending forever — `running` stays true, every subsequent
// tick returns early, and that loop is dead until the process restarts. Silent,
// and indistinguishable from "nothing to do".
//
// The primary fix is bounding the external call (adminApi.ts). This is the
// backstop for everything else: after `stallMs` the previous run is presumed
// stuck and a new one is allowed to start. Overlap is the lesser evil — the work
// is idempotent (deterministic event ids, checkpoints written only after a full
// pass), and two cluster nodes already run these loops concurrently, so overlap
// is a condition the design tolerates by construction. Being permanently dead is
// not.

export interface TickerOptions {
	name: string;
	// How long a run may take before a new tick is allowed to start anyway.
	stallMs: number;
	// Called when a stall is detected. Wired to a log line so a stuck loop is an
	// alertable event rather than silence.
	onStall?: (name: string, ageMs: number) => void;
}

export interface Ticker {
	// Starts `work` unless a run is already in flight and not yet considered
	// stalled. Returns the promise when started, or null when skipped.
	run(work: () => Promise<void>, now?: number): Promise<void> | null;
	// Like `run`, but the returned promise settles after at most `stallMs`. Harper's
	// scheduler arms a job's next occurrence only once its handler settles, so a
	// handler awaiting a hung pass would never fire again and never reach the
	// stall check in `run`.
	runBounded(work: () => Promise<void>): Promise<void> | null;
	isRunning(now?: number): boolean;
}

export function createTicker(options: TickerOptions): Ticker {
	// `seq` identifies the owning run so that a stalled run settling LATE cannot
	// clear the flag belonging to the run that replaced it — the subtle bug in any
	// naive `finally { running = false }` retrofit.
	let current: { startedAt: number; id: number } | null = null;
	let seq = 0;

	const ticker: Ticker = {
		run(work, now = Date.now()) {
			if (current !== null) {
				const ageMs = now - current.startedAt;
				if (ageMs < options.stallMs) return null; // genuinely still working
				options.onStall?.(options.name, ageMs);
			}
			const id = ++seq;
			current = { startedAt: now, id };
			// Settle-order safety: only the owning run may clear `current`.
			return work().finally(() => {
				if (current?.id === id) current = null;
			});
		},
		runBounded(work) {
			const pass = ticker.run(work);
			if (pass === null) return null;
			return new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, options.stallMs);
				timer.unref();
				pass.then(
					() => {
						clearTimeout(timer);
						resolve();
					},
					(err: unknown) => {
						clearTimeout(timer);
						reject(err);
					},
				);
			});
		},
		isRunning(now = Date.now()) {
			return current !== null && now - current.startedAt < options.stallMs;
		},
	};
	return ticker;
}
