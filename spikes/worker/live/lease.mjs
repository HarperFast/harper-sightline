import { ops, DB, LEASE, sleep } from './common.mjs';

const KEY = 'worker';

// fresh
await ops.dropTable(DB, LEASE).catch(() => {});
await sleep(800);
await ops.createTable(DB, LEASE, 'id');
await sleep(1500);

async function tryAcquire(holder, ttlMs) {
	const now = Date.now();
	const rows = await ops.sql(`SELECT id, holder, expiresAt FROM ${DB}.${LEASE} WHERE id = '${KEY}'`);
	const cur = (rows && rows[0]) || null;
	if (cur && now < Number(cur.expiresAt)) return false; // held and still valid
	if (cur) {
		// expired holder: remove the stale row so a fresh claim can win
		await ops.op({ operation: 'delete', database: DB, table: LEASE, ids: [KEY] }).catch(() => {});
	}
	const res = await ops.insert(DB, LEASE, [{ id: KEY, holder, expiresAt: now + ttlMs }]);
	return ((res && res.inserted_hashes) || []).map(String).includes(KEY);
}

// 1. two concurrent acquirers on a free lease -> exactly one winner
const [a, b] = await Promise.all([tryAcquire('A', 3000), tryAcquire('B', 3000)]);
console.log(`free-lease contention:  A=${a} B=${b}   (expect exactly one true)`);

// 2. while held and valid, a third is blocked
const c = await tryAcquire('C', 3000);
console.log(`held lease blocks:      C=${c}   (expect false)`);

// 3. after TTL expiry, takeover succeeds
await sleep(3200);
const d = await tryAcquire('D', 3000);
console.log(`post-expiry takeover:   D=${d}   (expect true)`);

await ops.dropTable(DB, LEASE).catch(() => {});
const pass = [a, b].filter(Boolean).length === 1 && c === false && d === true;
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
