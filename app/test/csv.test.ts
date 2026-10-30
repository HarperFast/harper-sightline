import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectExportRows, csvCell, csvRow, EXPORT_COLUMNS, exportFilename, MAX_EXPORT_ROWS, toCsv } from '../src/api/csv.ts';

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

test('collectExportRows: a pager that stops advancing is not followed to the cap', async () => {
	// Insurance against any pager that hands back the cursor it was just given. A
	// real one did: listOrders keyset on the nullable `paidAt`, so an unpaid row
	// produced an undecodable cursor and every page came back identical — a
	// five-order store exported 5000 duplicate rows with a "narrow your filters"
	// alert. That specific cause is fixed at the source (queries.ts keysets on
	// lastEventAt, and keysetPage never emits a cursor it cannot decode); this keeps
	// the export loop safe regardless.
	let calls = 0;
	const stuck = async (_cursor: string | undefined) => {
		calls++;
		return { items: [1, 2], nextCursor: 'same' };
	};
	const { rows, truncated } = await collectExportRows(stuck, 5000);
	assert.deepEqual(rows, [1, 2, 1, 2], 'one advance, then the repeat is detected and the loop stops');
	assert.equal(calls, 2);
	// The source stopped making progress, so "there may be more" is the honest answer.
	assert.equal(truncated, true);
});

// A big-shop export is ~50 pages. Each page's query and hydration resolve as microtasks,
// so without a macrotask break between pages the whole export ran as one turn of the
// event loop: 13 s during which no webhook on that thread could be acked.
test('collectExportRows: yields to the event loop between pages', async () => {
	let macrotasks = 0;
	let stop = false;
	const spin = () => {
		if (stop) return;
		macrotasks++;
		setImmediate(spin);
	};
	setImmediate(spin);
	const seen: number[] = [];
	const pager = fakePager(10, 2);
	await collectExportRows(async (cursor) => {
		seen.push(macrotasks);
		return pager(cursor);
	}, 4);
	stop = true;
	assert.equal(seen.length, 3, 'two pages plus the truncation probe');
	for (let i = 1; i < seen.length; i++) assert.ok(seen[i] > seen[i - 1], `the event loop ran before page ${i + 1}`);
});

test('collectExportRows: exhausted exactly at the cap, with no more data, is not truncated', async () => {
	// Pins the fix at the right moment: reading `cursor` after the loop must see
	// the falsy value from the FINAL page, not a stale truthy value from an
	// earlier one.
	const { rows, truncated } = await collectExportRows(fakePager(4, 2), 4);
	assert.deepEqual(rows, [0, 1, 2, 3]);
	assert.equal(truncated, false);
});

// keysetPage hands out a cursor whenever a page is full, so a source of exactly `cap`
// rows still ends on a cursor that leads to an empty page.
function fullPageCursorPager(total: number, pageSize: number) {
	return async (cursor: string | undefined) => {
		const offset = cursor ? Number(cursor) : 0;
		const items = Array.from({ length: Math.min(pageSize, total - offset) }, (_, i) => offset + i);
		return { items, nextCursor: items.length === pageSize ? String(offset + items.length) : undefined };
	};
}

test('collectExportRows: exactly the cap, with a full-page cursor on the last page, is not truncated', async () => {
	const { rows, truncated } = await collectExportRows(fullPageCursorPager(4, 2), 4);
	assert.deepEqual(rows, [0, 1, 2, 3]);
	assert.equal(truncated, false);
});

test('collectExportRows: one row past the cap IS truncated, and the extra row is not returned', async () => {
	const { rows, truncated } = await collectExportRows(fullPageCursorPager(5, 2), 4);
	assert.deepEqual(rows, [0, 1, 2, 3]);
	assert.equal(truncated, true);
});

test('collectExportRows: one row below the cap is not truncated', async () => {
	const { rows, truncated } = await collectExportRows(fullPageCursorPager(3, 2), 4);
	assert.deepEqual(rows, [0, 1, 2]);
	assert.equal(truncated, false);
});
