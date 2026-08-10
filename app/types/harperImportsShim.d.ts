// TypeScript's package.json `imports` resolution (moduleResolution: nodenext)
// does not fall back to the ambient `declare module 'harper'` in ./harper.d.ts
// when following the `#harper` subpath's "default" target — it requires an
// actual resolvable file, not a bare specifier with no real package on disk.
//
// This file is that resolution target, wired via the `types` condition of
// `#harper` in package.json. TypeScript checks the `types` condition first
// when type-checking a conditional import/export target, so this is what
// `src/db.ts`'s `import ... from '#harper'` type-checks against. Node itself
// never activates a `types` condition at runtime, so this has no effect on
// which file actually loads — that is decided by the `test`/`default`
// conditions alone. Re-exporting (rather than redeclaring) keeps ./harper.d.ts
// the single source of truth for the shape of the runtime module.
export { databases, type Table } from 'harper';
