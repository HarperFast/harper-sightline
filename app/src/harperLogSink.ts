import { setLogSink, type LogLevel } from './observe.ts';

// Route application logs into Harper's logger so they are reachable through the
// operations API (`read_log`).
//
// WHY. observe.ts defaulted to console.*, which writes to the container's
// stdout/stderr. `read_log` reads Harper's own log, so NOTHING the app logged was
// visible through the operations API — verified 2026-08-07: zero entries on both
// cluster nodes despite the once-a-minute `ops.snapshot` heartbeat. That is how a
// 21-hour reconciliation outage stayed invisible: computeOpsHealth correctly
// flipped `healthy` to false and runOpsSnapshot logged a WARN every 60 seconds for
// the whole outage, and every one of those lines was discarded. The detection
// existed; the delivery did not.
//
// Harper injects `logger` as a global into component modules (like `server`),
// not as a `harper` module export. Method names are probed rather than assumed,
// and a line always lands somewhere — falling back to console beats dropping it.

type LoggerLike = Record<string, unknown>;

function harperLogger(): LoggerLike | undefined {
	const candidate = (globalThis as { logger?: unknown }).logger;
	return candidate && typeof candidate === 'object' ? (candidate as LoggerLike) : undefined;
}

// Our levels mapped onto Harper's, most-specific first. Harper's logger has
// historically exposed notify/error/warn/info/debug/trace; probing keeps this
// working if a given method is absent on a particular version.
const LEVEL_METHODS: Record<LogLevel, string[]> = {
	error: ['error', 'fatal', 'warn', 'info'],
	warn: ['warn', 'error', 'info'],
	info: ['info', 'notify', 'log'],
	debug: ['debug', 'trace', 'info'],
	trace: ['trace', 'debug', 'info'],
};

function emit(logger: LoggerLike, level: LogLevel, line: string): boolean {
	for (const method of LEVEL_METHODS[level]) {
		const fn = logger[method];
		if (typeof fn === 'function') {
			try {
				(fn as (message: string) => void).call(logger, line);
				return true;
			} catch {
				// A throwing logger method must not take the caller down with it; try
				// the next candidate, then console.
			}
		}
	}
	return false;
}

// Install the sink. Returns false when no Harper logger is present (unit tests,
// local vite dev), leaving the console default in place.
export function installHarperLogSink(): boolean {
	const logger = harperLogger();
	if (!logger) return false;
	setLogSink((level, line) => {
		if (emit(logger, level, line)) return;
		// Never silently drop a line — that is the bug this module exists to fix.
		if (level === 'error' || level === 'warn') console.error(line);
		else console.log(line);
	});
	return true;
}
