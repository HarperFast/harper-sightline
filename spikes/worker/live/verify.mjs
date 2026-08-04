import { ops, DB, INBOX, RESULT } from './common.mjs';

const inbox = await ops.sql(`SELECT id FROM ${DB}.${INBOX}`);
const results = await ops.sql(`SELECT id FROM ${DB}.${RESULT}`);
const inboxIds = (inbox || []).map((r) => String(r.id));
const resultIds = (results || []).map((r) => String(r.id));
const resultSet = new Set(resultIds);

const missing = inboxIds.filter((id) => !resultSet.has(id));
const duplicates = resultIds.length - resultSet.size; // PK forbids dupes; expect 0
const ok = missing.length === 0 && duplicates === 0 && resultSet.size === inboxIds.length;

console.log(
	`inbox=${inboxIds.length} results=${resultIds.length} unique=${resultSet.size} missing=${missing.length} duplicates=${duplicates}`,
);

if (process.env.KEEP !== '1') {
	for (const t of [INBOX, RESULT]) await ops.dropTable(DB, t).catch(() => {});
	console.log('dropped tables');
}
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
