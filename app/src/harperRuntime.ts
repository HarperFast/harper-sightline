// The RUNTIME target of the `#harper` subpath import (package.json `imports`).
//
// Why this file exists at all. `#harper` lets `src/db.ts` be loaded by tests (the
// `test` condition swaps in `test/harperStub.ts`) while production gets the real
// module. Its `default` used to be the bare specifier `"harper"`, on the
// reasonable assumption that Node would then resolve it "exactly as before" — and
// that is the one thing it does not do. Node resolves an `imports` target itself,
// producing a resolved module URL; the bare name lands on the installed package's
// real path, and Harper's component loader then refuses it:
//
//   Can not load module at …/@harperfast/harper-pro/dist/core/index.js
//   outside of allowed path /home/harperdb/harper/components/sightline
//
// A bare `import … from 'harper'` never gets that far: Harper's linker intercepts
// the specifier and hands back its built-in module, which is why every other module
// in this component (resources.ts, jobs.ts, …) imports it that way and works.
//
// So the mapping's default target has to be a file INSIDE the component — this one
// — whose own import of `harper` is the intercepted form. One indirection, and the
// production path is back on the specifier form the whole component already proves.
//
// This failure mode is invisible offline BY CONSTRUCTION: `node --test` activates
// the `test` condition and `tsc` the `types` condition, so the `default` branch is
// taken in exactly one environment — the deployed component. A test in
// harperImports.test.ts therefore pins the shape of the mapping instead, since no
// test can exercise the branch itself.
export { databases, type Table } from 'harper';
