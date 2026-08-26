import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shopPatchAfterExchange } from '../src/shopify/lifecycle.ts';
import type { Shop } from '../src/domain/model.ts';

const shop = (over: Partial<Shop> = {}): Shop => ({ shopId: 'demo-shop.myshopify.com', status: 'active', ...over });

const SCOPES = 'read_orders,read_fulfillments,read_inventory,read_products,read_locations';

// The defect this pins: the Privacy screen's "Granted access" field was empty on
// every managed install, because the scope list arrives with the token exchange and
// only `installShop` — the OAuth-callback path, which managed install never takes —
// recorded it. The screen then said "pending confirmation" forever, which reads to a
// merchant as a broken app rather than as a fact nobody was ever going to write.
test('a successful exchange records the granted scopes on the shop', () => {
	assert.deepEqual(shopPatchAfterExchange(shop(), SCOPES), { scopes: SCOPES });
});

test('an unchanged scope string is not a write', () => {
	assert.equal(shopPatchAfterExchange(shop({ scopes: SCOPES }), SCOPES), undefined);
});

test('a changed scope string is recorded, so a re-grant is not stale on the screen', () => {
	assert.deepEqual(shopPatchAfterExchange(shop({ scopes: 'read_orders' }), SCOPES), { scopes: SCOPES });
});

test('an empty scope from Shopify never erases what is already recorded', () => {
	assert.equal(shopPatchAfterExchange(shop({ scopes: SCOPES }), ''), undefined);
	assert.equal(shopPatchAfterExchange(shop(), ''), undefined);
});

test('the reauthorization state is lifted, and carries the scopes in the same write', () => {
	assert.deepEqual(shopPatchAfterExchange(shop({ status: 'reauthorization_required' }), SCOPES), {
		status: 'active',
		scopes: SCOPES,
	});
	assert.deepEqual(shopPatchAfterExchange(shop({ status: 'reauthorization_required', scopes: SCOPES }), SCOPES), {
		status: 'active',
	});
});

// An app load must never resurrect an uninstalled shop: its data is being erased,
// and flipping it back to active would put it back in the reconcile sweep.
test('an uninstalled shop is left alone', () => {
	assert.deepEqual(shopPatchAfterExchange(shop({ status: 'uninstalled' }), SCOPES), { scopes: SCOPES });
	assert.equal(shopPatchAfterExchange(shop({ status: 'uninstalled', scopes: SCOPES }), SCOPES), undefined);
});

test('no shop row means nothing to patch', () => {
	assert.equal(shopPatchAfterExchange(undefined, SCOPES), undefined);
});
