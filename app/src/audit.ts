import { AuditEvents } from './db.ts';

// Appends an audit event (no payload or PII). The id is caller-chosen so compliance
// handlers can key it by webhook id and a Shopify retry upserts.
export async function writeAudit(id: string, shopId: string, action: string, at: number, detail?: Record<string, unknown>): Promise<void> {
	await AuditEvents.put({ id, shopId, action, at, detail: detail ? JSON.stringify(detail) : undefined });
}
