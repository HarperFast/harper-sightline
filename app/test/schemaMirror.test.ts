// Guards schema.graphql (the SDL) against src/model.ts (the hand-maintained
// TypeScript mirror every resource/worker imports). model.ts can't be
// imported to check this at runtime -- TS interfaces are erased by the time
// the file executes, so there is nothing to introspect -- so both files are
// read and parsed as SOURCE TEXT: schema.graphql with a small hand-written
// parser (this project has no GraphQL parser dependency and must not gain
// one), and src/model.ts with the real TypeScript compiler, via the
// `typescript` package's sync compiler API (`typescript/unstable/sync`),
// which also resolves cross-file type aliases (e.g. OrderProjection.state's
// `ProjectionState`, which is an alias for `OrderLane` defined in
// src/orders.ts).
//
// Why this exists: every test in this suite writes through an in-memory
// FakeTable, never a real Harper table. A column renamed or retyped on only
// one of these two files is invisible to that whole suite -- it fails only
// at runtime, when a write names a column the deployed @sealed table doesn't
// have, and only `describe_table` against a live instance would catch it.
// This test is the substitute for that: it runs on every `npm test`.
//
// WHAT IS COMPARED, per `@table` type in the schema against the TS
// interface of the same name:
//   - the set of field names matches exactly (catches a field renamed on
//     only one side, or added to one side and not the other)
//   - every field's nullability agrees: a schema field marked `!` must be
//     non-optional (no `?`) in TS, and every nullable schema field must be
//     optional in TS
//   - a LOOSE type-kind check: GraphQL {ID, String} <-> TS `string`,
//     {Int, Float} <-> TS `number`, {Boolean} <-> TS `boolean`, and
//     list-ness (`[X]` <-> `X[]`) agrees
//   - the set of `@table` type names in the schema matches the set of
//     top-level `export interface` names in model.ts (catches a table
//     added or removed on only one side)
//   - a field name appears at most once per `@table` body -- a duplicate
//     throws rather than the parser silently keeping the last one and
//     comparing that
//
// WHAT IS DELIBERATELY NOT COMPARED, and why:
//   - GraphQL Int vs Float. Both erase to TypeScript's `number` -- nothing
//     in model.ts's source distinguishes them, so no comparison against it
//     can tell a Float column from an Int one; this is a limit of reading
//     model.ts as TypeScript, not a gap in this guard's logic. This matters
//     here because schema.graphql's header says every epoch-ms timestamp is
//     deliberately Float (Int is 32-bit in GraphQL and would truncate one),
//     but this guard cannot enforce that rule; changing a timestamp column
//     from Float to Int passes this test unchanged. Verified experimentally
//     (changed Shop.installedAt to Int, ran the comparison, saw zero issues,
//     reverted). Closing this gap would need a schema-side marker (e.g. a
//     directive naming the Int columns) to compare against, not a sharper
//     heuristic over model.ts's field names or types -- TypeScript's type
//     system has nothing left to give.
//   - directives (@primaryKey, @indexed, @sealed, @table, ...), comments,
//     and default values -- none of which model.ts has anywhere to encode.
//   - String-literal-union narrowing. schema.graphql has no enum type, so
//     every String field is schema-side just 'string'; model.ts narrowing
//     one to a union (e.g. `status: ShopStatus`) is treated as compatible,
//     not as drift, since the union's own members are themselves strings.
//   - anything about a GraphQL type with no `@table` directive (there are
//     none today; if one is ever added it is simply out of this guard's
//     scope, same as the brief that commissioned it scopes the check).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { API, isUnionType, TypeFlags } from 'typescript/unstable/sync';
import { createVirtualFileSystem } from 'typescript/unstable/fs';
import {
	isInterfaceDeclaration,
	isPropertySignatureDeclaration,
	isArrayTypeNode,
	isIdentifier,
	isExportKeyword,
} from 'typescript/unstable/ast';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const schemaPath = fileURLToPath(new URL('../schema.graphql', import.meta.url));
const modelPath = fileURLToPath(new URL('../src/model.ts', import.meta.url));

