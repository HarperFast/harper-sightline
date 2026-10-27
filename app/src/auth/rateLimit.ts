// Per-caller request limiting for the read API (security review F7). Nothing
// bounded how often one session token could ask for work, and `/api/v1/export`
// walks up to MAX_EXPORT_ROWS rows per call — so a single valid token could ask
// for arbitrarily many bounded-but-expensive reads.
//
// SCOPE, stated plainly so this is not mistaken for DoS protection: the counters
// live in module memory, so each worker thread keeps its own copy and the
// effective bound is the stated limit x worker threads x nodes. These are soft
// abuse dampers, not quotas: they dampen what ONE authenticated shop can ask of
// the app, and edge/L7 protection remains the answer for volumetric attack (threat
// model §3.3). Nothing here is a security boundary: the tenant isolation in front
// of it does not depend on it.

// A window of 60s, sized so a limit reads as "per minute" everywhere it appears.
export const RATE_WINDOW_MS = 60_000;

// Per verified shop, across every authenticated read. The SPA issues ~5 requests
// per screen (the Overview fans out to 4 plus the context strip), so a merchant
// clicking as fast as they can is two orders of magnitude below this; it exists to
// bound scripted reuse of one token, not to pace a human.
export const API_REQUESTS_PER_MINUTE = 600;

// Per verified shop, for CSV export alone — the one read whose cost is not
// proportional to what the caller asked for: each call pages until MAX_EXPORT_ROWS
// (5000 rows / 50 pages). Ten a minute is more than a merchant exporting every
// screen with every filter combination will ever click.
export const EXPORTS_PER_MINUTE = 10;

// Distinct keys held per limiter. Sightline's realistic key count is "shops with
// someone in the app right now", so this is generous; it exists so the limiter
// itself can never become the memory-exhaustion bug it is meant to prevent.
const DEFAULT_MAX_KEYS = 4096;

// The bucket that excess keys collapse into once the map is full. Deliberately a
// name no shop domain can be (a shop id is `<handle>.myshopify.com`), so a caller
// cannot pick a key that lands them in — or out of — it.
const OVERFLOW_KEY = ' overflow';

export class RateLimitError extends Error {
	statusCode: number;
	retryAfterSeconds: number;
	constructor(what: string, retryAfterSeconds: number) {
		super(`too many ${what} — retry in ${retryAfterSeconds}s`);
		this.name = 'RateLimitError';
		this.statusCode = 429;
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

export interface RateDecision {
	allowed: boolean;
	// Seconds until this key's window rolls over. 0 when allowed.
	retryAfterSeconds: number;
}

export interface RateLimiter {
	check(key: string, now: number): RateDecision;
	// Held keys, for tests and for the ops snapshot.
	size(): number;
}

// A fixed-window counter. Fixed rather than sliding on purpose: a sliding window
// needs per-request timestamps (unbounded memory per key), while a fixed window is
// two numbers per key. The known cost is burstiness at a window edge — up to twice
// the limit across two adjacent windows — which is irrelevant at limits chosen to
// sit far above legitimate use.
//
// `now` is a parameter, never read from the clock inside: the same reason every
// other time-dependent decision in this codebase takes it (queries.ts, digest.ts)
// — it makes the policy testable without waiting a minute for a window to roll.
export function createRateLimiter(opts: { limit: number; windowMs?: number; maxKeys?: number }): RateLimiter {
	const limit = opts.limit;
	const windowMs = opts.windowMs ?? RATE_WINDOW_MS;
	const maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
	const windows = new Map<string, { start: number; count: number }>();

	function dropExpired(now: number): void {
		for (const [key, window] of windows) {
			if (now - window.start >= windowMs) windows.delete(key);
		}
	}

	return {
		check(key: string, now: number): RateDecision {
			let bucket = windows.get(key);
			// A key we have never seen, with the map full: reclaim what has expired,
			// and if it is still full, count this caller against the shared overflow
			// bucket rather than growing without bound. Degrading into a shared bucket
			// is the conservative direction — it can throttle sooner than the per-key
			// limit would, never later.
			if (bucket === undefined && windows.size >= maxKeys) {
				dropExpired(now);
				if (windows.size >= maxKeys) {
					key = OVERFLOW_KEY;
					bucket = windows.get(key);
				}
			}
			if (bucket === undefined || now - bucket.start >= windowMs) {
				bucket = { start: now, count: 0 };
				windows.set(key, bucket);
			}
			if (bucket.count >= limit) {
				const remainingMs = bucket.start + windowMs - now;
				return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)) };
			}
			bucket.count++;
			return { allowed: true, retryAfterSeconds: 0 };
		},
		size(): number {
			return windows.size;
		},
	};
}
