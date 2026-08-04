// Exactly-once inbox processing. Correctness rests on `claimResult` being an
// atomic single-winner operation (backed live by a unique primary-key insert
// into the `result` table — see Spike A's atomic-claim finding). Because each
// item is claimed atomically, processing is exactly-once regardless of how many
// workers or cluster nodes run this concurrently, and a restart simply
// reprocesses whatever has no result yet.

export type Store = {
	listUnprocessed(): Promise<string[]>;
	claimResult(id: string, by: string): Promise<boolean>;
};

export async function processInbox(
	by: string,
	store: Store,
): Promise<{ processed: string[]; skipped: string[] }> {
	const processed: string[] = [];
	const skipped: string[] = [];
	for (const id of await store.listUnprocessed()) {
		const won = await store.claimResult(id, by);
		if (won) processed.push(id);
		else skipped.push(id);
	}
	return { processed, skipped };
}
