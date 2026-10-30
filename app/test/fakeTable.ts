import type { PurgeableTable, SearchQuery } from '../src/retention/retention.ts';

type FakeCondition = SearchQuery['conditions'][number] | FakeQuery;
interface FakeQuery extends Omit<SearchQuery, 'conditions'> {
	conditions: FakeCondition[];
}
interface FakeSort {
	attribute: string;
	descending?: boolean;
	next?: FakeSort;
}

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

	// Ordering comparators hold for two numbers or two strings (Harper orders strings by code unit).
	private static ordered(value: unknown, target: unknown): value is number | string {
		return (typeof value === 'number' || typeof value === 'string') && typeof value === typeof target;
	}

	private static compare(value: unknown, comparator: string | undefined, target: unknown): boolean {
		switch (comparator) {
			case undefined:
			case 'equals':
				return value === target;
			case 'less_than':
				return FakeTable.ordered(value, target) && FakeTable.order(value, target) < 0;
			case 'less_than_equal':
				return FakeTable.ordered(value, target) && FakeTable.order(value, target) <= 0;
			case 'greater_than':
				return FakeTable.ordered(value, target) && FakeTable.order(value, target) > 0;
			case 'greater_than_equal':
				return FakeTable.ordered(value, target) && FakeTable.order(value, target) >= 0;
			case 'starts_with':
				return typeof value === 'string' && value.startsWith(String(target));
			default:
				return false;
		}
	}

	private static matches(row: Record<string, unknown>, query: FakeQuery): boolean {
		const results = query.conditions.map((c) =>
			'conditions' in c ? FakeTable.matches(row, c) : FakeTable.compare(row[c.attribute], c.comparator, c.value),
		);
		return query.operator === 'or' ? results.some(Boolean) : results.every(Boolean);
	}

	// Harper REFUSES these queries (resources/Table.ts, prepareConditions) rather
	// than treating them as degenerate cases, so the fake must refuse them too.
	// Accepting them made a real production defect invisible: hydrateSkus passed a
	// single condition with `operator: 'or'`, which every event-detail request does,
	// and this fake answered it happily while the live instance 500'd every time.
	// A fake that is more permissive than the thing it stands in for does not
	// simplify a test — it hides the contract.
	private static validate(query: FakeQuery): void {
		const count = query.conditions?.length ?? 0;
		if (query.operator === 'or') {
			if (count < 2) throw new Error('An "or" operator requires at least two conditions');
		} else if (query.operator === undefined || query.operator === 'and') {
			if (count < 1) throw new Error('An "and" operator requires at least one condition');
		} else {
			throw new Error('Invalid operator ' + query.operator);
		}
		for (const c of query.conditions) if ('conditions' in c) FakeTable.validate(c);
	}

	private static order(a: unknown, b: unknown): number {
		if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
		return Number(a) - Number(b);
	}

	// Harper's read snapshot expires after maxTransactionOpenTime (30 s), and an iterator opened before
	// that throws when next advanced. expireSnapshots() stands in for the clock passing that limit.
	private snapshotEpoch = 0;
	expireSnapshots(): void {
		this.snapshotEpoch++;
	}

	async *search(query: FakeQuery & { sort?: FakeSort; offset?: number }): AsyncIterable<Record<string, unknown>> {
		FakeTable.validate(query);
		const openedAt = this.snapshotEpoch;
		let matched = [...this.rows.values()].filter((row) => FakeTable.matches(row, query));
		const sort = query.sort;
		if (sort) {
			matched = matched.sort((a, b) => {
				for (let s: FakeSort | undefined = sort; s; s = s.next) {
					const cmp = FakeTable.order(a[s.attribute], b[s.attribute]);
					if (cmp !== 0) return s.descending ? -cmp : cmp;
				}
				return 0;
			});
		}
		matched = matched.slice(query.offset ?? 0);
		const limit = query.limit ?? Number.POSITIVE_INFINITY;
		let yielded = 0;
		for (const row of matched) {
			if (this.snapshotEpoch !== openedAt) throw new Error('ReadSnapshotExpiredError: the read snapshot exceeded maxTransactionOpenTime');
			if (yielded >= limit) break;
			yielded++;
			yield row;
		}
	}

	async get(id: string): Promise<Record<string, unknown> | null> {
		const row = this.rows.get(id);
		return row ? { ...row } : null;
	}

	// A miss is `null`, as in Harper (a `=== undefined` check never sees it).
	// Upsert by the configured key field. Stores a copy so a caller mutating its
	// input afterwards cannot change persisted state (Harper serializes on write).
	async put(record: Record<string, unknown>): Promise<void> {
		this.rows.set(String(record[this.keyField]), { ...record });
	}

	// Shallow merge into an existing row. On a missing key Harper 5.3.3 creates a row
	// holding only the patched fields (probed live), so the fake does too.
	async patch(id: string, partial: Record<string, unknown>): Promise<void> {
		this.rows.set(id, { ...this.rows.get(id), ...partial });
	}

	async delete(id: string): Promise<void> {
		this.rows.delete(id);
	}
}
