import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The `#harper` mapping has one branch no test can execute: `default` is taken
// only when neither the `test` condition (node --test) nor the `types` condition
// (tsc) is active — that is, only inside the deployed component. So the branch that
// runs in production is the branch nothing offline runs.
//
// It was `"harper"`, a bare specifier, and that took the whole app down with
// `ResourceLoadError: Can not load module at …/@harperfast/harper-pro/dist/core/
// index.js outside of allowed path /home/harperdb/harper/components/sightline`.
// Node resolves an `imports` target itself, so the bare name resolved to the
// installed package's real path, which Harper's component loader rejects; a bare
// `import … from 'harper'` in module source is instead intercepted by Harper's
// linker and never resolved against the filesystem.
//
// These tests pin the SHAPE of the mapping, since the behavior is unreachable from
// here. They are the only offline defence against re-breaking every route at once.

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const mapping = pkg.imports?.['#harper'];

test('the #harper mapping still exists, with the three conditions it depends on', () => {
	assert.ok(mapping, 'src/db.ts imports #harper; removing the mapping breaks the build');
	assert.equal(typeof mapping.default, 'string');
	assert.equal(typeof mapping.test, 'string', 'the test stub is what lets db.ts be imported offline');
	assert.equal(typeof mapping.types, 'string', 'tsc resolves the shim through the types condition');
});

test('the production target is a file INSIDE the component, never a bare specifier', () => {
	// A bare specifier here is resolved by Node to the installed package's real
	// path, which Harper's loader refuses as outside the component directory. Only a
	// relative target stays inside it.
	assert.match(mapping.default, /^\.\//, `#harper "default" must be a relative path, got ${JSON.stringify(mapping.default)}`);
	const target = new URL(`../${mapping.default.slice(2)}`, import.meta.url);
	const source = readFileSync(target, 'utf8');
	// And that file reaches the runtime the way the rest of the component does: the
	// bare specifier in module source, which Harper's linker intercepts.
	assert.match(source, /from 'harper'/, 'the runtime target must import the bare `harper` specifier');
	assert.match(source, /export \{[^}]*databases/, 'db.ts imports `databases` through it');
	// `secrets` reaches the app through the same mapping, and it must NOT be a named
	// re-export: on a runtime without that export a named binding fails to link, and
	// since resources.ts pulls this file in transitively, that would 404 every route
	// while the component still reported healthy. A namespace import degrades to an
	// empty accessor instead, and secretsPolicy.ts then raises MissingSecretError.
	assert.match(source, /import \* as harper from 'harper'/, 'secrets must come through a namespace import, not a named re-export');
	assert.match(source, /export const secrets/, 'secretsPolicy.ts imports `secrets` through it');
	// Anchored to the start of a line so the sentence explaining this rule in
	// harperRuntime.ts — which quotes the forbidden form verbatim — is not itself
	// read as a violation of it.
	assert.doesNotMatch(source, /^export \{[^}]*\bsecrets\b/m, 'a named `secrets` re-export would fail to link on a runtime lacking it');
});

test('the deploy tarball actually ships the runtime target', () => {
	// scripts/deploy.mjs packs an explicit file list. A runtime target outside it
	// would resolve locally and 404 on the instance — the same all-routes outage in
	// a different disguise.
	const deploy = readFileSync(new URL('../scripts/deploy.mjs', import.meta.url), 'utf8');
	const packed = /const files = \[([^\]]*)\]/.exec(deploy)?.[1] ?? '';
	const dir = mapping.default.replace(/^\.\//, '').split('/')[0];
	assert.ok(packed.includes(`'${dir}'`), `deploy.mjs must pack '${dir}/' for #harper's default target to exist on the instance`);
});
