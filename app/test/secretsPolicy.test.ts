import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireRealSecrets, InsecureSecretError } from '../src/secrets/secretsPolicy.ts';
import { readShopifySecret } from '../src/secrets/readSecret.ts';
import { encryptToken } from '../src/secrets/crypto.ts';

// Save/restore the env this suite mutates so it can't leak into other tests.
function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> {
	const prev: Record<string, string | undefined> = {};
	for (const k of Object.keys(vars)) prev[k] = process.env[k];
	Object.assign(process.env, vars);
	for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k];
	return Promise.resolve(fn()).finally(() => {
		for (const [k, v] of Object.entries(prev)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});
}

test('requireRealSecrets is off unless SIGHTLINE_REQUIRE_SECRETS=1', async () => {
	await withEnv({ SIGHTLINE_REQUIRE_SECRETS: undefined }, () => assert.equal(requireRealSecrets(), false));
	await withEnv({ SIGHTLINE_REQUIRE_SECRETS: '0' }, () => assert.equal(requireRealSecrets(), false));
	await withEnv({ SIGHTLINE_REQUIRE_SECRETS: '1' }, () => assert.equal(requireRealSecrets(), true));
});

test('readShopifySecret falls back to the dev constant when strict mode is off', async () => {
	await withEnv({ SIGHTLINE_REQUIRE_SECRETS: undefined, SHOPIFY_API_SECRET: undefined }, async () => {
		const secret = await readShopifySecret();
		assert.ok(secret.length > 0);
	});
});

test('readShopifySecret prefers the env secret over the dev fallback', async () => {
	await withEnv({ SIGHTLINE_REQUIRE_SECRETS: '1', SHOPIFY_API_SECRET: 'shpss_real_env_secret' }, async () => {
		assert.equal(await readShopifySecret(), 'shpss_real_env_secret');
	});
});

test('readShopifySecret fails closed when strict mode is on and only the dev fallback remains', async () => {
	await withEnv({ SIGHTLINE_REQUIRE_SECRETS: '1', SHOPIFY_API_SECRET: undefined }, async () => {
		await assert.rejects(() => readShopifySecret(), InsecureSecretError);
	});
});

test('crypto uses the provided key when SIGHTLINE_TOKEN_KEY is a valid 32-byte hex', async () => {
	await withEnv({ SIGHTLINE_REQUIRE_SECRETS: '1', SIGHTLINE_TOKEN_KEY: 'a'.repeat(64) }, () => {
		const env = encryptToken('shpat_token');
		assert.equal(env.v, 1);
		assert.ok(env.ct.length > 0);
	});
});

test('crypto fails closed when strict mode is on and no real key is configured', async () => {
	await withEnv({ SIGHTLINE_REQUIRE_SECRETS: '1', SIGHTLINE_TOKEN_KEY: undefined }, () => {
		assert.throws(() => encryptToken('shpat_token'), InsecureSecretError);
	});
});

test('crypto uses the dev key fallback when strict mode is off', async () => {
	await withEnv({ SIGHTLINE_REQUIRE_SECRETS: undefined, SIGHTLINE_TOKEN_KEY: undefined }, () => {
		const env = encryptToken('shpat_token');
		assert.ok(env.ct.length > 0);
	});
});
