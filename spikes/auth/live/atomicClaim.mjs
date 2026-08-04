// Live proof (Task 6): Harper's unique primary-key insert is an atomic
// compare-and-claim primitive — exactly one of N concurrent inserts of the
// same key wins. This backs atomic credential rotation: a rotator claims
// (shopId, nextVersion) via insert; the single winner performs the Shopify
// token exchange and writes the credential; losers back off and re-read.
//
// Usage (creds from env; nothing secret is committed):
//   HARPER_OPS_URL=https://<host>:9925/ HARPER_USER=... HARPER_PASS=... \
//   NODE_TLS_REJECT_UNAUTHORIZED=0 node spikes/auth/live/atomicClaim.mjs
//
// Observed 2026-08-04 against ayoo.josh-test.harperfabric.com (Harper 5.2.0):
//   concurrent inserts N=12:  inserted(won)=1  skipped(lost)=11  other=0  rowCount=1

const OPS = process.env.HARPER_OPS_URL;
const USER = process.env.HARPER_USER;
const PASS = process.env.HARPER_PASS;
if (!OPS || !USER || !PASS) {
	console.error('set HARPER_OPS_URL, HARPER_USER, HARPER_PASS');
	process.exit(2);
}
const auth = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
const op = (b) =>
	fetch(OPS, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: auth },
		body: JSON.stringify(b),
	}).then(async (r) => ({ s: r.status, j: await r.json().catch(() => null) }));

const N = 12;
console.log('create_table:', (await op({ operation: 'create_table', database: 'data', table: 'spike_claim', primary_key: 'id' })).j?.message);
await new Promise((r) => setTimeout(r, 1500));

const results = await Promise.all(
	Array.from({ length: N }, () => op({ operation: 'insert', database: 'data', table: 'spike_claim', records: [{ id: 'lease-1' }] })),
);
let won = 0, lost = 0, other = 0;
for (const r of results) {
	const j = r.j ?? {};
	if ((j.inserted_hashes ?? []).length) won++;
	else if ((j.skipped_hashes ?? []).length) lost++;
	else other++;
}
const count = (await op({ operation: 'sql', sql: 'SELECT COUNT(*) AS c FROM data.spike_claim' })).j;
console.log(`concurrent inserts N=${N}:  won=${won}  lost=${lost}  other=${other}  rowCount=${JSON.stringify(count)}`);
console.log('drop_table:', (await op({ operation: 'drop_table', database: 'data', table: 'spike_claim' })).j?.message);

if (won !== 1 || other !== 0) {
	console.error('FAIL: expected exactly one winner and no errors');
	process.exit(1);
}
console.log('PASS: atomic single-winner claim confirmed');
