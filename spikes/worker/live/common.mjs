import { makeOps } from '../src/harperOps.ts';

export const DB = 'data';
export const INBOX = 'spikeb_inbox';
export const RESULT = 'spikeb_result';
export const LEASE = 'spikeb_lease';

const { HARPER_OPS_URL, HARPER_USER, HARPER_PASS } = process.env;
if (!HARPER_OPS_URL || !HARPER_USER || !HARPER_PASS) {
	console.error('set HARPER_OPS_URL, HARPER_USER, HARPER_PASS');
	process.exit(2);
}

export const ops = makeOps({ url: HARPER_OPS_URL, user: HARPER_USER, pass: HARPER_PASS });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Harper-backed Store (matches src/processInbox.ts Store interface).
export function store() {
	return {
		async listUnprocessed() {
			const inbox = await ops.sql(`SELECT id FROM ${DB}.${INBOX}`);
			const results = await ops.sql(`SELECT id FROM ${DB}.${RESULT}`);
			const done = new Set((results || []).map((r) => String(r.id)));
			return (inbox || []).map((r) => String(r.id)).filter((id) => !done.has(id));
		},
		async claimResult(id, by) {
			const res = await ops.insert(DB, RESULT, [{ id, processedBy: by, processedAt: Date.now() }]);
			return ((res && res.inserted_hashes) || []).map(String).includes(String(id));
		},
	};
}
