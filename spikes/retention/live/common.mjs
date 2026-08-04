import { purgeSql, cutoffMs } from '../src/retention.ts';

export { purgeSql, cutoffMs };
export const DB = 'data';
export const T = 'spikec_ledger';

const { HARPER_OPS_URL, HARPER_USER, HARPER_PASS } = process.env;
if (!HARPER_OPS_URL || !HARPER_USER || !HARPER_PASS) {
	console.error('set HARPER_OPS_URL, HARPER_USER, HARPER_PASS');
	process.exit(2);
}
const auth = 'Basic ' + Buffer.from(`${HARPER_USER}:${HARPER_PASS}`).toString('base64');

export async function op(body) {
	const r = await fetch(HARPER_OPS_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: auth },
		body: JSON.stringify(body),
	});
	const t = await r.text();
	let j = t;
	try {
		j = JSON.parse(t);
	} catch {
		// raw
	}
	if (!r.ok) throw new Error(`${body.operation} ${r.status} ${t.slice(0, 150)}`);
	return j;
}
export const sql = (s) => op({ operation: 'sql', sql: s });
export const insert = (recs) => op({ operation: 'insert', database: DB, table: T, records: recs });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function recreate() {
	await op({ operation: 'drop_table', database: DB, table: T }).catch(() => {});
	await sleep(1000);
	await op({ operation: 'create_table', database: DB, table: T, primary_key: 'id' });
	await sleep(2000);
}
export async function count(where = '') {
	const rows = await sql(`SELECT COUNT(*) AS c FROM ${DB}.${T}${where ? ` WHERE ${where}` : ''}`);
	return Number((rows && rows[0] && rows[0].c) || 0);
}
