// Single-active scheduling lease. Correctness of processing does NOT depend on
// this (per-item atomic claim already guarantees exactly-once); the lease only
// stops N workers from all polling at once, and lets a crashed holder be
// superseded after its TTL. Live-backed by an atomic single-winner insert on a
// fixed key.

export type LeaseRecord = { holder: string; expiresAt: number };

// Pure: may a claimer take the lease at time `now`, given the current record?
export function canTake(current: LeaseRecord | null, now: number): boolean {
	return current === null || now >= current.expiresAt;
}

export function leaseFor(holder: string, now: number, ttlMs: number): LeaseRecord {
	return { holder, expiresAt: now + ttlMs };
}
