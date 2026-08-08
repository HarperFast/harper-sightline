import type { PurgeableTable, SearchQuery } from '../src/retention.ts';

// In-memory table for time-controlled tests. Implements the search/delete/get
// surface used by retention, redaction, and the read layer. Supports the
// comparators and (and/or) operators, sort, and limit those modules use. Not
// test-run itself (filename lacks `.test`).
export class FakeTable implements PurgeableTable {
	readonly rows = new Map<string, Record<string, unknown>>();
	private readonly keyField: string;
	constructor(keyField: string, records: Record<string, unknown>[] = []) {
		this.keyField = keyField;
		for (const record of records) this.rows.set(String(record[keyField]), { ...record });
	}

	private static compare(value: unknown, comparator: string | undefined, target: unknown): boolean {
		switch (comparator) {
			case undefined:
			case 'equals':
				return value === target;
			case 'less_than':
				return typeof value === 'number' && value < (target as number);
			case 'less_than_equal':
				return typeof value === 'number' && value <= (target as number);
			case 'greater_than':
				return typeof value === 'number' && value > (target as number);
			case 'greater_than_equal':
				return typeof value === 'number' && value >= (target as number);
			case 'starts_with':
				return typeof value === 'string' && value.startsWith(String(target));
			default:
				return false;
		}
	}

	private static matches(row: Record<string, unknown>, query: SearchQuery): boolean {
		const results = query.conditions.map((c) => FakeTable.compare(row[c.attribute], c.comparator, c.value));
		return query.operator === 'or' ? results.some(Boolean) : results.every(Boolean);
	}

	async *search(query: SearchQuery & { sort?: { attribute: string; descending?: boolean } }): AsyncIterable<Record<string, unknown>> {
		let matched = [...this.rows.values()].filter((row) => FakeTable.matches(row, query));
		const sort = query.sort;
		if (sort) {
			matched = matched.sort((a, b) => {
				const av = Number(a[sort.attribute]);
				const bv = Number(b[sort.attribute]);
				return sort.descending ? bv - av : av - bv;
			});
		}
		const limit = query.limit ?? Number.POSITIVE_INFINITY;
		let yielded = 0;
		for (const row of matched) {
			if (yielded >= limit) break;
			yielded++;
			yield row;
		}
	}

	async get(id: string): Promise<Record<string, unknown> | undefined> {
		const row = this.rows.get(id);
		return row ? { ...row } : undefined;
	}

	// Upsert by the configured key field. Stores a copy so a caller mutating its
	// input afterwards cannot change persisted state (Harper serializes on write).
	async put(record: Record<string, unknown>): Promise<void> {
		this.rows.set(String(record[this.keyField]), { ...record });
	}

	// Shallow merge into an existing row. A missing row is a no-op, matching how
	// the production call sites treat patch (they only patch rows they just read).
	async patch(id: string, partial: Record<string, unknown>): Promise<void> {
		const row = this.rows.get(id);
		if (row) this.rows.set(id, { ...row, ...partial });
	}

	async delete(id: string): Promise<void> {
		this.rows.delete(id);
	}
}
