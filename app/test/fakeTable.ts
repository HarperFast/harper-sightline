import type { PurgeableTable, SearchQuery } from '../src/retention.ts';

// In-memory PurgeableTable for time-controlled purge/redaction tests. Supports
// the `less_than` and `equals` comparators and `and`/`or` operators the modules
// use. Not test-run itself (filename lacks `.test`).
export class FakeTable implements PurgeableTable {
	readonly rows = new Map<string, Record<string, unknown>>();
	private readonly keyField: string;
	constructor(keyField: string, records: Record<string, unknown>[] = []) {
		this.keyField = keyField;
		for (const record of records) this.rows.set(String(record[keyField]), { ...record });
	}

	private static matches(row: Record<string, unknown>, query: SearchQuery): boolean {
		const results = query.conditions.map((c) => {
			const value = row[c.attribute];
			switch (c.comparator) {
				case 'less_than':
					return typeof value === 'number' && value < (c.value as number);
				case 'equals':
					return value === c.value;
				default:
					return false;
			}
		});
		return query.operator === 'or' ? results.some(Boolean) : results.every(Boolean);
	}

	async *search(query: SearchQuery): AsyncIterable<Record<string, unknown>> {
		let yielded = 0;
		const limit = query.limit ?? Number.POSITIVE_INFINITY;
		for (const row of this.rows.values()) {
			if (yielded >= limit) break;
			if (FakeTable.matches(row, query)) {
				yielded++;
				yield row;
			}
		}
	}

	async delete(id: string): Promise<void> {
		this.rows.delete(id);
	}
}
