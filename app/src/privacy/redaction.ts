import { countMatching, deleteMatchingKeys, type PurgeableTable } from '../retention/retention.ts';

// Compliance deletion (ADR-003 §3): targeted DELETEs that remove data and index
// entries, idempotent (a re-run finds nothing and deletes 0).

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
			// Verifies erasure (ADR-003 §4).
			const residue = await countMatching(target.table, condition, undefined, target.keyField, 1);
			if (residue > 0) failures.push(`${target.name}: shop ${shopId} records remain after redaction`);
		} catch (err) {
			failures.push(`${target.name}: ${(err as Error).message}`);
		}
	}
	return { deleted, byTable, failures };
}

// Removes records linked to the given order ids (the webhook's `orders_to_redact`).
// Order linkage is the only customer-scoped key we hold, so tables without it are skipped.
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
