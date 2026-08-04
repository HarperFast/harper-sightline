// `shopify` is the global injected by app-bridge.js (loaded from the Shopify CDN).
declare const shopify: {
	idToken(): Promise<string>;
	config: { host: string; shop: string; apiKey: string; locale: string };
};

// Same-origin: the SPA and the API are both served by the Harper component.
async function apiGet(path: string): Promise<Response> {
	// Tokens are short-lived (~1 min) — fetch a fresh one per request.
	const token = await shopify.idToken();
	return fetch(path, { headers: { 'X-Shopify-Session-Token': token } });
}

async function load(): Promise<void> {
	const status = document.getElementById('status');
	if (!status) return;
	status.textContent = 'Connecting…';
	try {
		const res = await apiGet('/api/v1/session');
		if (!res.ok) throw new Error(`session responded ${res.status}`);
		const body = (await res.json()) as { shop: string; user: string };
		status.textContent = `Recording ${body.shop} — signed in as user ${body.user}.`;
	} catch (err) {
		status.textContent = `Not connected: ${(err as Error).message}`;
	}
}

document.getElementById('refresh')?.addEventListener('click', () => {
	void load();
});
void load();
