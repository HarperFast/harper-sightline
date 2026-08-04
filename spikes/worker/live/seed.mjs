import { ops, DB, INBOX, RESULT, sleep } from './common.mjs';

for (const t of [INBOX, RESULT]) await ops.dropTable(DB, t).catch(() => {});
await sleep(1000);
for (const t of [INBOX, RESULT]) await ops.createTable(DB, t, 'id');
await sleep(2000);

const N = Number(process.env.N ?? 50);
await ops.insert(
	DB,
	INBOX,
	Array.from({ length: N }, (_, i) => ({ id: `d-${i}`, payload: `p${i}`, receivedAt: Date.now() })),
);
console.log(`seeded ${N} accepted deliveries into ${DB}.${INBOX}`);
