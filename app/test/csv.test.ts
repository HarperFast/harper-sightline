import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, csvRow, EXPORT_COLUMNS, exportFilename, MAX_EXPORT_ROWS, toCsv } from '../src/csv.ts';

test('plain values are unquoted', () => {
	assert.equal(csvCell('TSHIRT'), 'TSHIRT');
	assert.equal(csvCell(42), '42');
	assert.equal(csvCell(true), 'true');
});

test('absent values are empty, never the string undefined', () => {
	assert.equal(csvCell(undefined), '');
	assert.equal(csvCell(null), '');
});

test('commas, quotes and newlines are RFC 4180 quoted', () => {
	assert.equal(csvCell('a,b'), '"a,b"');
	assert.equal(csvCell('say "hi"'), '"say ""hi"""');
	assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
});

test('formula-injection payloads are neutralized so a spreadsheet cannot execute them', () => {
	// A cell beginning =, +, -, @, tab or CR is executed as a formula by Excel and
	// Sheets. Prefixing with an apostrophe makes it inert text without losing data.
	assert.equal(csvCell('=1+1'), "'=1+1");
	assert.equal(csvCell('+1'), "'+1");
	assert.equal(csvCell('-1'), "'-1");
	assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
	assert.equal(csvCell('=HYPERLINK("http://evil","x")'), '"\'=HYPERLINK(""http://evil"",""x"")"');
});

test('rows join with commas and the document uses CRLF line endings', () => {
	assert.equal(csvRow(['a', 'b']), 'a,b');
	assert.equal(toCsv(['h1', 'h2'], [['a', 'b']]), 'h1,h2\r\na,b\r\n');
});

test('a header-only document is produced for an empty result set', () => {
	assert.equal(toCsv(['h1'], []), 'h1\r\n');
});

test('every export kind has columns and the row cap is bounded', () => {
	for (const kind of ['events', 'findings', 'orders'] as const) {
		assert.ok(EXPORT_COLUMNS[kind].length > 0);
	}
	assert.equal(MAX_EXPORT_ROWS, 5000);
});

test('filenames are stable, sortable, and safe', () => {
	const name = exportFilename('findings', Date.parse('2026-08-07T12:34:56Z'));
	assert.equal(name, 'sightline-findings-2026-08-07.csv');
	assert.doesNotMatch(exportFilename('../etc/passwd', 0), /\.\.|\//);
});
