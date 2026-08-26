#!/usr/bin/env node
// Provision this component's secrets as SCOPED Harper secrets — `set_secret` with
// `grants: ['sightline']`, so the values are readable only through the component's
// own `secrets` accessor and never materialise into `process.env`.
//
//   HARPER_OPS_URL=https://…:9925 HARPER_USER=… HARPER_PASS=… \
//   SHOPIFY_API_SECRET=shpss_… SIGHTLINE_TOKEN_KEY=$(openssl rand -hex 32) \
//   SIGHTLINE_OPS_TOKEN=$(openssl rand -hex 16) \
//     node scripts/set-secrets.mjs
//
// Values come from the environment and are never written to disk or echoed. Pass
// --check to audit what the store holds without sending any value.
//
// PRECONDITION: custody. A scoped secret is encrypted on ingest with the
// cluster's custody keypair, so `set_secret` on a node with no custody stores an
// envelope nobody can open — and the component then fails to load with
// `custody-unavailable` rather than falling back, because the fallbacks are gone.
// This script therefore checks `get_secrets_public_key` FIRST and refuses to write
// if custody is uninitialised. That is the exact state this instance has been in
// (`custody_fingerprint` null cluster-wide); it needs a Fabric-side re-init before
// this script can do anything useful.
import { argv, env, exit } from 'node:process';

// The dev instance terminates TLS with a self-signed cert, same as deploy.mjs.
env.NODE_TLS_REJECT_UNAUTHORIZED ??= '0';

const { HARPER_OPS_URL, HARPER_USER, HARPER_PASS } = env;
if (!HARPER_OPS_URL || !HARPER_USER || !HARPER_PASS) {
	console.error('set HARPER_OPS_URL, HARPER_USER and HARPER_PASS');
	exit(1);
}

const COMPONENT = 'sightline';
const checkOnly = argv.includes('--check');

// Exactly the three names config.yaml declares as required. Keeping the list here
// rather than parsing config.yaml is deliberate: this script must be able to tell
// you that a name is MISSING from the store, which means it needs its own
// statement of what ought to be there.
const REQUIRED = [
	{ name: 'SHOPIFY_API_SECRET', validate: (v) => (v.startsWith('shpss_') ? null : 'expected a Shopify app secret (shpss_…)') },
	{
		name: 'SIGHTLINE_TOKEN_KEY',
		validate: (v) => (/^[0-9a-f]{64}$/i.test(v) ? null : 'expected 64 hex characters — generate with: openssl rand -hex 32'),
	},
	// 32 is opsAuth.ts's OPS_TOKEN_MIN_LENGTH; a shorter token is treated as absent
	// by the gate, so accepting one here would silently disable /api/v1/ops.
	{ name: 'SIGHTLINE_OPS_TOKEN', validate: (v) => (v.length >= 32 ? null : 'must be at least 32 characters (openssl rand -hex 16)') },
];

async function op(body) {
	const res = await fetch(HARPER_OPS_URL, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			authorization: `Basic ${Buffer.from(`${HARPER_USER}:${HARPER_PASS}`).toString('base64')}`,
		},
		body: JSON.stringify(body),
	});
	const text = await res.text();
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = { raw: text };
	}
	if (!res.ok) throw new Error(`${body.operation} -> ${res.status}: ${text.slice(0, 300)}`);
	return parsed;
}

// Custody gate. Without a public key there is no encryption key, so every write
// would produce an envelope this cluster cannot decrypt.
let fingerprint;
try {
	const key = await op({ operation: 'get_secrets_public_key' });
	// The response shape is not pinned across versions: take a fingerprint/kid if
	// one is offered, otherwise treat the presence of a public key as proof enough.
	fingerprint = key.fingerprint ?? key.kid ?? (key.publicKey || key.public_key ? '(key present, no fingerprint reported)' : undefined);
} catch (e) {
	console.error(`custody check failed: ${e.message}`);
}
if (!fingerprint) {
	console.error(
		'\nRefusing to write: secrets custody is not initialised on this cluster.\n' +
			'get_secrets_public_key returned no key, so a scoped secret written now would be\n' +
			'an envelope no node can decrypt, and the component would fail to load with\n' +
			'`custody-unavailable`. Re-initialise custody on the Fabric side first, re-run\n' +
			'with --check to confirm a fingerprint appears, then provision.\n\n' +
			'Until then, supply these three as environment variables instead — secretsPolicy.ts\n' +
			'falls back to process.env by design for exactly this case.',
	);
	exit(2);
}
console.log(`custody: ${fingerprint}`);

// What the store already holds. `list_secrets` returns names and grants, never
// values.
const listed = await op({ operation: 'list_secrets' });
const rows = Array.isArray(listed) ? listed : (listed.secrets ?? []);
const byName = new Map(rows.map((r) => [r.name, r]));

for (const { name, validate } of REQUIRED) {
	const existing = byName.get(name);
	const grants = existing?.grants ?? [];
	const granted = grants.includes(COMPONENT);
	const state = !existing ? 'missing' : granted ? 'present, granted' : `present, NOT granted (grants: ${grants.join(', ') || 'none'})`;

	if (checkOnly) {
		console.log(`${name}: ${state}`);
		continue;
	}

	const value = env[name];
	if (!value) {
		// Not fatal: provisioning one secret at a time is a normal thing to do, and
		// an already-granted row does not need re-sending.
		console.log(`${name}: skipped (not in the environment) — store says: ${state}`);
		continue;
	}
	const problem = validate(value.trim());
	if (problem) {
		// Refuse rather than store a value the component will reject at load. A
		// wrong-shaped secret that reaches the store fails later, further from here.
		console.error(`${name}: refusing to store — ${problem}`);
		exit(1);
	}

	await op({ operation: 'set_secret', name, value: value.trim(), grants: [COMPONENT] });
	console.log(`${name}: stored, granted to ${COMPONENT} (was: ${state})`);
}

if (!checkOnly) {
	console.log(
		"\nDone. Restart/redeploy the component so config.yaml's `env:` block is re-evaluated,\n" +
			'then confirm with: node scripts/set-secrets.mjs --check',
	);
}
