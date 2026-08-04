import { DB, T, op, insert, sql, count, recreate, purgeSql, cutoffMs } from './common.mjs';

const now = Date.now();
const cutoff = cutoffMs(now, 7); // 7-day window

await recreate();
const old = Array.from({ length: 10 }, (_, i) => ({ id: `old-${i}`, shopId: 's1', receivedAt: cutoff - 3_600_000 - i }));
const recent = Array.from({ length: 10 }, (_, i) => ({ id: `new-${i}`, shopId: 's1', receivedAt: now - i }));
await insert([...old, ...recent]);

const g0 = await sql(`SELECT id FROM ${DB}.${T} WHERE id = 'old-0'`);
console.log(`before purge: total=${await count()} viaAttrQuery(s1)=${await count("shopId='s1'")} old-0 present=${Array.isArray(g0) && g0.length > 0}`);

await sql(purgeSql(DB, T, 'receivedAt', cutoff));
await new Promise((r) => setTimeout(r, 1000));

const total = await count();
const oldLeft = await count(`receivedAt < ${cutoff}`);
const viaQ = await count("shopId='s1'");
const g1 = await sql(`SELECT id FROM ${DB}.${T} WHERE id = 'old-0'`);
const oldGone = !(Array.isArray(g1) && g1.length > 0);
console.log(`after purge:  total=${total} oldRemaining=${oldLeft} viaAttrQuery(s1)=${viaQ} old-0 gone=${oldGone}`);

const pass = total === 10 && oldLeft === 0 && viaQ === 10 && oldGone;
await op({ operation: 'drop_table', database: DB, table: T }).catch(() => {});
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
