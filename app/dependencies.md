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

## Frontend (added in slice 2)

Vite, `@shopify/app-bridge`, and Polaris web components will be added for the
embedded SPA and justified here when introduced.
