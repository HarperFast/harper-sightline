import type { Principal } from './principal.ts';

// The load-bearing tenant-isolation control (threat model §4, dev plan §8):
// every query is scoped to the verified principal's shop. Any caller-supplied
// shopId is OVERRIDDEN — tenant identity is never taken from input. All
// merchant data reads must go through a filter built here.
export function scopedFilter<T extends Record<string, unknown>>(principal: Principal, filters?: T): T & { shopId: string } {
	return { ...(filters ?? ({} as T)), shopId: principal.shopId };
}
