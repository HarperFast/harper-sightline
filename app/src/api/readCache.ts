// Per-shop single-flight cache for the reads that scan every row a shop holds in the
// window: summary, flows and the privacy footprint (src/api/queries.ts), each of which
// takes seconds on a big shop (DESIGN.md, Measured costs). Concurrent requests for one
// shop share one scan, and a finished scan answers that shop for READ_CACHE_TTL_MS.
//
// Keyed by shopId only, and each endpoint owns its own cache instance, so a key can never
// name another shop's or another endpoint's result. Errors are not cached: every caller
// that joined a failed scan sees the error, and the next request scans again.
//
// The cache lives in one worker thread's memory, so each thread (and each node) scans
// on its own. That is acceptable: the bound is one scan per shop per TTL per thread,
// not one per request, and nothing here has to agree across threads.

// Short enough that a count is never more than a moment behind, long enough that a
// burst of Overview loads becomes one scan. The SPA's own summary cache is 15 s.
export const READ_CACHE_TTL_MS = 20_000;

// Shops held per cache. A summary is about 1.5 KB, so this is a few MB at most.
export const READ_CACHE_MAX_SHOPS = 1000;

export interface ReadCache<T> {
	get(shopId: string, compute: () => Promise<T>): Promise<T>;
	size(): number;
}

interface Entry<T> {
	value: Promise<T>;
	// Unset while the scan is in flight; the TTL runs from completion, so a scan slower
	// than the TTL is still reused.
	expiresAt?: number;
}

export function createReadCache<T>(opts: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}): ReadCache<T> {
	const ttlMs = opts.ttlMs ?? READ_CACHE_TTL_MS;
	const maxEntries = opts.maxEntries ?? READ_CACHE_MAX_SHOPS;
	const now = opts.now ?? Date.now;
	const entries = new Map<string, Entry<T>>();

	function makeRoom(at: number): void {
		for (const [key, entry] of entries) {
			if (entry.expiresAt !== undefined && entry.expiresAt <= at) entries.delete(key);
		}
		// Oldest first (Map insertion order). An evicted flight still answers the callers
		// already holding its promise; it is just not shared any further.
		for (const key of entries.keys()) {
			if (entries.size < maxEntries) break;
			entries.delete(key);
		}
	}

	return {
		get(shopId: string, compute: () => Promise<T>): Promise<T> {
			const at = now();
			const hit = entries.get(shopId);
			if (hit && (hit.expiresAt === undefined || at < hit.expiresAt)) return hit.value;
			entries.delete(shopId);
			if (entries.size >= maxEntries) makeRoom(at);
			// Through a promise so a synchronous throw rejects rather than escaping get().
			const entry: Entry<T> = { value: Promise.resolve().then(compute) };
			entries.set(shopId, entry);
			// Only the entry still in the map may change it: an evicted or replaced flight
			// must not re-insert itself or delete its successor.
			entry.value.then(
				() => {
					if (entries.get(shopId) === entry) entry.expiresAt = now() + ttlMs;
				},
				() => {
					if (entries.get(shopId) === entry) entries.delete(shopId);
				},
			);
			return entry.value;
		},
		size(): number {
			return entries.size;
		},
	};
}
