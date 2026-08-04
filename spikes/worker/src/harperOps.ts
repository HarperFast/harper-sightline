// Minimal, reusable Harper operations-API client for the worker spike.
// Credentials come from the caller (env) — nothing secret is committed.

type Json = Record<string, unknown>;

export type Ops = {
	op(body: Json): Promise<any>;
	sql(sql: string): Promise<any>;
	insert(db: string, table: string, records: Json[]): Promise<any>;
	createTable(db: string, table: string, pk: string): Promise<any>;
	dropTable(db: string, table: string): Promise<any>;
};

export function makeOps(cfg: { url: string; user: string; pass: string }): Ops {
	const auth = 'Basic ' + Buffer.from(`${cfg.user}:${cfg.pass}`).toString('base64');

	async function op(body: Json): Promise<any> {
		const res = await fetch(cfg.url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: auth },
			body: JSON.stringify(body),
		});
		const text = await res.text();
		let json: unknown = text;
		try {
			json = JSON.parse(text);
		} catch {
			// keep raw text
		}
		if (!res.ok) {
			const e = new Error(`ops ${String(body.operation)} failed: ${res.status} ${text.slice(0, 200)}`) as Error & {
				statusCode: number;
			};
			e.statusCode = res.status;
			throw e;
		}
		return json;
	}

	return {
		op,
		sql: (sql) => op({ operation: 'sql', sql }),
		insert: (db, table, records) => op({ operation: 'insert', database: db, table, records }),
		createTable: (db, table, pk) => op({ operation: 'create_table', database: db, table, primary_key: pk }),
		dropTable: (db, table) => op({ operation: 'drop_table', database: db, table }),
	};
}
