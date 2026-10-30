// TypeScript's package.json `imports` resolution (moduleResolution: nodenext)
// does not fall back to the ambient `declare module 'harper'` in ./harper.d.ts
// when following the `#harper` subpath's "default" target — it requires an
// actual resolvable file, not a bare specifier with no real package on disk.
//
// This file is that resolution target, wired via the `types` condition of
// `#harper` in package.json. TypeScript checks the `types` condition first
// when type-checking a conditional import/export target, so this is what
// `src/db.ts`'s `import ... from '#harper'` type-checks against. `types` is
// not in Node's default active-condition set, so under a normal run this file
// has no effect on which module actually loads — that is decided by the
// `test`/`default` conditions alone. Force-activating it (`node
// --conditions=types`) makes Node follow it too, and it then fails loudly on
// this file's own re-export from the bare `harper` specifier, which has no
// real package on disk (see the comment above) — a `.d.ts`-only file was
// never meant to be loaded as a module. Re-exporting (rather than
// redeclaring) keeps ./harper.d.ts the single source of truth for the shape
// of the runtime module.
export { databases, type Table } from 'harper';
export declare const secrets: Record<string, string | undefined>;
export declare const transaction: <T>(work: () => Promise<T>) => Promise<T>;
