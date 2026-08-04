// Characterize Harper expiration/eviction on a source-less @table with a
// secondary index. Deploys spikec-ttl (pass the tar path as argv[2]), restarts,
// inserts, and probes at staged intervals. Every op tolerates the transient
// network drop a Harper restart causes.
import { readFileSync } from 'node:fs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED ??= '0';
const { HARPER_OPS_URL, HARPER_USER, HARPER_PASS } = process.env;
if (!HARPER_OPS_URL || !HARPER_USER || !HARPER_PASS) {
	console.error('set HARPER_OPS_URL, HARPER_USER, HARPER_PASS');
	process.exit(2);
}
const auth = 'Basic ' + Buffer.from(`${HARPER_USER}:${HARPER_PASS}`).toString('base64');
const rawOp = (b) =>
	fetch(HARPER_OPS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: JSON.stringify(b) }).then(
		async (r) => {
			const t = await r.text();
			try {
				return JSON.parse(t);
			} catch {
				return t;
			}
		},
	);
const op = async (b) => {
	try {
		return await rawOp(b);
	} catch (e) {
		return { __err: e.message };
	}
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tar = process.argv[2];

if (tar) {
	console.log('deploy:', (await op({ operation: 'deploy_component', project: 'spikec-ttl', payload: readFileSync(tar).toString('base64') })).message);
	console.log('restart:', (await op({ operation: 'restart' })).message ?? 'ok');
}
for (let i = 0; i < 20; i++) {
	await sleep(3000);
	const gc = JSON.stringify(await op({ operation: 'get_components' }));
	if (/"spikec-ttl"[\s\S]*?"status":"healthy"/.test(gc)) {
		console.log(`healthy ~${(i + 1) * 3}s`);
		break;
	}
}

const da = await op({ operation: 'describe_all' });
let db = null;
let table = null;
for (const [dbn, tables] of Object.entries(da || {})) {
	if (dbn === '__err') continue;
	for (const tn of Object.keys(tables || {})) if (tn.toLowerCase() === 'spikecttl') {
		db = dbn;
		table = tn;
	}
}
console.log('table at:', db ? `${db}.${table}` : 'NOT FOUND');
if (!db) {
	await op({ operation: 'drop_component', project: 'spikec-ttl' });
	process.exit(1);
}

const now = Date.now();
const ins = await op({ operation: 'insert', database: db, table, records: Array.from({ length: 5 }, (_, i) => ({ id: `t-${i}`, shopId: 's1' })) });
console.log('insert:', ins.inserted_hashes ? `inserted ${ins.inserted_hashes.length}` : JSON.stringify(ins).slice(0, 160));

async function probe(label) {
	const byId = await op({ operation: 'sql', sql: `SELECT id FROM ${db}.${table} WHERE id = 't-0'` });
	const byAttr = await op({ operation: 'sql', sql: `SELECT id FROM ${db}.${table} WHERE shopId = 's1'` });
	const cnt = await op({ operation: 'sql', sql: `SELECT COUNT(*) AS c FROM ${db}.${table}` });
	const total = Array.isArray(cnt) && cnt[0] ? cnt[0].c : JSON.stringify(cnt);
	console.log(`${label}: byId=${Array.isArray(byId) ? byId.length : JSON.stringify(byId)} byIndex=${Array.isArray(byAttr) ? byAttr.length : JSON.stringify(byAttr)} total=${total}`);
}
await probe('t=0s ');
await sleep(3000);
await probe('t=3s ');
await sleep(5000);
await probe('t=8s ');
await sleep(6000);
await probe('t=14s');

console.log('drop_component:', (await op({ operation: 'drop_component', project: 'spikec-ttl' })).message);
