// [database, table, attribute] for every non-key field of every @table type in
// the SDL. Primary keys are excluded: a table cannot exist without its key.
// Comments are stripped first: they may contain braces (`${shopId}`).
export function expectedColumns(sdl) {
	const columns = [];
	const code = sdl.replace(/#.*$/gm, '');
	const tableRe = /^type\s+(\w+)\s+@table\(database:\s*"(\w+)"\)[^{]*\{([^}]*)\}/gm;
	for (const [, table, database, body] of code.matchAll(tableRe)) {
		for (const line of body.split('\n')) {
			const m = /^\s*(\w+)\s*:/.exec(line);
			if (!m || line.includes('@primaryKey')) continue;
			columns.push([database, table, m[1]]);
		}
	}
	return columns;
}
