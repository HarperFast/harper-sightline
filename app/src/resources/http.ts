// Request/response helpers shared by the resource classes; free of any `harper`
// import so they are unit-testable.

export function httpError(message: string, statusCode: number): Error & { statusCode: number } {
	const e = new Error(message) as Error & { statusCode: number };
	e.statusCode = statusCode;
	return e;
}

export function parseUrl(url: string | undefined): URL {
	try {
		return new URL(url ?? '/', 'https://sightline.local');
	} catch {
		return new URL('https://sightline.local/');
	}
}

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
