import { AuditEvents } from './db.ts';

// Append a security/lifecycle audit event (no payload/PII). The id is caller-
// chosen so compliance handlers can key it by webhook id, making a Shopify retry
// idempotent (same id → upsert, not a duplicate row).
export async function writeAudit(id: string, shopId: string, action: string, at: number, detail?: Record<string, unknown>): Promise<void> {
	await AuditEvents.put({ id, shopId, action, at, detail: detail ? JSON.stringify(detail) : undefined });
}
