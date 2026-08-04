// Post-deploy route smoke test — the standing guard against the "component
// healthy but no routes registered" failure mode (ADR-001). Fails non-zero on
// any miss so it can gate a deploy.
//   SIGHTLINE_BASE=https://<host> NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/smoke.mjs
process.env.NODE_TLS_REJECT_UNAUTHORIZED ??= '0';
const base = process.env.SIGHTLINE_BASE ?? 'https://ayoo.josh-test.harperfabric.com';

async function get(path, headers = {}) {
	try {
		const r = await fetch(`${base}${path}`, { headers });
		return { status: r.status, body: (await r.text()).slice(0, 200).replace(/\n/g, ' ') };
	} catch (e) {
		return { status: 0, body: e.code ?? e.message };
	}
}

let ok = true;
const health = await get('/api/v1/health');
console.log(`GET /api/v1/health         -> ${health.status} ${health.body}`);
if (health.status !== 200) ok = false;

const session = await get('/api/v1/session');
console.log(`GET /api/v1/session (none) -> ${session.status}`);
if (session.status !== 401) ok = false;

console.log(ok ? 'SMOKE PASS' : 'SMOKE FAIL');
process.exit(ok ? 0 : 1);