// Fixtures for the "fails loudly" tests below. These are never written to
// disk -- typescript/unstable/fs's createVirtualFileSystem serves this
// content in place of a real file. Deliberately on a SEPARATE API instance
// from the one that reads src/model.ts: the virtual filesystem is a closed
// world (its directoryExists/fileExists never fall through to the real
// disk, even though readFile does), so sharing one API instance between it
// and the real project breaks the real project's tsconfig discovery and
// cross-file resolution -- confirmed experimentally; OrderProjection.state's
// `ProjectionState` (an alias into src/orders.ts) silently degraded to `any`
// when both lived on one instance. The fixtures below are self-contained
// (no imports), so the closed world is no limitation for them.
const unsupportedMemberPath = appDir + 'test/__schemaMirror_fixture_unsupportedMember.ts';
const unsupportedMemberSource = 'export interface Foo {\n\tbar(): void;\n}\n';
const brokenSyntaxPath = appDir + 'test/__schemaMirror_fixture_brokenSyntax.ts';
const brokenSyntaxSource = 'export interface Foo {\n\tbar: string\n'; // missing closing brace
const nonExportedHelperPath = appDir + 'test/__schemaMirror_fixture_nonExportedHelper.ts';
// NotATable is a local helper an interface author might add to model.ts for
// its own sake (e.g. a shared shape used by more than one @table interface).
// It is deliberately NOT exported, and deliberately has no same-named @table
// in schema.graphql -- neither of which should make this guard's own loader
// throw. Foo IS exported and stands in for a real table interface.
const nonExportedHelperSource = 'interface NotATable {\n\thelper: string;\n}\nexport interface Foo {\n\tbar: string;\n}\n';

const api = new API({ cwd: appDir });
const fixtureApi = new API({
	cwd: appDir,
	fs: createVirtualFileSystem({
		[unsupportedMemberPath]: unsupportedMemberSource,
		[brokenSyntaxPath]: brokenSyntaxSource,
		[nonExportedHelperPath]: nonExportedHelperSource,
	}),
});
after(() => {
	api.close();
	fixtureApi.close();
});
const snapshot = api.updateSnapshot({ openFiles: [modelPath] });
const fixtureSnapshot = fixtureApi.updateSnapshot({
	openFiles: [unsupportedMemberPath, brokenSyntaxPath, nonExportedHelperPath],
});

// ─── schema.graphql side: a small hand-written SDL parser ─────────────────

type SchemaField = { required: boolean; isList: boolean; scalar: 'string' | 'number' | 'boolean' };
type SchemaTable = Map<string, SchemaField>;

const GRAPHQL_SCALAR_TO_KIND: Record<string, SchemaField['scalar'] | undefined> = {
	ID: 'string',
	String: 'string',
	Int: 'number',
	Float: 'number',
	Boolean: 'boolean',
};

// Cuts a line at its first '#' that isn't inside a "..." string (directive
// arguments like `@table(database: "sightline_core")` contain quotes but
// never a '#', so this only has to avoid cutting inside those).
function stripLineComment(line: string): string {
	let inString = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === '"' && line[i - 1] !== '\\') inString = !inString;
		else if (ch === '#' && !inString) return line.slice(0, i);
	}
	return line;
}

const FIELD_LINE_RE = /^(\w+)\s*:\s*(\[\w+\]|\w+)(!)?\s*((?:@\w+(?:\([^)]*\))?\s*)*)$/;
const TYPE_BLOCK_RE = /type\s+(\w+)\s*((?:@\w+(?:\([^)]*\))?\s*)*)\{([\s\S]*?)\}/g;

