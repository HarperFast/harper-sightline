// Deploy the Sightline component to a Harper instance via the operations API,
// then restart and wait for it to load. Creds from env; nothing secret committed.
//   HARPER_OPS_URL=https://<host>:9925/ HARPER_USER=... HARPER_PASS=... \
//   NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/deploy.mjs
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_TLS_REJECT_UNAUTHORIZED ??= '0';
const { HARPER_OPS_URL, HARPER_USER, HARPER_PASS } = process.env;
if (!HARPER_OPS_URL || !HARPER_USER || !HARPER_PASS) {
	console.error('set HARPER_OPS_URL, HARPER_USER, HARPER_PASS');
	process.exit(2);
}
const auth = 'Basic ' + Buffer.from(`${HARPER_USER}:${HARPER_PASS}`).toString('base64');
const op = async (b) => {
	try {
		const r = await fetch(HARPER_OPS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: JSON.stringify(b) });
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const appDir = fileURLToPath(new URL('..', import.meta.url));
const files = ['config.yaml', 'schema.graphql', 'resources.ts', 'src', 'package.json'];
if (existsSync(join(appDir, 'web/dist/index.html'))) files.push('web/dist');
const tarPath = join(tmpdir(), 'sightline-deploy.tar');
execSync(`tar -cf ${tarPath} -C ${appDir} ${files.join(' ')}`, { stdio: 'ignore' });

const payload = readFileSync(tarPath).toString('base64');
console.log('deploy:', (await op({ operation: 'deploy_component', project: 'sightline', payload })).message ?? '(no message)');
console.log('restart:', (await op({ operation: 'restart' })).message ?? 'ok');

// Poll the live health route (not component status, which reports "healthy"
// before routes are actually served / while the node is still restarting).
const base = process.env.SIGHTLINE_BASE ?? HARPER_OPS_URL.replace(/:9925\/?$/, '');
for (let i = 0; i < 25; i++) {
	await sleep(4000);
	try {
		const r = await fetch(`${base}/api/v1/health`);
		if (r.status === 200) {
			console.log(`live after ~${(i + 1) * 4}s: /api/v1/health -> 200`);
			break;
		}
	} catch {
		// still restarting
	}
	if (i === 24) console.log('timeout waiting for /api/v1/health');
}
