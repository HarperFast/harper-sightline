import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const scriptsDir = fileURLToPath(new URL('../scripts/', import.meta.url));

// These scripts send admin credentials, the component tarball and secret values.
// Turning verification off is a per-invocation choice for a self-signed host, made on
// the command line; a script that sets it itself does so for every host, including
// the real one.
test('no script turns TLS verification off on its own', () => {
	const offenders = readdirSync(scriptsDir)
		.filter((name) => name.endsWith('.mjs'))
		.filter((name) => /^\s*(process\.)?env\.NODE_TLS_REJECT_UNAUTHORIZED\s*(\?\?|\|\||)=/m.test(readFileSync(scriptsDir + name, 'utf8')));
	assert.deepEqual(offenders, []);
});