function parseSchemaTables(sdl: string, sourceLabel: string): Map<string, SchemaTable> {
	const clean = sdl.split('\n').map(stripLineComment).join('\n');
	const tables = new Map<string, SchemaTable>();
	let sawAnyType = false;
	for (const typeMatch of clean.matchAll(TYPE_BLOCK_RE)) {
		sawAnyType = true;
		const [, typeName, directives, body] = typeMatch;
		if (!/@table\b/.test(directives)) continue; // out of scope: not a @table type

		const fields: SchemaTable = new Map();
		const lines = body
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l.length > 0);
		for (const line of lines) {
			const m = FIELD_LINE_RE.exec(line);
			if (!m) {
				throw new Error(`schemaMirror: could not parse a field declaration in type "${typeName}" (${sourceLabel}): "${line}"`);
			}
			const [, fieldName, typeToken, bang] = m;
			if (fields.has(fieldName)) {
				throw new Error(`schemaMirror: duplicate field "${fieldName}" in type "${typeName}" (${sourceLabel})`);
			}
			const isList = typeToken.startsWith('[');
			const base = isList ? typeToken.slice(1, -1) : typeToken;
			const scalar = GRAPHQL_SCALAR_TO_KIND[base];
			if (!scalar) {
				throw new Error(`schemaMirror: unrecognized scalar type "${base}" for field ${typeName}.${fieldName} (${sourceLabel})`);
			}
			fields.set(fieldName, { required: !!bang, isList, scalar });
		}
		tables.set(typeName, fields);
	}
	if (!sawAnyType) {
		throw new Error(
			`schemaMirror: found no "type ... { ... }" declarations at all in ${sourceLabel} -- the SDL parser or its input is broken`,
		);
	}
	if (tables.size === 0) {
		throw new Error(`schemaMirror: found type declarations in ${sourceLabel} but none carried @table`);
	}
	return tables;
}

// ─── src/model.ts side: the real TypeScript compiler ───────────────────────

type ModelField = { optional: boolean; isList: boolean; scalar: 'string' | 'number' | 'boolean' };

// Reduces a checker Type to the same three-way bucket as the schema side.
// Unions (e.g. a `'active' | 'paused'` literal union, or a named alias like
// `ShopStatus` -- the checker resolves aliases transparently) are classified
// by their constituents, which must all agree; anything else -- an object
// type, a function type, `any`, ... -- is unrecognized and throws rather
// than guessing.
function classifyType(
	type: import('typescript/unstable/sync').Type,
	checker: import('typescript/unstable/sync').Checker,
	where: string,
): ModelField['scalar'] {
	if (isUnionType(type)) {
		const constituents = type.getTypes() ?? [];
		if (constituents.length === 0) {
			throw new Error(`schemaMirror: ${where} is a union type with no constituents`);
		}
		const kinds = new Set(constituents.map((t) => classifyType(t, checker, where)));
		if (kinds.size !== 1) {
			throw new Error(
				`schemaMirror: ${where} is a union that mixes incompatible kinds (${[...kinds].join(', ')}); this guard cannot classify it`,
			);
		}
		return [...kinds][0];
	}
	if (type.flags & (TypeFlags.String | TypeFlags.StringLiteral)) return 'string';
	if (type.flags & (TypeFlags.Number | TypeFlags.NumberLiteral)) return 'number';
	if (type.flags & (TypeFlags.Boolean | TypeFlags.BooleanLiteral)) return 'boolean';
	throw new Error(`schemaMirror: ${where} has a type (${checker.typeToString(type)}) this guard does not know how to classify`);
}

