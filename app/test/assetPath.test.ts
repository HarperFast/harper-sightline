import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAssetUrl } from '../src/assetPath.ts';

// AppHome serves the built SPA's assets straight off disk, so the ONLY thing
// standing between an unauthenticated GET and an arbitrary file read is the
// containment check in resolveAssetUrl. The guard it replaces —
// `pathname.startsWith('/assets/') && !pathname.includes('..')` — was bypassable:
// `URL` does not decode `%2e%2e` into the pathname (so the `..` check never saw
// it) but URL *resolution* normalizes it into a real `..` segment, and
// `readFileSync(url)` then decodes to a filesystem path. `GET
// /assets/%2e%2e/%2e%2e/%2e%2e/src/readSecret.ts` read the module holding the app
// secret.
const DIST = new URL('file:///srv/component/web/dist/');

test('a real asset resolves to its file under web/dist/assets/', () => {
	assert.equal(resolveAssetUrl('/assets/index-a1b2c3.js', DIST)?.href, 'file:///srv/component/web/dist/assets/index-a1b2c3.js');
	// A nested asset directory keeps its subpath.
	assert.equal(resolveAssetUrl('/assets/fonts/inter.woff2', DIST)?.href, 'file:///srv/component/web/dist/assets/fonts/inter.woff2');
});

test('percent-encoded traversal cannot escape the asset directory', () => {
	// The original exploit, verified against the deployed layout.
	assert.equal(resolveAssetUrl('/assets/%2e%2e/%2e%2e/%2e%2e/src/readSecret.ts', DIST), undefined);
	assert.equal(resolveAssetUrl('/assets/%2E%2E/%2E%2E/%2E%2E/config.yaml', DIST), undefined);
	assert.equal(resolveAssetUrl('/assets/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd', DIST), undefined);
});

test('double-encoded traversal cannot escape either', () => {
	// A guard that decodes once and then looks for '..' is still bypassable:
	// '%252e%252e' decodes to '%2e%2e', which URL resolution normalizes to '..'.
	assert.equal(resolveAssetUrl('/assets/%252e%252e/%252e%252e/config.yaml', DIST), undefined);
});

test('literal traversal cannot escape the asset directory', () => {
	assert.equal(resolveAssetUrl('/assets/../config.yaml', DIST), undefined);
	assert.equal(resolveAssetUrl('/assets/../../shopify.app.toml', DIST), undefined);
});

test('an encoded separator is refused rather than handed to the filesystem', () => {
	assert.equal(resolveAssetUrl('/assets/..%2fconfig.yaml', DIST), undefined);
	assert.equal(resolveAssetUrl('/assets/..%5cconfig.yaml', DIST), undefined);
});

test('a path outside /assets/ is not an asset, even inside web/dist', () => {
	// index.html is served by the SPA branch (with its CSP), never as a raw file.
	assert.equal(resolveAssetUrl('/index.html', DIST), undefined);
	assert.equal(resolveAssetUrl('/', DIST), undefined);
	assert.equal(resolveAssetUrl('/assets', DIST), undefined);
	// Contained in web/dist but outside assets/ — still refused.
	assert.equal(resolveAssetUrl('/assets/%2e%2e/index.html', DIST), undefined);
});
