import { countMatching, deleteMatchingKeys, type PurgeableTable } from '../retention/retention.ts';

// Compliance deletion (ADR-003 §3, Shopify shop/redact + customers/redact). Both
// are targeted DELETEs — data and index entries physically removed — and
// idempotent: re-running finds nothing and deletes 0. The HTTP webhook wiring
// lives in #21; this module is the deletion primitive it calls.

export interface RedactTarget {
	name: string;
	keyField: string; // primary-key attribute
	shopField: string; // tenant attribute (always 'shopId' for our tables)
	orderField?: string; // order-linkage attribute for customer redaction (e.g. resourceId | orderId); absent = not order-linked
	table: PurgeableTable;
}

export interface RedactResult {
	deleted: number;
	byTable: Record<string, number>;
	failures: string[];
}

// shop/redact: remove every record belonging to a shop. Sightline stores no
// customer PII, so a shop's entire footprint is keyed by shopId.
export async function redactShop(targets: RedactTarget[], shopId: string): Promise<RedactResult> {
	const byTable: Record<string, number> = {};
	const failures: string[] = [];
	let deleted = 0;
	for (const target of targets) {
		try {
			const condition = [{ attribute: target.shopField, value: shopId, comparator: 'equals' }];
			const n = await deleteMatchingKeys(target.table, target.keyField, condition);
			byTable[target.name] = n;
			deleted += n;
			// Verify erasure (ADR-003 §4) — compliance deletion is proven, not assumed.
			const residue = await countMatching(target.table, condition, undefined, target.keyField, 1);
			if (residue > 0) failures.push(`${target.name}: shop ${shopId} records remain after redaction`);
		} catch (err) {
			failures.push(`${target.name}: ${(err as Error).message}`);
		}
	}
	return { deleted, byTable, failures };
}

// customers/redact: remove records linked to the given order ids (the webhook's
// `orders_to_redact`). We hold no customer identifier — order linkage is the only
// customer-scoped key we have — so redaction targets order-linked rows for the
// shop. Tables without an order linkage are skipped.
export async function redactOrders(targets: RedactTarget[], shopId: string, orderIds: string[]): Promise<RedactResult> {
	const byTable: Record<string, number> = {};
	const failures: string[] = [];
	let deleted = 0;
	for (const target of targets) {
		if (!target.orderField) continue;
		try {
			let n = 0;
			for (const orderId of orderIds) {
				const condition = [
					{ attribute: target.shopField, value: shopId, comparator: 'equals' },
					{ attribute: target.orderField, value: orderId, comparator: 'equals' },
				];
				n += await deleteMatchingKeys(target.table, target.keyField, condition, 'and');
				const residue = await countMatching(target.table, condition, 'and', target.keyField, 1);
				if (residue > 0) failures.push(`${target.name}: order ${orderId} records remain after redaction`);
			}
			byTable[target.name] = n;
			deleted += n;
		} catch (err) {
			failures.push(`${target.name}: ${(err as Error).message}`);
		}
	}
	return { deleted, byTable, failures };
}
