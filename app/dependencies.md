# Dependencies

Every dependency is justified here (Harper engineering guideline).

## Runtime

**None.** The backend uses only the `harper` runtime and Node built-ins
(`node:crypto`, global `fetch`, `URL`, `Buffer`). No third-party runtime deps.

## Dev

- **typescript** — typecheck (`tsc --noEmit`); the app ships as TypeStrip `.ts`, no build/emit.
- **@types/node** — Node type definitions for typecheck.
- **prettier** — formatting (`format:write` / `format:check`), Harper convention.
- **oxlint** — linting (`lint:required`), Harper convention.

## Frontend

- **vite** (dev) — builds the embedded SPA (`web/` → `web/dist/`), served by Harper's static plugin.

App Bridge and Polaris web components are **not npm dependencies** — Shopify requires
them loaded from its CDN (`cdn.shopify.com/shopifycloud/app-bridge.js` and `polaris.js`)
so the app always runs the latest version. They are plain `<script>` tags in
`web/index.html`; nothing to bundle or install.
