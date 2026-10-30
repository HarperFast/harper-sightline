// Runtime target of the `#harper` subpath import (package.json `imports`), whose
// `test` condition swaps in `test/harperStub.ts`.
//
// The `default` target must be a file inside the component, not the bare specifier
// `harper`: Node resolves an `imports` target itself to the package's real path,
// and Harper's component loader refuses it ("Can not load module ... outside of
// allowed path"). A bare `import ... from 'harper'` is intercepted by Harper's
// linker, so this file's own import takes that form.
//
// The `default` branch runs only in the deployed component (`node --test` uses the
// `test` condition, `tsc` the `types` condition), so harperImports.test.ts pins the
// shape of the mapping instead.
export { databases, type Table } from 'harper';

// `secrets` is re-exported through a namespace import, not a named re-export: a
// named export is a link-time binding, so on a runtime whose `harper` lacks
// `secrets` the module would fail to link, and since resources.ts imports this
// transitively that takes down every route while the component reports healthy
// (the ADR-001 trap). A namespace import degrades to `{}`, so reads miss and
// readSecret.ts / crypto.ts raise a MissingSecretError naming what is absent.
//
// The accessor object is re-exported, not copies of its values, so reads stay live across a rotation.
import * as harper from 'harper';
export const secrets: Record<string, string | undefined> = (harper as { secrets?: Record<string, string | undefined> }).secrets ?? {};

// Same namespace read for `transaction`. Without one the work runs uncommitted as a
// unit, each write on its own, which is how the writes ran before.
export const transaction: <T>(work: () => Promise<T>) => Promise<T> =
	(harper as { transaction?: <T>(work: () => Promise<T>) => Promise<T> }).transaction ?? ((work) => work());
