import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopedFilter } from '../src/tenant.ts';
import type { Principal } from '../src/principal.ts';

const principal: Principal = { shopId: 'demo-shop.myshopify.com', userId: '42', roles: [], source: 'shopify-session' };

test('scopes a query to the principal shop', () => {
	assert.deepEqual(scopedFilter(principal, { state: 'unconfirmed' }), {
		state: 'unconfirmed',
		shopId: 'demo-shop.myshopify.com',
	});
});

test('overrides a caller-supplied shopId (cross-tenant guard)', () => {
	const r = scopedFilter(principal, { shopId: 'evil-shop.myshopify.com', state: 'x' } as Record<string, unknown>);
	assert.equal(r.shopId, 'demo-shop.myshopify.com');
});

test('injects shopId even with no filters', () => {
	assert.deepEqual(scopedFilter(principal), { shopId: 'demo-shop.myshopify.com' });
});
