// CSV serialization for the export endpoint. Two hazards, handled here so no call
// site has to remember them:
// 1. RFC 4180 quoting: a comma, quote or newline inside a value must be quoted with
//    internal quotes doubled.
// 2. Formula injection: spreadsheets execute a cell beginning with =, +, -, @, tab
//    or CR, and order names, SKUs and carriers are merchant-controlled. An
//    apostrophe prefix makes it inert text.

export const MAX_EXPORT_ROWS = 5000;

const NEEDS_QUOTING = /[",\r\n]/;
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
	if (value === undefined || value === null) return '';
	let text = String(value);
	if (FORMULA_START.test(text)) text = `'${text}`;
	if (NEEDS_QUOTING.test(text)) return `"${text.replace(/"/g, '""')}"`;
	return text;
}

export function csvRow(values: unknown[]): string {
	return values.map(csvCell).join(',');
}

// CRLF per RFC 4180.
export function toCsv(headers: string[], rows: unknown[][]): string {
	return [csvRow(headers), ...rows.map(csvRow)].join('\r\n') + '\r\n';
}

// Separate from the API field allowlists: an export is a document the merchant
// keeps, so widening the API must not silently widen what leaves in a file.
export const EXPORT_COLUMNS: Record<'events' | 'findings' | 'orders', Array<{ header: string; field: string }>> = {
	events: [
		{ header: 'Occurred at', field: 'occurredAt' },
		{ header: 'Received at', field: 'receivedAt' },
		{ header: 'Domain', field: 'domain' },
		{ header: 'Topic', field: 'topic' },
		{ header: 'Resource ID', field: 'resourceId' },
		{ header: 'Order name', field: 'orderName' },
		{ header: 'SKU', field: 'sku' },
		{ header: 'SKUs', field: 'skus' },
		{ header: 'Quantity', field: 'quantity' },
		{ header: 'State', field: 'state' },
		{ header: 'Location ID', field: 'locationId' },
		{ header: 'Source', field: 'source' },
		{ header: 'Event ID', field: 'eventId' },
	],
	findings: [
		{ header: 'Order name', field: 'orderName' },
		{ header: 'Order ID', field: 'orderId' },
		{ header: 'Detector', field: 'detector' },
		{ header: 'Status', field: 'status' },
		{ header: 'Paid at', field: 'paidAt' },
		{ header: 'Confirmation expected by', field: 'deadline' },
		{ header: 'Detected at', field: 'detectedAt' },
		{ header: 'Resolved at', field: 'resolvedAt' },
		{ header: 'Rule version', field: 'ruleVersion' },
		{ header: 'Finding ID', field: 'id' },
	],
	orders: [
		{ header: 'Order name', field: 'orderName' },
		{ header: 'Order ID', field: 'orderId' },
		{ header: 'Lane', field: 'state' },
		{ header: 'Paid at', field: 'paidAt' },
		{ header: 'Hours waiting', field: 'ageHours' },
		{ header: 'Value', field: 'orderTotal' },
		{ header: 'Currency', field: 'currency' },
		{ header: 'Fulfilled at', field: 'fulfilledAt' },
		{ header: 'Fulfillment attempt failed at', field: 'fulfillmentFailedAt' },
		{ header: 'Has tracking', field: 'hasTracking' },
		{ header: 'Carrier', field: 'trackingCompany' },
		{ header: 'Cancelled at', field: 'cancelledAt' },
		{ header: 'Fully refunded at', field: 'fullyRefundedAt' },
	],
};

// Sortable, and safe against path traversal and content-disposition injection.
export function exportFilename(kind: string, now: number): string {
	const safeKind = kind.replace(/[^a-z0-9-]/gi, '') || 'export';
	const day = new Date(now).toISOString().slice(0, 10);
	return `sightline-${safeKind}-${day}.csv`;
}

// Pages a query function until it is exhausted or `cap` rows are collected, and
// reports whether more existed. A cursor alone does not say so: a full last page still
// carries one (keysetPage), so a source of exactly `cap` rows ends on a cursor that
// leads nowhere. When the cap is reached with a cursor left, one more page is read and
// `truncated` is true only if it holds a row. `rows.length > cap` is not enough either:
// the cap is a multiple of the page size, so a truncated set lands on exactly `cap`.
export async function collectExportRows<T>(
	fetchPage: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor?: string }>,
	cap: number,
	initialCursor?: string,
): Promise<{ rows: T[]; truncated: boolean }> {
	const rows: T[] = [];
	let cursor = initialCursor;
	let stuck = false;
	do {
		const page = await fetchPage(cursor);
		rows.push(...page.items);
		// A pager returning the cursor it was given is not advancing; stop rather than
		// refetch the same page to the cap, and let `truncated` report that more may exist.
		if (page.nextCursor !== undefined && page.nextCursor === cursor) {
			stuck = true;
			break;
		}
		cursor = page.nextCursor;
	} while (cursor && rows.length < cap);
	let truncated = stuck || rows.length > cap;
	if (!truncated && cursor) truncated = (await fetchPage(cursor)).items.length > 0;
	return { rows: rows.slice(0, cap), truncated };
}
