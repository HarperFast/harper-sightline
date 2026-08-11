// Request/response plumbing shared by the resource classes. Deliberately free of
// any `harper` import so it is unit-testable — a Resource class needs the Harper
// runtime to load, these helpers do not.

export function httpError(message: string, statusCode: number): Error & { statusCode: number } {
	const e = new Error(message) as Error & { statusCode: number };
	e.statusCode = statusCode;
	return e;
}

// Parse a URL, returning its pathname and search params (defensive).
export function parseUrl(url: string | undefined): URL {
	try {
		return new URL(url ?? '/', 'https://sightline.local');
	} catch {
		return new URL('https://sightline.local/');
	}
}

// The single path segment after `base`, decoded, or undefined for the collection.
export function trailingId(pathname: string, base: string): string | undefined {
	if (!pathname.startsWith(base + '/')) return undefined;
	const rest = pathname.slice(base.length + 1);
	if (!rest || rest.includes('/')) return undefined;
	try {
		return decodeURIComponent(rest);
	} catch {
		return rest;
	}
}

export function numParam(params: URLSearchParams, name: string): number | undefined {
	const raw = params.get(name);
	if (raw === null) return undefined;
	const n = Number(raw);
	return Number.isFinite(n) ? n : undefined;
}
