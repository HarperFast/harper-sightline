import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optionalSecret, requiredSecret, MissingSecretError } from '../src/secrets/secretsPolicy.ts';
import { readShopifySecret } from '../src/secrets/readSecret.ts';
import { encryptToken, decryptToken } from '../src/secrets/crypto.ts';
import { secrets } from '#harper';

// This suite covers the fail-closed secret policy that replaced
// `requireRealSecrets()` and its two dev fallbacks (a hardcoded `shpss_…` app
// secret and a `sha256('sightline-dev-token-key')` AES key). The property under
// test is now the ABSENCE of a fallback: every one of these reads must throw
// rather than return something weak.
//
// The Harper-secrets branch is exercised here for the first time. It used to sit
// behind a dynamic `import('harper')` that threw under `node --test`, so the
// production read path had no offline coverage at all — only the env and
// dev-constant branches did. `#harper` resolves to test/harperStub.ts under
// `--conditions=test`, whose `secrets` export is a plain mutable object.

// Save/restore BOTH sources this suite mutates, so nothing leaks between tests.
function withSecrets(vars: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> {
	const prevEnv: Record<string, string | undefined> = {};
	const prevStore: Record<string, string | undefined> = {};
	for (const k of Object.keys(vars)) {
		prevEnv[k] = process.env[k];
		prevStore[k] = secrets[k];
	}
	for (const [k, v] of Object.entries(vars)) {
		delete secrets[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	return Promise.resolve(fn()).finally(() => {
		for (const k of Object.keys(vars)) {
			if (prevEnv[k] === undefined) delete process.env[k];
			else process.env[k] = prevEnv[k];
			if (prevStore[k] === undefined) delete secrets[k];
			else secrets[k] = prevStore[k];
		}
	});
}

// Put a value in the Harper store only, with the env deliberately empty, to prove
// the store branch is what answered.
function withStoreOnly(vars: Record<string, string>, fn: () => void | Promise<void>): Promise<void> {
	return withSecrets(Object.fromEntries(Object.keys(vars).map((k) => [k, undefined])), () => {
		Object.assign(secrets, vars);
		return Promise.resolve(fn()).finally(() => {
			for (const k of Object.keys(vars)) delete secrets[k];
		});
	});
}

test('a scoped Harper secret is read without any environment variable present', async () => {
	await withStoreOnly({ SIGHTLINE_TEST_SECRET: 'from-the-store' }, () => {
		assert.equal(requiredSecret('SIGHTLINE_TEST_SECRET'), 'from-the-store');
		assert.equal(process.env.SIGHTLINE_TEST_SECRET, undefined, 'a scoped secret must never land in process.env');
	});
});

test('the Harper store wins over the environment', async () => {
	await withSecrets({ SIGHTLINE_TEST_SECRET: 'from-the-env' }, () => {
		secrets.SIGHTLINE_TEST_SECRET = 'from-the-store';
		try {
			assert.equal(requiredSecret('SIGHTLINE_TEST_SECRET'), 'from-the-store');
		} finally {
			delete secrets.SIGHTLINE_TEST_SECRET;
		}
	});
});

test('the environment is the fallback when the store has no row', async () => {
	await withSecrets({ SIGHTLINE_TEST_SECRET: 'from-the-env' }, () => {
		assert.equal(requiredSecret('SIGHTLINE_TEST_SECRET'), 'from-the-env');
	});
});

test('whitespace-only and empty values count as absent, not as a value', async () => {
	// A secret pasted with a trailing newline, or an env var set to '', used to be
	// truthy enough to be used and then fail as an authentication error somewhere
	// far away.
	await withSecrets({ SIGHTLINE_TEST_SECRET: '   ' }, () => {
		assert.throws(() => requiredSecret('SIGHTLINE_TEST_SECRET'), MissingSecretError);
		assert.equal(optionalSecret('SIGHTLINE_TEST_SECRET'), undefined);
	});
});

test('surrounding whitespace is trimmed off a real value', async () => {
	await withSecrets({ SIGHTLINE_TEST_SECRET: '  shpss_value\n' }, () => {
		assert.equal(requiredSecret('SIGHTLINE_TEST_SECRET'), 'shpss_value');
	});
});

test('optionalSecret returns undefined where requiredSecret throws', async () => {
	await withSecrets({ SIGHTLINE_TEST_SECRET: undefined }, () => {
		assert.equal(optionalSecret('SIGHTLINE_TEST_SECRET'), undefined);
		assert.throws(() => requiredSecret('SIGHTLINE_TEST_SECRET'), MissingSecretError);
	});
});

test('the missing-secret error names the secret and the three Harper failure reasons', async () => {
	// The message is the whole diagnostic surface for a deploy that will not serve,
	// and on this cluster `custody-unavailable` is the overwhelmingly likely cause.
	await withSecrets({ SHOPIFY_API_SECRET: undefined }, async () => {
		await assert.rejects(
			() => readShopifySecret(),
			(e: unknown) => {
				assert.ok(e instanceof MissingSecretError);
				assert.match(e.message, /SHOPIFY_API_SECRET/);
				assert.match(e.message, /ungranted/);
				assert.match(e.message, /custody-unavailable/);
				return true;
			},
		);
	});
});

test('readShopifySecret has no fallback left — an unconfigured app secret throws', async () => {
	// The pre-change behaviour: this returned a hardcoded `shpss_…` constant, so
	// webhook HMAC verification silently ran on a secret published in git.
	await withSecrets({ SHOPIFY_API_SECRET: undefined }, async () => {
		await assert.rejects(() => readShopifySecret(), MissingSecretError);
	});
});

test('readShopifySecret reads the scoped secret in preference to the environment', async () => {
	await withStoreOnly({ SHOPIFY_API_SECRET: 'shpss_from_store' }, async () => {
		assert.equal(await readShopifySecret(), 'shpss_from_store');
	});
});

test('token encryption has no fallback key — an unconfigured key throws both ways', async () => {
	// The pre-change behaviour: encryption proceeded under
	// sha256('sightline-dev-token-key'), a key derivable by anyone reading the file.
	await withSecrets({ SIGHTLINE_TOKEN_KEY: undefined }, () => {
		assert.throws(() => encryptToken('shpat_token'), MissingSecretError);
		assert.throws(() => decryptToken({ v: 1, iv: 'AAAA', tag: 'AAAA', ct: 'AAAA' }), MissingSecretError);
	});
});

test('a wrong-shaped token key is rejected as its own failure, not ignored', async () => {
	// Previously an invalid key silently fell through to the dev key, so a truncated
	// paste produced tokens encrypted under a key nobody intended and said nothing.
	await withSecrets({ SIGHTLINE_TOKEN_KEY: 'abc123' }, () => {
		assert.throws(
			() => encryptToken('shpat_token'),
			(e: unknown) => {
				assert.ok(e instanceof MissingSecretError);
				assert.match(e.message, /64 hex characters/);
				return true;
			},
		);
	});
	// Non-hex characters at the right length are just as wrong as the wrong length.
	await withSecrets({ SIGHTLINE_TOKEN_KEY: 'z'.repeat(64) }, () => {
		assert.throws(() => encryptToken('shpat_token'), MissingSecretError);
	});
});

test('a token round-trips under a key supplied by the Harper store alone', async () => {
	await withStoreOnly({ SIGHTLINE_TOKEN_KEY: 'a'.repeat(64) }, () => {
		const env = encryptToken('shpat_secret_value');
		assert.equal(env.v, 1);
		assert.notEqual(env.ct, 'shpat_secret_value');
		assert.equal(decryptToken(env), 'shpat_secret_value');
	});
});

test('a token encrypted under one key does not decrypt under another', async () => {
	// Pins the consequence documented in crypto.ts: rotating SIGHTLINE_TOKEN_KEY is
	// a data migration, not a config change. There is no dual-key decrypt path, so
	// a rotation invalidates every stored token until one exists.
	let envelope: ReturnType<typeof encryptToken>;
	await withSecrets({ SIGHTLINE_TOKEN_KEY: 'a'.repeat(64) }, () => {
		envelope = encryptToken('shpat_token');
	});
	await withSecrets({ SIGHTLINE_TOKEN_KEY: 'b'.repeat(64) }, () => {
		assert.throws(() => decryptToken(envelope));
	});
});