// Loads every top-level `export interface` in `filePath` as a name -> fields
// map, using `project`'s checker to resolve each property's type (including
// through cross-file aliases). Throws -- rather than skipping or returning a
// partial result -- on a syntax error, a non-property member (a method, an
// index signature, ...), a property with no type annotation, or a type this
// guard can't classify.
function loadModelInterfaces(
	project: import('typescript/unstable/sync').Project,
	filePath: string,
	sourceLabel: string,
): Map<string, Map<string, ModelField>> {
	const syntaxErrors = project.program.getSyntacticDiagnostics(filePath);
	if (syntaxErrors.length > 0) {
		throw new Error(
			`schemaMirror: ${sourceLabel} has syntax errors the TypeScript compiler could not parse: ${syntaxErrors.map((d) => d.text).join('; ')}`,
		);
	}
	const sourceFile = project.program.getSourceFile(filePath);
	if (!sourceFile) {
		throw new Error(`schemaMirror: could not load ${sourceLabel} as a source file`);
	}

	const interfaces = new Map<string, Map<string, ModelField>>();
	for (const statement of sourceFile.statements) {
		if (!isInterfaceDeclaration(statement)) continue;
		// A non-exported interface is a local helper, not part of the mirror this
		// guard checks -- it has no reason to have a same-named `@table` in
		// schema.graphql, and the comparison in diffSchemaAndModel() would
		// otherwise force one into existence. Skipping it here is what makes the
		// header comment above ("Loads every top-level `export interface`") true.
		if (!statement.modifiers?.some(isExportKeyword)) continue;
		const interfaceName = statement.name.text;
		const fields = new Map<string, ModelField>();
		for (const member of statement.members) {
			if (!isPropertySignatureDeclaration(member)) {
				throw new Error(
					`schemaMirror: ${sourceLabel}'s interface ${interfaceName} has a non-property member (syntax kind ${member.kind}); this guard only understands plain "name: Type;" property signatures`,
				);
			}
			if (!isIdentifier(member.name)) {
				throw new Error(
					`schemaMirror: ${sourceLabel}'s interface ${interfaceName} has a property with a non-identifier name (syntax kind ${member.name.kind}); this guard only understands plain identifier field names`,
				);
			}
			const fieldName = member.name.text;
			const optional = !!member.postfixToken;
			let typeNode = member.type;
			if (!typeNode) {
				throw new Error(`schemaMirror: ${sourceLabel}'s ${interfaceName}.${fieldName} has no explicit type annotation`);
			}
			let isList = false;
			if (isArrayTypeNode(typeNode)) {
				isList = true;
				typeNode = typeNode.elementType;
			}
			const type = project.checker.getTypeAtLocation(typeNode);
			if (!type) {
				throw new Error(`schemaMirror: could not resolve a type for ${sourceLabel}'s ${interfaceName}.${fieldName}`);
			}
			const scalar = classifyType(type, project.checker, `${sourceLabel}'s ${interfaceName}.${fieldName}`);
			fields.set(fieldName, { optional, isList, scalar });
		}
		interfaces.set(interfaceName, fields);
	}
	if (interfaces.size === 0) {
		throw new Error(
			`schemaMirror: found no "export interface" declarations at all in ${sourceLabel} -- the TS parser or its input is broken`,
		);
	}
	return interfaces;
}

// ─── the comparison itself ──────────────────────────────────────────────────

function diffSchemaAndModel(schemaTables: Map<string, SchemaTable>, modelInterfaces: Map<string, Map<string, ModelField>>): string[] {
	const issues: string[] = [];
	const tableNames = new Set(schemaTables.keys());
	const interfaceNames = new Set(modelInterfaces.keys());

	for (const name of tableNames) {
		if (!interfaceNames.has(name))
			issues.push(`@table ${name} in schema.graphql has no matching "export interface ${name}" in src/model.ts`);
	}
	for (const name of interfaceNames) {
		if (!tableNames.has(name)) issues.push(`"export interface ${name}" in src/model.ts has no matching @table in schema.graphql`);
	}

	for (const [name, schemaFields] of schemaTables) {
		const modelFields = modelInterfaces.get(name);
		if (!modelFields) continue; // already reported above

		const schemaFieldNames = new Set(schemaFields.keys());
		const modelFieldNames = new Set(modelFields.keys());
		for (const field of schemaFieldNames) {
			if (!modelFieldNames.has(field))
				issues.push(`${name}.${field}: declared in schema.graphql, missing from the ${name} interface in src/model.ts`);
		}
		for (const field of modelFieldNames) {
			if (!schemaFieldNames.has(field))
				issues.push(`${name}.${field}: declared in the ${name} interface in src/model.ts, missing from schema.graphql`);
		}

		for (const field of schemaFieldNames) {
			if (!modelFieldNames.has(field)) continue;
			const schemaField = schemaFields.get(field)!;
			const modelField = modelFields.get(field)!;
			if (schemaField.required === modelField.optional) {
				issues.push(
					`${name}.${field}: nullability mismatch -- schema.graphql marks it ${schemaField.required ? 'required (!)' : 'nullable'}, ` +
						`src/model.ts marks it ${modelField.optional ? 'optional (?)' : 'required'}`,
				);
			}
			if (schemaField.isList !== modelField.isList) {
				issues.push(
					`${name}.${field}: list mismatch -- schema.graphql says ${schemaField.isList ? 'a list' : 'a scalar'}, src/model.ts says ${modelField.isList ? 'a list' : 'a scalar'}`,
				);
			}
			if (schemaField.scalar !== modelField.scalar) {
				issues.push(
					`${name}.${field}: type mismatch -- schema.graphql is ${schemaField.scalar}-like, src/model.ts is ${modelField.scalar}-like`,
				);
			}
		}
	}
	return issues;
}

