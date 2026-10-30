// Per-caller request limiting for the read API, mainly to bound `/api/v1/export`
// (up to MAX_EXPORT_ROWS per call). Counters live in worker-thread memory, so the
// effective bound is the limit x worker threads x nodes: soft abuse dampers, not
// quotas, and not a security boundary (tenant isolation does not depend on them).
// Volumetric attack is the edge's job (threat model §3.3).

// 60s, so a limit reads as "per minute".
export const RATE_WINDOW_MS = 60_000;

// Per verified shop across all reads. It bounds scripted reuse of a token and stays
// well above a person's use: a screen costs 1-4 requests and the SPA does not poll.
// Counters are per worker thread, so the effective ceiling is higher. A non-zero
// `rate_limit.requests` metric in normal use means this is too low.
export const API_REQUESTS_PER_MINUTE = 200;

// Per verified shop for CSV export, whose cost is not proportional to the request:
// each call pages until MAX_EXPORT_ROWS.
export const EXPORTS_PER_MINUTE = 10;

// Keeps the limiter itself from becoming a memory-exhaustion bug.
const DEFAULT_MAX_KEYS = 4096;

// Excess keys collapse here once the map is full; no shop domain can equal it.
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
	retryAfterSeconds: number;
}

export interface RateLimiter {
	check(key: string, now: number): RateDecision;
	size(): number;
}

// Fixed window: a sliding window needs per-request timestamps. The cost is up to
// twice the limit across a window edge, irrelevant at limits far above real use.
// `now` is a parameter so the policy is testable without waiting a minute.
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
			// A new key with the map full: reclaim expired entries, else count against the
			// shared overflow bucket (conservative: it can throttle sooner, never later).
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
