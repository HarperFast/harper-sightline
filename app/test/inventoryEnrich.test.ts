import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENRICH_BATCH, inventoryItemRow, locationRow, skuRowsForInventoryEvent, unresolvedIds } from '../src/inventoryEnrich.ts';
import type { OperationalEvent } from '../src/model.ts';

const NOW = 1_775_000_000_000;

test('unresolved ids are distinct, exclude already-resolved items, and are capped', () => {
	const events = [{ resourceId: 'i1' }, { resourceId: 'i2' }, { resourceId: 'i1' }, { resourceId: undefined }];
	assert.deepEqual(unresolvedIds(events, new Set(['i2'])), ['i1']);
	const many = Array.from({ length: ENRICH_BATCH + 10 }, (_u, i) => ({ resourceId: `i${i}` }));
	assert.equal(unresolvedIds(many, new Set()).length, ENRICH_BATCH);
});

test('an inventory item row is keyed by shop and item and carries the product facts', () => {
	const row = inventoryItemRow('s1', { inventoryItemId: 'i1', sku: 'TSHIRT', productTitle: 'T-Shirt', variantTitle: 'M / Black' }, NOW);
	assert.equal(row.id, 's1:i1');
	assert.equal(row.shopId, 's1');
	assert.equal(row.sku, 'TSHIRT');
	assert.equal(row.productTitle, 'T-Shirt');
	assert.equal(row.variantTitle, 'M / Black');
	assert.equal(row.updatedAt, NOW);
});

test('a location row is keyed by shop and location', () => {
	const row = locationRow('s1', { locationId: 'l1', name: 'Brooklyn' }, NOW);
	assert.equal(row.id, 's1:l1');
	assert.equal(row.name, 'Brooklyn');
});

test('an enriched inventory event gets exactly one SKU index row', () => {
	const event: OperationalEvent = {
		eventId: 's1:w9',
		shopId: 's1',
		domain: 'inventory',
		topic: 'inventory_levels/update',
		resourceId: 'i1',
		quantity: 4,
		source: 'webhook',
		occurredAt: NOW,
		receivedAt: NOW,
	};
	const rows = skuRowsForInventoryEvent(event, 'TSHIRT');
	assert.equal(rows.length, 1);
	assert.equal(rows[0].id, 's1:w9:TSHIRT');
	assert.equal(rows[0].sku, 'TSHIRT');
	assert.equal(rows[0].domain, 'inventory');
	assert.equal(rows[0].receivedAt, NOW);
});
