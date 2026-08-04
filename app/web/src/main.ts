// `shopify` is the global injected by app-bridge.js (loaded from the Shopify CDN).
declare const shopify: {
	idToken(): Promise<string>;
	config: { host: string; shop: string; apiKey: string; locale: string };
};

interface ApiResult {
	ok: boolean;
	status: number;
	text: string;
}

// Same-origin: the SPA and the API are both served by the Harper component.
// App Bridge injects `Authorization: Bearer <session-token>` on same-origin
// calls; the backend accepts the token from Authorization (Harper is configured
// to let it through) and also honors X-Shopify-Session-Token.
async function apiGet(path: string): Promise<ApiResult> {
	// Tokens are short-lived (~1 min) — fetch a fresh one per request.
	const token = await shopify.idToken();
	const res = await fetch(path, { headers: { 'X-Shopify-Session-Token': token } });
	return { ok: res.ok, status: res.status, text: await res.text() };
}

async function load(): Promise<void> {
	const status = document.getElementById('status');
	if (!status) return;
	status.textContent = 'Connecting…';
	try {
		const res = await apiGet('/api/v1/session');
		if (!res.ok) {
			let detail = '';
			try {
				detail = (JSON.parse(res.text) as { title?: string; error?: string }).title ?? '';
			} catch {
				// no JSON body
			}
			throw new Error(`session ${res.status}${detail ? `: ${detail}` : ''}`);
		}
		const body = JSON.parse(res.text) as { shop: string; user: string };
		status.textContent = `Recording ${body.shop} — signed in as user ${body.user}.`;
	} catch (err) {
		status.textContent = `Not connected: ${(err as Error).message}`;
	}
}

document.getElementById('refresh')?.addEventListener('click', () => {
	void load();
});
void load();
