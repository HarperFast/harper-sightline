import { defineConfig } from 'vite';

// The SPA is served at the site root by Harper's static plugin, same origin as
// the API. App Bridge + Polaris load from the Shopify CDN (external script tags
// in index.html) — nothing to bundle for them.
export default defineConfig({
	base: '/',
	build: { outDir: 'dist', emptyOutDir: true },
});
