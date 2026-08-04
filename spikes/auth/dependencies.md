# Dependencies — Spike A (auth)

No third-party dependencies. Uses only:

- `node:crypto` — HS256 HMAC verification of Shopify session tokens
- `node:test` / `node:assert` — test runner (built into Node 24)
- global `fetch` — Shopify token exchange (built into Node 24)
- Node native TypeScript type-stripping — no build step

Runtime: Harper 5.2.0, Node 24.18.0.
