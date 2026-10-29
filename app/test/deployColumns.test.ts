import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expectedColumns, indexedColumns } from '../scripts/schemaColumns.mjs';

const sdl = readFileSync(fileURLToPath(new URL('../schema.graphql', import.meta.url)), 'utf8');
const key = ([database, table, attribute]: string[]) => `${database}.${table}.${attribute}`;

test('derives database, table and non-key attributes from the SDL, ignoring comments', () => {
	const cols = expectedColumns(`
type Foo @table(database: "db_a") @sealed {
	# id: String
	id: ID! @primaryKey
	name: String # trailing: note
	count: Int @indexed
}
type Bar @table(database: "db_b") @sealed {
	id: ID! @primaryKey
	flag: Boolean
}
`);
	assert.deepEqual(cols, [
		['db_a', 'Foo', 'name'],
		['db_a', 'Foo', 'count'],
		['db_b', 'Bar', 'flag'],
	]);
});

test('every non-key schema field is in the derived list, so a new column cannot be forgotten', () => {
	const derived = new Set(expectedColumns(sdl).map(key));
	const bodies = [...sdl.replace(/#.*$/gm, '').matchAll(/^type (\w+) @table\(database: "(\w+)"\)[^{]*\{([^}]*)\}/gm)];
	const tablesWithColumns = new Set(expectedColumns(sdl).map(([database, table]) => `${database}.${table}`));
	const declared = sdl.split('@table(').length - 1;
	assert.equal(bodies.length, declared, 'every @table type in schema.graphql is parsed');
	assert.equal(tablesWithColumns.size, declared, 'every @table type yields derived columns');
	for (const [, table, database, body] of bodies) {
		for (const line of body.split('\n')) {
			const m = /^\t(\w+):/.exec(line);
			if (!m || line.includes('@primaryKey')) continue;
			assert.ok(derived.has(`${database}.${table}.${m[1]}`), `${database}.${table}.${m[1]} missing from the derived list`);
		}
	}
	for (const col of ['state', 'lastEventAt', 'trackingAt', 'trackingCompany', 'eventCount', 'firstEventAt']) {
		assert.ok(derived.has(`sightline_ledger.OrderProjection.${col}`), col);
	}
	assert.ok(derived.has('sightline_core.Shop.ianaTimezone'));
});

test('derives the @indexed non-key attributes, so deploy can check each index exists', () => {
	assert.deepEqual(
		indexedColumns(`
type Foo @table(database: "db_a") @sealed {
	id: ID! @primaryKey
	# old: Float @indexed
	name: String # not @indexed
	count: Int @indexed
}
`),
		[['db_a', 'Foo', 'count']],
	);
});
