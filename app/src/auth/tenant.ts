import type { Principal } from './principal.ts';

// The tenant-isolation control (threat model §4): every query is scoped to the
// verified principal's shop and any caller-supplied shopId is overridden. All
// merchant data reads must go through a filter built here.
export function scopedFilter<T extends Record<string, unknown>>(principal: Principal, filters?: T): T & { shopId: string } {
	return { ...(filters ?? ({} as T)), shopId: principal.shopId };
}
