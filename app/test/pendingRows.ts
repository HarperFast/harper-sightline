import { pendingKey, type DeliveryRow, type PendingRow } from '../src/ingest/processor.ts';

// What a read of the pendingKey index returns: accepted rows keyed after `after`, in
// key order, up to `limit`.
export function listPendingIn(rows: Iterable<DeliveryRow>, after: string, limit: number): PendingRow[] {
	const out: PendingRow[] = [];
	for (const row of rows) {
		if (row.status !== 'accepted') continue;
		const key = pendingKey(row);
		if (key > after) out.push({ ...row, pendingKey: key });
	}
	out.sort((a, b) => (a.pendingKey < b.pendingKey ? -1 : a.pendingKey > b.pendingKey ? 1 : 0));
	return out.slice(0, limit);
}
