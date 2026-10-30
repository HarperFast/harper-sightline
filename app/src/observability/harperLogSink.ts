import { setLogSink, type LogLevel } from './observe.ts';

// Routes application logs into Harper's logger so `read_log` can see them; console
// output never reaches it. Harper injects `logger` as a global, not a `harper`
// export. Method names are probed rather than assumed, and a line always lands
// somewhere: falling back to console beats dropping it.

type LoggerLike = Record<string, unknown>;

function harperLogger(): LoggerLike | undefined {
	const candidate = (globalThis as { logger?: unknown }).logger;
	return candidate && typeof candidate === 'object' ? (candidate as LoggerLike) : undefined;
}

// Our levels mapped onto Harper's, most specific first; probing tolerates a missing method.
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
				// A throwing logger method must not take the caller down; try the next, then console.
			}
		}
	}
	return false;
}

// Returns false when no Harper logger is present (unit tests, vite dev).
export function installHarperLogSink(): boolean {
	const logger = harperLogger();
	if (!logger) return false;
	setLogSink((level, line) => {
		if (emit(logger, level, line)) return;
		// Never silently drop a line.
		if (level === 'error' || level === 'warn') console.error(line);
		else console.log(line);
	});
	return true;
}
