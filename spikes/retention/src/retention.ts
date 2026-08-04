const DAY_MS = 86_400_000;

export function cutoffMs(nowMs: number, retentionDays: number): number {
	return nowMs - retentionDays * DAY_MS;
}

export function isExpired(receivedAt: number, nowMs: number, retentionDays: number): boolean {
	return receivedAt < cutoffMs(nowMs, retentionDays);
}

// Explicit purge: a real DELETE removes both record data and secondary-index
// entries (unlike TTL eviction, which leaves index residue). This is the
// compliance-safe retention mechanism.
export function purgeSql(db: string, table: string, tsField: string, cutoff: number): string {
	return `DELETE FROM ${db}.${table} WHERE ${tsField} < ${cutoff}`;
}
