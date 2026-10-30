// Resolves a request path to a file inside the built SPA's asset directory, or
// undefined. AppHome serves the result off disk to unauthenticated callers, so this
// is the whole boundary between a GET and an arbitrary file read.
//
// A percent-encoded traversal once walked through the old `includes('..')` guard:
// `URL` leaves `%2e%2e` encoded in `pathname`, while URL resolution normalizes it
// into a real `..` segment. Hence two independent controls: refuse traversal
// primitives in any encoding, and require the resolved location to sit under
// `web/dist/assets/`.

// Escapes that can become `.` or a separator, checked before and after one decode
// round so `%252e%252e` is caught.
const ENCODED_TRAVERSAL = /%2e|%2f|%5c/i;

function decodeOnce(pathname: string): string {
	try {
		return decodeURIComponent(pathname);
	} catch {
		// A malformed escape is not a legitimate asset name.
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
	// The backstop: the resolved location cannot be fooled by an encoding not anticipated.
	const assetBase = new URL('assets/', distBase);
	return target.href.startsWith(assetBase.href) ? target : undefined;
}
