import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectExportRows, csvCell, csvRow, EXPORT_COLUMNS, exportFilename, MAX_EXPORT_ROWS, toCsv } from '../src/csv.ts';

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

test('an array cell round-trips as a quoted, comma-joined field', () => {
	// csvCell stringifies via String(...), which joins an array with commas —
	// already quote-safe, since csvCell quotes anything containing a comma.
	assert.equal(csvCell(['TSHIRT-BLK-M', 'STICKER-PK']), '"TSHIRT-BLK-M,STICKER-PK"');
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

// A fake pager over fixed-size pages of a fixed-length source, mirroring the
// shape of listEvents/listFindings/listOrders: each call returns the next
// `pageSize` items and a nextCursor iff more remain.
function fakePager(total: number, pageSize: number) {
	return async (cursor: string | undefined) => {
		const offset = cursor ? Number(cursor) : 0;
		const items = Array.from({ length: Math.min(pageSize, total - offset) }, (_, i) => offset + i);
		const end = offset + items.length;
		return { items, nextCursor: end < total ? String(end) : undefined };
	};
}

test('collectExportRows: exhausted below the cap is not truncated', async () => {
	const { rows, truncated } = await collectExportRows(fakePager(3, 2), 5);
	assert.deepEqual(rows, [0, 1, 2]);
	assert.equal(truncated, false);
});

test('collectExportRows: landing exactly on the cap with more data available IS truncated', async () => {
	// The bug this guards: MAX_EXPORT_ROWS (5000) is an exact multiple of the
	// page size (MAX_LIMIT=100), so a truncated real export always accumulates
	// to EXACTLY the cap, never past it. A `rows.length > cap` check is false
	// here — the one case it must catch.
	const { rows, truncated } = await collectExportRows(fakePager(10, 2), 4);
	assert.deepEqual(rows, [0, 1, 2, 3]);
	assert.equal(truncated, true);
});

test('collectExportRows: exhausted exactly at the cap, with no more data, is not truncated', async () => {
	// Pins the fix at the right moment: reading `cursor` after the loop must see
	// the falsy value from the FINAL page, not a stale truthy value from an
	// earlier one.
	const { rows, truncated } = await collectExportRows(fakePager(4, 2), 4);
	assert.deepEqual(rows, [0, 1, 2, 3]);
	assert.equal(truncated, false);
});
