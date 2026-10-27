export const DETECTOR_SWEEP_PAGE = 200;

export interface DetectorSweepQuery {
	conditions: Array<{ attribute: string; value: unknown; comparator?: string }>;
	operator?: 'and' | 'or';
	sort?: { attribute: string; descending?: boolean };
	select?: string[];
	limit?: number;
	offset?: number;
}

export interface DetectorSweepDeps {
	expectations: {
		search(query: DetectorSweepQuery): AsyncIterable<Record<string, unknown>>;
		get(id: string): Promise<Record<string, unknown> | undefined>;
	};
	evaluate(shopId: string, orderId: string): Promise<void>;
}

// Expires pending expectations whose deadline has passed. Reads only the due rows,
// oldest deadline first, one bounded page at a time. An evaluated expectation
// normally leaves the pending set; one that stays pending (its order has no
// projection yet) keeps its place in the sort, so the next page's offset skips
// exactly those and the sweep always terminates.
export async function runDetectorSweep(deps: DetectorSweepDeps, now: number): Promise<number> {
	let due = 0;
	let stillPending = 0;
	for (;;) {
		const page: Array<Record<string, unknown>> = [];
		for await (const row of deps.expectations.search({
			conditions: [
				{ attribute: 'state', value: 'pending' },
				{ attribute: 'deadline', value: now, comparator: 'less_than_equal' },
			],
			operator: 'and',
			sort: { attribute: 'deadline' },
			select: ['id', 'shopId', 'orderId'],
			limit: DETECTOR_SWEEP_PAGE,
			offset: stillPending,
		})) {
			page.push(row);
		}
		if (page.length === 0) return due;
		for (const exp of page) {
			await deps.evaluate(String(exp.shopId), String(exp.orderId));
			due += 1;
			const after = await deps.expectations.get(String(exp.id));
			if (after?.state === 'pending') stillPending += 1;
		}
		if (page.length < DETECTOR_SWEEP_PAGE) return due;
	}
}
