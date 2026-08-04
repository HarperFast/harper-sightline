import { ops, store, sleep, DB, INBOX, RESULT } from './common.mjs';
import { processInbox } from '../src/processInbox.ts';

// fresh seed
for (const t of [INBOX, RESULT]) await ops.dropTable(DB, t).catch(() => {});
await sleep(1000);
for (const t of [INBOX, RESULT]) await ops.createTable(DB, t, 'id');
await sleep(2000);
const N = Number(process.env.N ?? 60);
await ops.insert(
	DB,
	INBOX,
	Array.from({ length: N }, (_, i) => ({ id: `d-${i}`, payload: `p${i}`, receivedAt: Date.now() })),
);

// K workers race over the same inbox at maximum contention
const K = Number(process.env.K ?? 4);
const passes = await Promise.all(Array.from({ length: K }, (_, i) => processInbox(`w${i}`, store())));
const counts = passes.map((r, i) => `w${i}=${r.processed.length}`).join(' ');
const total = passes.reduce((a, r) => a + r.processed.length, 0);
console.log(`N=${N} K=${K}  winners: ${counts}  total_processed=${total}  (expect total==N, each id exactly one winner)`);
