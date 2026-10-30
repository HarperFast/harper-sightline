import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkWebhookShop } from '../src/ingest/webhookShop.ts';

const known = new Set(['a.myshopify.com', 'b.myshopify.com']);
const isKnownShop = async (s: string) => known.has(s);
const check = (over: Partial<Parameters<typeof checkWebhookShop>[0]>) =>
	checkWebhookShop({ shopId: 'a.myshopify.com', topic: 'orders/create', body: { id: 1 }, requireKnownShop: true, isKnownShop, ...over });

test('a known shop with a body that does not name a shop is accepted for an event topic', async () => {
	assert.deepEqual(await check({}), { ok: true });
});

test('a malformed shop domain is rejected 400 before any lookup', async () => {
	let looked = false;
	for (const shopId of ['', 'evil.com', 'a.myshopify.com.evil.example', 'A.myshopify.com', 'a b.myshopify.com']) {
		const v = await check({
			shopId,
			isKnownShop: async () => {
				looked = true;
				return true;
			},
		});
		assert.deepEqual(v, { ok: false, status: 400, reason: 'invalid shop domain' }, shopId);
	}
	assert.equal(looked, false);
});

test('an unknown shop is rejected 404 so a delivery racing install is retried', async () => {
	assert.deepEqual(await check({ shopId: 'c.myshopify.com' }), { ok: false, status: 404, reason: 'unknown shop' });
});

test('a body naming a different shop than the header is rejected, for either field', async () => {
	for (const field of ['myshopify_domain', 'shop_domain']) {
		const v = await check({ body: { [field]: 'b.myshopify.com' } });
		assert.deepEqual(v, { ok: false, status: 400, reason: 'shop domain mismatch' });
	}
	assert.equal((await check({ body: { myshopify_domain: 'a.myshopify.com', shop_domain: 'b.myshopify.com' } })).ok, false);
	assert.equal((await check({ body: { myshopify_domain: 42 } })).ok, false);
	assert.equal((await check({ body: { myshopify_domain: 'a.myshopify.com' } })).ok, true);
});

test('a signed app/uninstalled body replayed under another shop header is rejected', async () => {
	const signedBodyForA = { id: 1, myshopify_domain: 'a.myshopify.com' };
	const v = await check({ shopId: 'b.myshopify.com', topic: 'app/uninstalled', body: signedBodyForA });
	assert.deepEqual(v, { ok: false, status: 400, reason: 'shop domain mismatch' });
	assert.equal((await check({ topic: 'app/uninstalled', body: signedBodyForA })).ok, true);
});

test('an event body replayed with its topic header swapped to app/uninstalled is rejected', async () => {
	const v = await check({ topic: 'app/uninstalled', body: { id: 99, line_items: [] } });
	assert.deepEqual(v, { ok: false, status: 400, reason: 'webhook body does not name its shop' });
	assert.equal((await check({ topic: 'app/uninstalled', body: 'nope' })).ok, false);
	assert.equal((await check({ topic: 'app/uninstalled', body: null })).ok, false);
});

test('compliance topics bind to the body and tolerate an already-redacted shop', async () => {
	for (const topic of ['shop/redact', 'customers/redact', 'customers/data_request']) {
		const own = { ...SHAPES[topic], shop_domain: 'gone.myshopify.com' };
		const args = { topic, requireKnownShop: false, shopId: 'gone.myshopify.com' };
		assert.deepEqual(await check({ ...args, body: own }), { ok: true }, topic);
		assert.equal((await check({ ...args, body: { ...own, shop_domain: 'a.myshopify.com' } })).ok, false, topic);
		assert.equal((await check({ ...args, body: {} })).ok, false, topic);
	}
});

test('a swapped header on a signed shop/redact body cannot redact another tenant', async () => {
	const v = await check({
		topic: 'shop/redact',
		requireKnownShop: false,
		shopId: 'b.myshopify.com',
		body: { shop_id: 1, shop_domain: 'a.myshopify.com' },
	});
	assert.equal(v.ok, false);
});

const SHAPES: Record<string, Record<string, unknown>> = {
	'app/uninstalled': { id: 1, myshopify_domain: 'a.myshopify.com', domain: 'a.example' },
	'shop/redact': { shop_id: 1, shop_domain: 'a.myshopify.com' },
	'customers/redact': { shop_id: 1, shop_domain: 'a.myshopify.com', customer: { id: 2 }, orders_to_redact: [3] },
	'customers/data_request': {
		shop_id: 1,
		shop_domain: 'a.myshopify.com',
		customer: { id: 2 },
		orders_requested: [3],
		data_request: { id: 4 },
	},
};

test('each real topic shape is accepted under its own topic', async () => {
	for (const [topic, body] of Object.entries(SHAPES)) {
		assert.equal((await check({ topic, body, requireKnownShop: false })).ok, true, topic);
	}
});

test('a body of one lifecycle or compliance topic is rejected under every other topic', async () => {
	for (const [real, body] of Object.entries(SHAPES)) {
		for (const claimed of Object.keys(SHAPES)) {
			if (claimed === real) continue;
			const v = await check({ topic: claimed, body, requireKnownShop: false });
			assert.ok(!v.ok && v.status === 400, `${real} replayed as ${claimed}`);
		}
	}
});

test('a compliance body replayed as app/uninstalled for the same shop is rejected', async () => {
	const v = await check({ topic: 'app/uninstalled', body: SHAPES['customers/data_request'] });
	assert.equal(v.ok, false);
});
