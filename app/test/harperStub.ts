// This module exists solely so `src/db.ts` (and anything importing it) can be
// loaded under `node --test`. It is NEVER loaded in production — it only
// resolves because the test scripts pass `--conditions=test`, which activates
// the `test` branch of the `#harper` mapping in package.json's `imports`.
// Without that flag (as in a deployed component), `#harper` resolves to the
// real `harper` module exactly as before.
//
// There is no behavior under test here, only resolvability: `db.ts` reads
// `databases.<db>.<Table>` and immediately casts the result
// (`as unknown as Table<...>`), so any object stands in for a table handle. A
// test that needs real table behavior (search/get/put/...) should use
// `test/fakeTable.ts` instead — this stub does not implement that surface.

// The same inert handle for every table name; `db.ts` never calls anything on
// it before casting.
const inertTable = {};

// Same inert handle for every database name; `db.ts` reads `sightline_core`
// and `sightline_ledger`, but a Proxy means new table/database names added to
// `db.ts` later don't require touching this stub.
const inertDatabase = new Proxy(
	{},
	{
		get: () => inertTable,
	},
);

export const databases: Record<string, object> = new Proxy(
	{},
	{
		get: () => inertDatabase,
	},
);