// ─── tests ───────────────────────────────────────────────────────────────────

test('schema.graphql and src/model.ts agree on every @table type', () => {
	const schemaTables = parseSchemaTables(readFileSync(schemaPath, 'utf8'), 'schema.graphql');
	const project = snapshot.getDefaultProjectForFile(modelPath);
	assert.ok(project, 'could not resolve a TypeScript project for src/model.ts');
	const modelInterfaces = loadModelInterfaces(project, modelPath, 'src/model.ts');

	const issues = diffSchemaAndModel(schemaTables, modelInterfaces);
	assert.equal(issues.length, 0, `schema.graphql / src/model.ts drift:\n${issues.join('\n')}`);
});

test('an unparseable field declaration in the SDL fails loudly rather than passing silently', () => {
	const badSdl = 'type Foo @table(database: "x") @sealed {\n\tthis is not a valid field line\n}\n';
	assert.throws(() => parseSchemaTables(badSdl, 'inline-fixture'), /schemaMirror: could not parse a field declaration/);
});

test('an unrecognized scalar type in the SDL fails loudly rather than passing silently', () => {
	const badSdl = 'type Foo @table(database: "x") @sealed {\n\tbar: SomeMadeUpScalar\n}\n';
	assert.throws(() => parseSchemaTables(badSdl, 'inline-fixture'), /schemaMirror: unrecognized scalar type/);
});

test('a duplicate field name within one @table type fails loudly rather than silently keeping the last one', () => {
	const badSdl = 'type Foo @table(database: "x") @sealed {\n\tbar: String\n\tbar: Int\n}\n';
	assert.throws(() => parseSchemaTables(badSdl, 'inline-fixture'), /schemaMirror: duplicate field "bar" in type "Foo"/);
});

test('a TypeScript interface member this guard cannot classify fails loudly rather than passing silently', () => {
	const project = fixtureSnapshot.getDefaultProjectForFile(unsupportedMemberPath);
	assert.ok(project, 'could not resolve a TypeScript project for the fixture');
	assert.throws(() => loadModelInterfaces(project, unsupportedMemberPath, 'inline-fixture'), /non-property member/);
});

test('a non-exported interface in model.ts is not loaded, and does not need a matching @table', () => {
	// Before this guard skipped non-exported interfaces, NotATable's presence
	// alone made loadModelInterfaces() return it as if it were a table mirror,
	// and diffSchemaAndModel() then demanded a @table NotATable in
	// schema.graphql that has no reason to exist. Asserting the returned map's
	// contents (not just that this doesn't throw) is what makes this test able
	// to fail: a version that loaded NotATable but never diffed it against the
	// schema would pass a throws-only check but is still the bug.
	const project = fixtureSnapshot.getDefaultProjectForFile(nonExportedHelperPath);
	assert.ok(project, 'could not resolve a TypeScript project for the fixture');
	const interfaces = loadModelInterfaces(project, nonExportedHelperPath, 'inline-fixture');
	assert.ok(interfaces.has('Foo'), 'the exported interface must still be loaded');
	assert.ok(!interfaces.has('NotATable'), 'a non-exported interface must not be loaded');
});

test('a syntactically broken TypeScript file fails loudly rather than passing silently', () => {
	const project = fixtureSnapshot.getDefaultProjectForFile(brokenSyntaxPath);
	assert.ok(project, 'could not resolve a TypeScript project for the fixture');
	assert.throws(() => loadModelInterfaces(project, brokenSyntaxPath, 'inline-fixture'), /syntax errors/);
});
