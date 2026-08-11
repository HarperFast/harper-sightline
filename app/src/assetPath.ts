// Resolve a request path to a file inside the built SPA's asset directory, or
// undefined when it does not name one. AppHome serves the result straight off
// disk to unauthenticated callers, so this is the whole boundary between a GET
// and an arbitrary file read.
//
// The guard this replaces was `pathname.startsWith('/assets/') &&
// !pathname.includes('..')`, which a percent-encoded traversal walked straight
// through: `URL` leaves `%2e%2e` encoded in `pathname` (so the textual `..` check
// never saw it) while URL *resolution* normalizes it into a real `..` segment, and
// `readFileSync(url)` then decodes to a filesystem path. `GET
// /assets/%2e%2e/%2e%2e/%2e%2e/src/readSecret.ts` returned the module holding the
// Shopify app secret — which is also the key to every tenant's data, since it
// signs the session tokens.
//
// Hence two independent controls: refuse the traversal primitives in any encoding,
// and require the resolved location to sit under `web/dist/assets/`.

// The escapes that can become a `.` or a path separator. Checked before AND after
// one decode round, so `%252e%252e` (which decodes to `%2e%2e`) is caught too.
const ENCODED_TRAVERSAL = /%2e|%2f|%5c/i;

function decodeOnce(pathname: string): string {
	try {
		return decodeURIComponent(pathname);
	} catch {
		// A malformed escape is not a legitimate asset name either.
		return pathname;
	}
}

export function resolveAssetUrl(pathname: string, distBase: URL): URL | undefined {
	if (!pathname.startsWith('/assets/')) return undefined;
	const decoded = decodeOnce(pathname);
	if (ENCODED_TRAVERSAL.test(pathname) || ENCODED_TRAVERSAL.test(decoded) || decoded.includes('..')) return undefined;

	let target: URL;
	try {
		target = new URL(`.${pathname}`, distBase);
	} catch {
		return undefined;
	}
	// The backstop: compare the RESOLVED location, the only check that cannot be
	// fooled by an encoding this code did not anticipate.
	const assetBase = new URL('assets/', distBase);
	return target.href.startsWith(assetBase.href) ? target : undefined;
}
