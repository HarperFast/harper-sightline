// One-run-at-a-time guard for background loops that cannot wedge forever: after
// `stallMs` the previous run is presumed stuck and a new one may start. Overlap is
// tolerable because the work is idempotent (deterministic event ids); a loop that
// is permanently dead is not.

export interface TickerOptions {
	name: string;
	stallMs: number;
	onStall?: (name: string, ageMs: number) => void;
}

export interface Ticker {
	// Starts `work` unless a run is in flight and not yet stalled; returns null when skipped.
	run(work: () => Promise<void>, now?: number): Promise<void> | null;
	// Like `run`, but the promise settles after at most `stallMs`: Harper arms a job's
	// next occurrence only once its handler settles, so awaiting a hung pass would stop the job.
	runBounded(work: () => Promise<void>): Promise<void> | null;
	isRunning(now?: number): boolean;
}

export function createTicker(options: TickerOptions): Ticker {
	// `id` stops a stalled run settling late from clearing the flag of the run that replaced it.
	let current: { startedAt: number; id: number } | null = null;
	let seq = 0;

	const ticker: Ticker = {
		run(work, now = Date.now()) {
			if (current !== null) {
				const ageMs = now - current.startedAt;
				if (ageMs < options.stallMs) return null;
				options.onStall?.(options.name, ageMs);
			}
			const id = ++seq;
			current = { startedAt: now, id };
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
