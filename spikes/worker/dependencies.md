# Dependencies — Spike B (worker recovery)

No third-party dependencies. Uses only:

- `node:test` / `node:assert` — test runner
- global `fetch` — Harper operations API
- Node native TypeScript type-stripping — no build step

Runtime proven against Harper 5.2.0 (Fabric) via the operations API.
