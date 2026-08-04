import { DB, T, op, insert, sql, count, recreate } from './common.mjs';

await recreate();
const rows = [];
for (const s of ['s1', 's2']) for (let i = 0; i < 8; i++) rows.push({ id: `${s}-${i}`, shopId: s, receivedAt: Date.now() - i });
await insert(rows);
console.log(`before: total=${await count()} s1=${await count("shopId='s1'")} s2=${await count("shopId='s2'")}`);

const del = `DELETE FROM ${DB}.${T} WHERE shopId = 's1'`;

// targeted redaction of one tenant
await sql(del);
await new Promise((r) => setTimeout(r, 800));
const total = await count();
const s1 = await count("shopId='s1'");
const s2 = await count("shopId='s2'");
const g = await sql(`SELECT id FROM ${DB}.${T} WHERE id = 's1-0'`);
const s1gone = !(Array.isArray(g) && g.length > 0);
console.log(`after redact s1: total=${total} s1=${s1} s2=${s2} s1-0 gone=${s1gone}`);

// idempotent re-run (customers/redact retries must be safe)
await sql(del);
await new Promise((r) => setTimeout(r, 500));
const s1b = await count("shopId='s1'");
const s2b = await count("shopId='s2'");
console.log(`re-run (idempotent): s1=${s1b} s2=${s2b}`);

const pass = s1 === 0 && s2 === 8 && total === 8 && s1gone && s1b === 0 && s2b === 8;
await op({ operation: 'drop_table', database: DB, table: T }).catch(() => {});
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
