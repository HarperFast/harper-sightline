// Deploy the Sightline component to a Harper instance via the operations API,
// then restart and wait for it to load. Creds from env; nothing secret committed.
//   HARPER_OPS_URL=https://<host>:9925/ HARPER_USER=... HARPER_PASS=... \
//   node scripts/deploy.mjs
// TLS is verified. Only a host with a self-signed certificate needs an explicit
// NODE_TLS_REJECT_UNAUTHORIZED=0 on the command line.
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectedColumns, indexedColumns } from './schemaColumns.mjs';

const { HARPER_OPS_URL, HARPER_USER, HARPER_PASS } = process.env;
if (!HARPER_OPS_URL || !HARPER_USER || !HARPER_PASS) {
	console.error('set HARPER_OPS_URL, HARPER_USER, HARPER_PASS');
	process.exit(2);
}
const auth = 'Basic ' + Buffer.from(`${HARPER_USER}:${HARPER_PASS}`).toString('base64');
// `url` defaults to the configured ops endpoint; a Fabric cluster has several nodes
// and each must be addressed individually (see below).
const opAt = async (url, b) => {
	try {
		const r = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: auth },
			body: JSON.stringify(b),
		});
		const t = await r.text();
		try {
			return JSON.parse(t);
		} catch {
			return t;
		}
	} catch (e) {
		return { __err: e.message };
	}
};
const op = (b) => opAt(HARPER_OPS_URL, b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const appDir = fileURLToPath(new URL('..', import.meta.url));
const files = ['config.yaml', 'schema.graphql', 'resources.ts', 'jobs.ts', 'src', 'package.json'];
if (existsSync(join(appDir, 'web/dist/index.html'))) files.push('web/dist');
const tarPath = join(tmpdir(), 'sightline-deploy.tar');
execSync(`tar -cf ${tarPath} -C ${appDir} ${files.join(' ')}`, { stdio: 'ignore' });

const payload = readFileSync(tarPath).toString('base64');
console.log('deploy:', (await op({ operation: 'deploy_component', project: 'sightline', payload })).message ?? '(no message)');

const base = process.env.SIGHTLINE_BASE ?? HARPER_OPS_URL.replace(/:9925\/?$/, '');

// The verifiable version marker is the hashed SPA bundle name Vite just produced;
// `/api/v1/health` is useless because the old component answers it 200 too.
const localHtml = existsSync(join(appDir, 'web/dist/index.html')) ? readFileSync(join(appDir, 'web/dist/index.html'), 'utf8') : '';
const expectedAsset = localHtml.match(/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0];
if (!expectedAsset) console.log('warn: no built web/dist asset to verify against — run `npm run build` first');

// Component code is not replicated like databases: `restart` sent to the
// load-balanced ops endpoint reaches one node, so the others keep serving the old
// build. Enumerate the peers and restart every node by its own hostname.
// Discovery starts from whichever node the load balancer returns and walks outward:
// `cluster_status.connections` lists a node's peers but not itself, whose identity
// is `replication.hostname` (not the CA subject, which is cluster-wide and names the
// issuing node). Walking each discovered node's peers covers clusters larger than two.
const nodeNames = new Set();
const queue = [HARPER_OPS_URL];
const visited = new Set();
while (queue.length) {
	const url = queue.shift();
	if (visited.has(url)) continue;
	visited.add(url);
	const [cfg, status] = await Promise.all([opAt(url, { operation: 'get_configuration' }), opAt(url, { operation: 'cluster_status' })]);
	const self = cfg?.replication?.hostname;
	if (self) nodeNames.add(self);
	for (const c of status?.connections ?? []) {
		if (!c.name || nodeNames.has(c.name)) continue;
		nodeNames.add(c.name);
		queue.push(`https://${c.name}:9925/`);
	}
}

const targets = nodeNames.size
	? [...nodeNames].map((n) => ({ name: n, ops: `https://${n}:9925/`, base: `https://${n}` }))
	: [{ name: '(single node)', ops: HARPER_OPS_URL, base }];
console.log(`cluster: ${targets.length} node(s) — ${targets.map((t) => t.name).join(', ')}`);

async function servedAsset(nodeBase) {
	try {
		const r = await fetch(`${nodeBase}/`);
		if (r.status !== 200) return null;
		return (await r.text()).match(/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0] ?? null;
	} catch {
		return null;
	}
}

const failures = [];
for (const t of targets) {
	const r = await opAt(t.ops, { operation: 'restart' });
	if (r?.__err) {
		failures.push(`${t.name}: ops unreachable (${r.__err})`);
		continue;
	}
	let ok = false;
	for (let i = 0; i < 25 && !ok; i++) {
		await sleep(4000);
		// Verified per node against the asset the build produced, not merely "something answers".
		const asset = await servedAsset(t.base);
		if (asset && (!expectedAsset || asset === expectedAsset)) {
			console.log(`${t.name}: live after ~${(i + 1) * 4}s serving ${asset}`);
			ok = true;
		}
	}
	if (!ok) failures.push(`${t.name}: did not come back serving ${expectedAsset ?? 'the app'}`);
}

// Confirm the load-balanced hostname is consistent several times; one probe can hit the current node.
if (!failures.length && expectedAsset) {
	const seen = new Set();
	for (let i = 0; i < 8; i++) seen.add(await servedAsset(base));
	if (seen.size !== 1 || !seen.has(expectedAsset)) {
		failures.push(`load-balanced ${base} served a mix: ${[...seen].join(', ')} (expected only ${expectedAsset})`);
	} else {
		console.log(`load balancer consistent across 8 probes: ${expectedAsset}`);
	}
}

if (failures.length) {
	console.error('\nDEPLOY NOT VERIFIED — the cluster may be serving mixed versions:');
	for (const f of failures) console.error(`  - ${f}`);
	console.error('Re-run the deploy, or restart the listed node(s) by their own hostname.');
	process.exit(1);
}

// Self-heals the Fabric @sealed column-add flake: deploy_component intermittently
// fails to add optional columns to an existing sealed table, silently dropping data.
// Verifies every column in schema.graphql and re-creates missing ones; idempotent.
const EXPECTED_COLUMNS = expectedColumns(readFileSync(new URL('../schema.graphql', import.meta.url), 'utf8'));
const described = new Map();
for (const [database, table, attribute] of EXPECTED_COLUMNS) {
	const tableKey = `${database}.${table}`;
	if (!described.has(tableKey)) described.set(tableKey, await op({ operation: 'describe_table', database, table }));
	const desc = described.get(tableKey);
	const has = Array.isArray(desc?.attributes) && desc.attributes.some((a) => a.attribute === attribute);
	if (!has) {
		const r = await op({ operation: 'create_attribute', database, table, attribute });
		console.log(`healed missing column ${table}.${attribute}: ${r.message ?? JSON.stringify(r)}`);
	}
}
console.log('schema columns verified');

// An @indexed added to an existing column is applied (and back-filled) by the
// deploy; no operation can create it afterwards, so a missing one is reported.
// describe_table marks an indexed attribute with an `indexed` property, and lists
// @computed attributes only with include_computed.
const notIndexed = [];
for (const [database, table, attribute] of indexedColumns(readFileSync(new URL('../schema.graphql', import.meta.url), 'utf8'))) {
	const desc = await op({ operation: 'describe_table', database, table, include_computed: true });
	const attr = Array.isArray(desc?.attributes) ? desc.attributes.find((a) => a.attribute === attribute) : undefined;
	if (!attr?.indexed) notIndexed.push(`${table}.${attribute}`);
}
if (notIndexed.length) {
	console.error(`\nINDEX MISSING after deploy: ${notIndexed.join(', ')}`);
	console.error('Queries on these fall back to full table scans. Redeploy and re-check with describe_table.');
	process.exit(1);
}
console.log('schema indexes verified');
