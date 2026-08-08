import { EVENT_FIELDS } from './apiContract.ts';

// CSV serialization for the export endpoint.
//
// Two hazards, both handled here so no call site has to remember them:
//
// 1. RFC 4180 quoting — a comma, quote, or newline inside a value must be quoted
//    and internal quotes doubled, or the file silently corrupts on import.
// 2. Formula injection — Excel and Google Sheets EXECUTE a cell that begins with
//    =, +, -, @, tab, or CR. Our data comes from Shopify payloads (order names,
//    SKUs, carriers are all merchant-controlled strings), so an exported file
//    could otherwise carry an executable payload into a finance team's
//    spreadsheet. Prefixing with an apostrophe makes it inert text and loses
//    nothing.

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

// CRLF per RFC 4180 — the form every spreadsheet accepts, including on Windows.
export function toCsv(headers: string[], rows: unknown[][]): string {
	return [csvRow(headers), ...rows.map(csvRow)].join('\r\n') + '\r\n';
}

// Exported columns per list. Deliberately a separate map from the API field
// allowlists: an export is a document a merchant keeps, so its column order and
// headings are a product decision, and widening the API cannot silently widen
// what leaves in a file.
export const EXPORT_COLUMNS: Record<'events' | 'findings' | 'orders', Array<{ header: string; field: string }>> = {
	events: [
		{ header: 'Occurred at', field: 'occurredAt' },
		{ header: 'Received at', field: 'receivedAt' },
		{ header: 'Domain', field: 'domain' },
		{ header: 'Topic', field: 'topic' },
		{ header: 'Resource ID', field: 'resourceId' },
		{ header: 'Order name', field: 'orderName' },
		{ header: 'SKU', field: 'sku' },
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

// Sortable, and stripped of anything that could traverse a path or confuse a
// content-disposition header.
export function exportFilename(kind: string, now: number): string {
	const safeKind = kind.replace(/[^a-z0-9-]/gi, '') || 'export';
	const day = new Date(now).toISOString().slice(0, 10);
	return `sightline-${safeKind}-${day}.csv`;
}

// The events export needs the same field set the API exposes, so a column added
// to EXPORT_COLUMNS.events that the API does not allowlist fails loudly in tests
// rather than exporting an empty column.
export const EXPORTABLE_EVENT_FIELDS: readonly string[] = EVENT_FIELDS;
