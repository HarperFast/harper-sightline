// [database, table, attribute] for every stored non-key field of every @table type
// in the SDL. Primary keys are excluded: a table cannot exist without its key.
// @computed fields are excluded: create_attribute would make a stored column, not
// a computed one. Comments are stripped first: they may contain braces (`${shopId}`).
export function expectedColumns(sdl) {
	return fields(sdl)
		.filter((f) => !f.computed)
		.map(({ database, table, attribute }) => [database, table, attribute]);
}

// Every non-key field marked @indexed, computed or not.
export function indexedColumns(sdl) {
	return fields(sdl)
		.filter((f) => f.indexed)
		.map(({ database, table, attribute }) => [database, table, attribute]);
}

function fields(sdl) {
	const out = [];
	const code = sdl.replace(/#.*$/gm, '');
	const tableRe = /^type\s+(\w+)\s+@table\(database:\s*"(\w+)"\)[^{]*\{([^}]*)\}/gm;
	for (const [, table, database, body] of code.matchAll(tableRe)) {
		for (const line of body.split('\n')) {
			const m = /^\s*(\w+)\s*:/.exec(line);
			if (!m || line.includes('@primaryKey')) continue;
			out.push({ database, table, attribute: m[1], indexed: /@indexed\b/.test(line), computed: /@computed\b/.test(line) });
		}
	}
	return out;
}
