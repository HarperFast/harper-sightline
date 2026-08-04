# Spike A — Shopify Embedded Auth on Harper — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove, with runnable code, that Shopify's embedded session-token verification and expiring-offline-token exchange + atomic refresh rotation work on Harper v5.2.0 — the single highest architecture-invalidating risk in the MVP.

**Architecture:** A throwaway Harper application component under `spikes/auth/`. A pure, dependency-free session-JWT verifier (HS256 via `node:crypto`) is unit-tested exhaustively offline, then wired into a guarded Harper `Resource` that reads the app secret from Harper native secrets and returns a normalized `Principal`. A token-exchange module obtains an expiring offline token from the dev store; a `ShopCredential` table plus an optimistic-concurrency refresh proves atomic rotation. Findings land in ADR-001.

**Tech Stack:** Harper v5.2.0 (component runtime, Node 24.18.0 server-side), TypeScript via Node's native type stripping, `node:crypto`, `node:test`, global `fetch`. No third-party dependencies.

**Spec:** [Phase 0 risk-retirement spec](../specs/2026-08-04-phase-0-risk-retirement-design.md), Spike A. This plan covers Spike A only; Spikes B/C/D get their own plans.

## Global Constraints

Every task's requirements implicitly include these (from the Phase 0 spec and Harper engineering guidelines):

- **Throwaway, isolated:** all code lives under `spikes/auth/`; it is evidence, not the production scaffold, and is excluded from any eventual app build. Do not modify repo root config.
- **TypeStrip-compatible TS:** erasable syntax only, explicit `.ts` import extensions, named exports only, no enums, no parameter properties, tabs, semicolons, `node:` prefix for built-ins.
- **Runtime:** Harper **5.2.0**, Node **24.18.0** (aligned locally via nvm). Tests run with `node --test` (native type stripping, no ts build step).
- **Zero new dependencies** unless justified in `spikes/auth/dependencies.md`.
- **Secrets/PII discipline:** never log or return tokens, secrets, signatures, or customer data. The Shopify app secret is read from Harper native secrets (`SHOPIFY_API_SECRET`, granted to `sightline-spike-auth`), never a literal. Local tests use `process.env.SHOPIFY_API_SECRET`.
- **Errors:** throw descriptive `Error` subclasses; set `.statusCode` for HTTP mapping; preserve `cause`.
- **Fixed identifiers:** Shopify `client_id` (API key) = `e446bda5edb3ee3bae6e0ba280ef8b12`. Harper ops API = `https://ayoo.josh-test.harperfabric.com:9925/` (basic auth). Dev store domain confirmed in Task 4.

---

### Task 1: Bootstrap a runnable Harper spike component and pin the runtime shape

**Files:**
- Create: `spikes/auth/config.yaml`
- Create: `spikes/auth/schema.graphql`
- Create: `spikes/auth/resources.ts`
- Create: `spikes/auth/package.json`
- Create: `spikes/auth/RUNTIME-NOTES.md`
- Create: `spikes/auth/dependencies.md`
- Modify: repo `.gitignore` (add `spikes/**/.harper-local/` and local secret files)

**Interfaces:**
- Produces: a confirmed, documented answer (in `RUNTIME-NOTES.md`) to four questions every later task consumes: (a) exact import for the `Resource` base, (b) how a resource reads an HTTP request header, (c) how a resource reads a Harper secret at runtime (`secrets` accessor vs `process.env`), (d) the exact local run command and the HTTP port the component serves on.

- [ ] **Step 1: Create the minimal component files**

`spikes/auth/config.yaml`:
```yaml
rest: true
graphqlSchema:
  files: 'schema.graphql'
jsResource:
  files: 'resources.ts'
```

`spikes/auth/schema.graphql`:
```graphql
# Placeholder type so the schema file is non-empty; real tables come in Task 6.
type SpikePing @table @export {
	id: ID @primaryKey
}
```

`spikes/auth/resources.ts`:
```typescript
import { Resource } from 'harper';

export class Ping extends Resource {
	static async get() {
		return { ok: true, spike: 'auth', ts: Date.now() };
	}
}
```

`spikes/auth/package.json`:
```json
{
	"name": "sightline-spike-auth",
	"private": true,
	"type": "module",
	"scripts": {
		"test": "node --test test/"
	}
}
```

- [ ] **Step 2: Run the component locally and confirm it serves**

Run (from `spikes/auth/`): `harperdb run .` (or the CLI's component-run form — try `harperdb dev .` if `run` is unavailable).
Then in another shell: `curl -s http://localhost:9926/Ping` (try `9926`; if 404, list ports the CLI logged on startup).
Expected: JSON `{"ok":true,"spike":"auth",...}`.

- [ ] **Step 3: Confirm the four runtime facts and write them down**

By inspecting the running component and Harper docs/REPL, determine and record in `RUNTIME-NOTES.md`:
- The exact `Resource` base import and method signature that receives the request context.
- How to read a request header inside a resource method (e.g. `this.getContext()` / a `request`/`headers` argument — record the real API observed).
- Reading a secret: confirm whether `import { secrets } from 'harper'` exposes `secrets.SHOPIFY_API_SECRET` for a granted component, and the local fallback.
- The exact working run command and the HTTP port.

`spikes/auth/dependencies.md`: state "No third-party dependencies; uses node:crypto, node:test, global fetch (Node 24)."

- [ ] **Step 4: Commit**

```bash
git add spikes/auth .gitignore
git commit -m "spike(auth): bootstrap runnable Harper component + runtime notes"
```

---

### Task 2: Session-token verifier (pure module) with exhaustive offline tests

This is the security core. It needs no network and no Harper — a Shopify session token is a JWT signed HS256 with the app's client secret, so tests mint tokens with a known test secret.

**Files:**
- Create: `spikes/auth/src/verifySessionToken.ts`
- Create: `spikes/auth/src/AuthError.ts`
- Create: `spikes/auth/test/mintToken.ts`
- Create: `spikes/auth/test/verifySessionToken.test.ts`

**Interfaces:**
- Produces: `type Principal = { shopId: string; userId: string; roles: string[]; source: 'shopify-session' }`
- Produces: `function verifySessionToken(token: string, opts: { apiKey: string; secret: string; leewaySeconds?: number; nowSeconds?: number }): Principal` — throws `AuthError` (statusCode 401) on any failure.
- Produces test helper: `function mintToken(claims: Partial<Claims>, opts: { secret: string; alg?: string }): string`

- [ ] **Step 1: Write the failing tests**

`spikes/auth/test/mintToken.ts`:
```typescript
import { createHmac } from 'node:crypto';

const b64url = (buf: Buffer | string): string =>
	Buffer.from(buf).toString('base64url');

export function mintToken(
	claims: Record<string, unknown>,
	opts: { secret: string; alg?: string },
): string {
	const header = { alg: opts.alg ?? 'HS256', typ: 'JWT' };
	const h = b64url(JSON.stringify(header));
	const p = b64url(JSON.stringify(claims));
	const sig = createHmac('sha256', opts.secret).update(`${h}.${p}`).digest('base64url');
	return `${h}.${p}.${sig}`;
}

export function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const now = Math.floor(Date.now() / 1000);
	return {
		iss: 'https://demo-shop.myshopify.com/admin',
		dest: 'https://demo-shop.myshopify.com',
		aud: 'e446bda5edb3ee3bae6e0ba280ef8b12',
		sub: '42',
		exp: now + 60,
		nbf: now - 5,
		iat: now - 5,
		jti: 'abc',
		sid: 'sess-1',
		...overrides,
	};
}
```

`spikes/auth/test/verifySessionToken.test.ts`:
```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifySessionToken } from '../src/verifySessionToken.ts';
import { mintToken, validClaims } from './mintToken.ts';

const SECRET = 'test-secret';
const API_KEY = 'e446bda5edb3ee3bae6e0ba280ef8b12';
const opts = { apiKey: API_KEY, secret: SECRET };

test('accepts a valid token and derives the principal', () => {
	const p = verifySessionToken(mintToken(validClaims(), { secret: SECRET }), opts);
	assert.equal(p.shopId, 'demo-shop.myshopify.com');
	assert.equal(p.userId, '42');
	assert.equal(p.source, 'shopify-session');
});

test('rejects a bad signature', () => {
	const t = mintToken(validClaims(), { secret: 'wrong-secret' });
	assert.throws(() => verifySessionToken(t, opts), /signature/i);
});

test('rejects alg none / non-HS256', () => {
	const t = mintToken(validClaims(), { secret: SECRET, alg: 'none' });
	assert.throws(() => verifySessionToken(t, opts), /alg/i);
});

test('rejects wrong audience', () => {
	const t = mintToken(validClaims({ aud: 'someone-else' }), { secret: SECRET });
	assert.throws(() => verifySessionToken(t, opts), /aud/i);
});

test('rejects iss/dest host mismatch', () => {
	const t = mintToken(validClaims({ iss: 'https://evil.myshopify.com/admin' }), { secret: SECRET });
	assert.throws(() => verifySessionToken(t, opts), /host/i);
});

test('rejects expired token', () => {
	const now = Math.floor(Date.now() / 1000);
	const t = mintToken(validClaims({ exp: now - 10 }), { secret: SECRET });
	assert.throws(() => verifySessionToken(t, opts), /expired/i);
});

test('rejects not-yet-valid token (nbf in future)', () => {
	const now = Math.floor(Date.now() / 1000);
	const t = mintToken(validClaims({ nbf: now + 120 }), { secret: SECRET });
	assert.throws(() => verifySessionToken(t, opts), /not yet valid/i);
});

test('rejects malformed token', () => {
	assert.throws(() => verifySessionToken('not.a.jwt', opts), /malformed|token/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `spikes/auth/`): `node --test test/verifySessionToken.test.ts`
Expected: FAIL — cannot find `../src/verifySessionToken.ts`.

- [ ] **Step 3: Write the minimal implementation**

`spikes/auth/src/AuthError.ts`:
```typescript
export class AuthError extends Error {
	statusCode: number;
	constructor(message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = 'AuthError';
		this.statusCode = 401;
	}
}
```

`spikes/auth/src/verifySessionToken.ts`:
```typescript
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AuthError } from './AuthError.ts';

export type Principal = {
	shopId: string;
	userId: string;
	roles: string[];
	source: 'shopify-session';
};

type VerifyOpts = {
	apiKey: string;
	secret: string;
	leewaySeconds?: number;
	nowSeconds?: number;
};

function decodeSegment(seg: string): Record<string, unknown> {
	try {
		return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
	} catch (cause) {
		throw new AuthError('malformed token segment', cause);
	}
}

function hostOf(url: unknown): string {
	if (typeof url !== 'string') throw new AuthError('missing host claim');
	try {
		return new URL(url).host;
	} catch (cause) {
		throw new AuthError('invalid host claim', cause);
	}
}

export function verifySessionToken(token: string, opts: VerifyOpts): Principal {
	const leeway = opts.leewaySeconds ?? 5;
	const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);

	const parts = token.split('.');
	if (parts.length !== 3) throw new AuthError('malformed token');
	const [h, p, sig] = parts;

	const header = decodeSegment(h);
	if (header.alg !== 'HS256') throw new AuthError(`unsupported alg: ${String(header.alg)}`);

	const expected = createHmac('sha256', opts.secret).update(`${h}.${p}`).digest();
	const provided = Buffer.from(sig, 'base64url');
	if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
		throw new AuthError('invalid signature');
	}

	const claims = decodeSegment(p);
	if (claims.aud !== opts.apiKey) throw new AuthError('aud mismatch');

	const issHost = hostOf(claims.iss);
	const destHost = hostOf(claims.dest);
	if (issHost !== destHost) throw new AuthError('iss/dest host mismatch');

	const exp = Number(claims.exp);
	const nbf = Number(claims.nbf);
	if (!Number.isFinite(exp) || now >= exp) throw new AuthError('token expired');
	if (Number.isFinite(nbf) && now + leeway < nbf) throw new AuthError('token not yet valid');

	if (typeof claims.sub !== 'string' && typeof claims.sub !== 'number') {
		throw new AuthError('missing sub claim');
	}

	return {
		shopId: destHost,
		userId: String(claims.sub),
		roles: [],
		source: 'shopify-session',
	};
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/verifySessionToken.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add spikes/auth/src spikes/auth/test
git commit -m "spike(auth): dependency-free session-token verifier + exhaustive tests"
```

---

### Task 3: Wire the verifier into a guarded Harper resource

**Files:**
- Modify: `spikes/auth/resources.ts`
- Create: `spikes/auth/src/readSecret.ts`
- Create: `spikes/auth/test/sessionResource.test.ts`

**Interfaces:**
- Consumes: `verifySessionToken` / `Principal` (Task 2); header-access + secret-access APIs (Task 1 `RUNTIME-NOTES.md`).
- Produces: HTTP `GET /Session` on the component — `Authorization: Bearer <token>` → `200 { principal }` or `401 { error }`.

- [ ] **Step 1: Write the failing integration test**

`spikes/auth/test/sessionResource.test.ts` (adapt header/status accessors to the API confirmed in Task 1; this drives the resource to exist):
```typescript
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mintToken, validClaims } from './mintToken.ts';

// Spike integration test: the component reads the secret from process.env locally.
process.env.SHOPIFY_API_SECRET = 'test-secret';
const BASE = process.env.SPIKE_BASE ?? 'http://localhost:9926';

test('GET /Session returns 401 without a token', async () => {
	const res = await fetch(`${BASE}/Session`);
	assert.equal(res.status, 401);
});

test('GET /Session returns the principal for a valid token', async () => {
	const token = mintToken(validClaims(), { secret: 'test-secret' });
	const res = await fetch(`${BASE}/Session`, { headers: { Authorization: `Bearer ${token}` } });
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.equal(body.principal.shopId, 'demo-shop.myshopify.com');
});
```

- [ ] **Step 2: Run it to verify it fails**

Start the component (`harperdb run .`), then run: `node --test test/sessionResource.test.ts`
Expected: FAIL — `/Session` 404 (resource not defined).

- [ ] **Step 3: Implement the resource**

`spikes/auth/src/readSecret.ts` (prefer Harper secrets, fall back to env for local tests — replace `secrets` import with the exact accessor confirmed in Task 1):
```typescript
export async function readShopifySecret(): Promise<string> {
	const fromEnv = process.env.SHOPIFY_API_SECRET;
	if (fromEnv) return fromEnv;
	const { secrets } = await import('harper');
	const value = (secrets as Record<string, string>).SHOPIFY_API_SECRET;
	if (!value) throw new Error('SHOPIFY_API_SECRET not available');
	return value;
}
```

Add to `spikes/auth/resources.ts` (adapt the header read + status set to the confirmed API):
```typescript
import { verifySessionToken } from './src/verifySessionToken.ts';
import { readShopifySecret } from './src/readSecret.ts';

const API_KEY = 'e446bda5edb3ee3bae6e0ba280ef8b12';

export class Session extends Resource {
	static async get() {
		// Header access API confirmed in Task 1 RUNTIME-NOTES.md:
		const auth = this.getContext?.().headers?.get('authorization') ?? '';
		const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
		if (!token) {
			const e = new Error('missing bearer token') as Error & { statusCode: number };
			e.statusCode = 401;
			throw e;
		}
		const secret = await readShopifySecret();
		const principal = verifySessionToken(token, { apiKey: API_KEY, secret });
		return { principal };
	}
}
```

- [ ] **Step 4: Run it to verify it passes**

Restart the component; run: `node --test test/sessionResource.test.ts`
Expected: PASS. If the header/status API differs from the guess, correct it per `RUNTIME-NOTES.md` and re-run.

- [ ] **Step 5: Commit**

```bash
git add spikes/auth/resources.ts spikes/auth/src/readSecret.ts spikes/auth/test/sessionResource.test.ts
git commit -m "spike(auth): guarded Session resource returns verified principal"
```

---

### Task 4: Live dev-store end-to-end validation

Proves a **real** App Bridge session token (signed with the real secret in Harper) verifies against the deployed spike.

**Files:**
- Create: `spikes/auth/web/index.html` (minimal App Bridge page that fetches a session token and calls `/Session`)
- Modify: `spikes/auth/RUNTIME-NOTES.md` (record deploy URL + redacted evidence)

**Interfaces:**
- Consumes: deployed `Session` resource (Task 3), Harper native secret `SHOPIFY_API_SECRET` (already stored).

- [ ] **Step 1: Deploy the spike to the Fabric instance**

Deploy the `spikes/auth/` component to `ayoo.josh-test.harperfabric.com` (via `harperdb deploy` targeting the instance, or the Studio deploy flow). Confirm `GET /Session` is reachable over HTTPS and note the exact URL + port in `RUNTIME-NOTES.md`.

- [ ] **Step 2: Point the Shopify app at the spike and install on the dev store**

In the Partner dashboard for app `e446bda5edb3ee3bae6e0ba280ef8b12`, set the App URL to the deployed spike's embedded page and install on the dev store. Confirm the embedded page loads inside Admin.

- [ ] **Step 3: Verify a real token end-to-end**

`spikes/auth/web/index.html` uses App Bridge `getSessionToken()` and calls `/Session` with the bearer token. Load it in Admin.
Expected: the page shows the returned `principal` with the real shop domain and a real user id. Record a **redacted** success note (shop domain + HTTP 200, no token) in `RUNTIME-NOTES.md`.

- [ ] **Step 4: Commit**

```bash
git add spikes/auth/web spikes/auth/RUNTIME-NOTES.md
git commit -m "spike(auth): live dev-store session-token verification evidence"
```

---

### Task 5: Exchange a session token for an expiring offline token

**Files:**
- Create: `spikes/auth/src/exchangeToken.ts`
- Create: `spikes/auth/test/exchangeToken.test.ts`

**Interfaces:**
- Produces: `type OfflineToken = { accessToken: string; scope: string; expiresIn: number; refreshToken: string; refreshTokenExpiresIn: number; obtainedAt: number }`
- Produces: `function exchangeOfflineToken(args: { shop: string; sessionToken: string; apiKey: string; secret: string; expiring?: boolean }): Promise<OfflineToken>`

- [ ] **Step 1: Write the failing test (mocked fetch)**

`spikes/auth/test/exchangeToken.test.ts`:
```typescript
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { exchangeOfflineToken } from '../src/exchangeToken.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('posts the token-exchange request and parses an expiring offline token', async () => {
	let captured: { url: string; body: string } | undefined;
	globalThis.fetch = (async (url: string, init: { body: URLSearchParams }) => {
		captured = { url: String(url), body: init.body.toString() };
		return new Response(JSON.stringify({
			access_token: 'shpat_x', scope: 'read_orders',
			expires_in: 86399, refresh_token: 'rt_x', refresh_token_expires_in: 86399,
		}), { status: 200 });
	}) as typeof fetch;

	const tok = await exchangeOfflineToken({
		shop: 'demo-shop.myshopify.com', sessionToken: 'sess', apiKey: 'k', secret: 's',
	});

	assert.equal(captured?.url, 'https://demo-shop.myshopify.com/admin/oauth/access_token');
	assert.match(captured?.body ?? '', /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange/);
	assert.match(captured?.body ?? '', /requested_token_type=urn%3Ashopify%3Aparams%3Aoauth%3Atoken-type%3Aoffline-access-token/);
	assert.match(captured?.body ?? '', /expiring=1/);
	assert.equal(tok.accessToken, 'shpat_x');
	assert.equal(tok.refreshToken, 'rt_x');
	assert.equal(tok.expiresIn, 86399);
});

test('throws with a mapped status on Shopify error', async () => {
	globalThis.fetch = (async () => new Response('bad', { status: 400 })) as typeof fetch;
	await assert.rejects(
		() => exchangeOfflineToken({ shop: 's.myshopify.com', sessionToken: 't', apiKey: 'k', secret: 's' }),
		/token exchange failed/i,
	);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/exchangeToken.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`spikes/auth/src/exchangeToken.ts`:
```typescript
export type OfflineToken = {
	accessToken: string;
	scope: string;
	expiresIn: number;
	refreshToken: string;
	refreshTokenExpiresIn: number;
	obtainedAt: number;
};

export async function exchangeOfflineToken(args: {
	shop: string;
	sessionToken: string;
	apiKey: string;
	secret: string;
	expiring?: boolean;
}): Promise<OfflineToken> {
	const body = new URLSearchParams({
		client_id: args.apiKey,
		client_secret: args.secret,
		grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
		subject_token: args.sessionToken,
		subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
		requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
		expiring: args.expiring === false ? '0' : '1',
	});
	const res = await fetch(`https://${args.shop}/admin/oauth/access_token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
		body,
	});
	if (!res.ok) {
		const e = new Error(`token exchange failed: ${res.status}`) as Error & { statusCode: number };
		e.statusCode = res.status === 400 || res.status === 401 ? 401 : 502;
		throw e;
	}
	const json = (await res.json()) as Record<string, unknown>;
	return {
		accessToken: String(json.access_token),
		scope: String(json.scope ?? ''),
		expiresIn: Number(json.expires_in ?? 0),
		refreshToken: String(json.refresh_token ?? ''),
		refreshTokenExpiresIn: Number(json.refresh_token_expires_in ?? 0),
		obtainedAt: Math.floor(Date.now() / 1000),
	};
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test test/exchangeToken.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Live check + commit**

Using the deployed spike (Task 4), call the exchange with a real session token once and confirm a real expiring offline token (with `refresh_token` + `expires_in`) is returned. Record redacted evidence (scope + expiry, no token) in `RUNTIME-NOTES.md`.
```bash
git add spikes/auth/src/exchangeToken.ts spikes/auth/test/exchangeToken.test.ts spikes/auth/RUNTIME-NOTES.md
git commit -m "spike(auth): expiring offline token exchange + live evidence"
```

---

### Task 6: ShopCredential store + atomic refresh rotation under concurrency

Proves the rotation-atomicity claim: two concurrent refreshes converge to one valid credential with no torn state.

**Files:**
- Modify: `spikes/auth/schema.graphql` (add `ShopCredential`)
- Create: `spikes/auth/src/refreshCredential.ts`
- Create: `spikes/auth/test/refreshCredential.test.ts`

**Interfaces:**
- Consumes: `OfflineToken` (Task 5); Harper table write/optimistic-concurrency primitive (confirm exact API in Task 1 notes / here).
- Produces: `function refreshCredential(shopId: string, deps: { fetchNewToken: () => Promise<OfflineToken>; store: CredentialStore }): Promise<{ rotated: boolean; version: number }>` where `CredentialStore` reads/conditionally-writes a `{ shopId, accessToken, refreshToken, expiresAt, refreshTokenExpiresAt, version }` record.

- [ ] **Step 1: Confirm Shopify's refresh request shape**

Fetch <https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens> and record the exact refresh request (params for exchanging a `refresh_token` for a new access token) in `RUNTIME-NOTES.md`. Use it to implement `fetchNewToken` in the live path. The unit test injects `fetchNewToken`, so it does not depend on this.

- [ ] **Step 2: Write the failing concurrency test**

`spikes/auth/test/refreshCredential.test.ts` (in-memory store with optimistic concurrency to model the atomic write; the live store mirrors it against Harper):
```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshCredential } from '../src/refreshCredential.ts';
import type { OfflineToken } from '../src/exchangeToken.ts';

function memStore(initial: { version: number; accessToken: string }) {
	let rec = { shopId: 's', version: initial.version, accessToken: initial.accessToken };
	return {
		async read() { return { ...rec }; },
		async conditionalWrite(expectedVersion: number, next: { accessToken: string }) {
			if (rec.version !== expectedVersion) return false; // lost race
			rec = { ...rec, version: rec.version + 1, accessToken: next.accessToken };
			return true;
		},
		current() { return rec; },
	};
}

const newTok = (t: string): OfflineToken => ({
	accessToken: t, scope: '', expiresIn: 100, refreshToken: 'rt', refreshTokenExpiresIn: 100, obtainedAt: 0,
});

test('concurrent refreshes converge to one valid token, version advances once', async () => {
	const store = memStore({ version: 1, accessToken: 'old' });
	const [a, b] = await Promise.all([
		refreshCredential('s', { fetchNewToken: async () => newTok('newA'), store }),
		refreshCredential('s', { fetchNewToken: async () => newTok('newB'), store }),
	]);
	const winners = [a, b].filter((r) => r.rotated).length;
	assert.equal(winners, 1, 'exactly one refresh writes');
	assert.equal(store.current().version, 2, 'version advanced exactly once');
	assert.match(store.current().accessToken, /^new(A|B)$/);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --test test/refreshCredential.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`spikes/auth/src/refreshCredential.ts`:
```typescript
import type { OfflineToken } from './exchangeToken.ts';

export type CredentialStore = {
	read(): Promise<{ shopId: string; version: number; accessToken: string }>;
	conditionalWrite(
		expectedVersion: number,
		next: { accessToken: string; refreshToken: string; expiresAt: number; refreshTokenExpiresAt: number },
	): Promise<boolean>;
};

export async function refreshCredential(
	shopId: string,
	deps: { fetchNewToken: () => Promise<OfflineToken>; store: CredentialStore },
): Promise<{ rotated: boolean; version: number }> {
	const before = await deps.store.read();
	const tok = await deps.fetchNewToken();
	const wrote = await deps.store.conditionalWrite(before.version, {
		accessToken: tok.accessToken,
		refreshToken: tok.refreshToken,
		expiresAt: tok.obtainedAt + tok.expiresIn,
		refreshTokenExpiresAt: tok.obtainedAt + tok.refreshTokenExpiresIn,
	});
	if (!wrote) {
		const after = await deps.store.read(); // observe the winner's token
		return { rotated: false, version: after.version };
	}
	return { rotated: true, version: before.version + 1 };
}
```

Add the table to `spikes/auth/schema.graphql`:
```graphql
type ShopCredential @table @sealed {
	shopId: ID @primaryKey
	accessToken: String
	refreshToken: String
	expiresAt: Int
	refreshTokenExpiresAt: Int
	version: Int
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `node --test test/refreshCredential.test.ts`
Expected: PASS.

- [ ] **Step 6: Prove it against real Harper**

Implement a `CredentialStore` backed by the `ShopCredential` table using Harper's conditional/transactional write (per the primitive confirmed in Task 1). Run two concurrent `refreshCredential` calls against the live table for one `shopId`; assert exactly one write wins and the row is consistent. Record the result and the exact Harper concurrency primitive used in `RUNTIME-NOTES.md`.

- [ ] **Step 7: Commit**

```bash
git add spikes/auth/src/refreshCredential.ts spikes/auth/test/refreshCredential.test.ts spikes/auth/schema.graphql spikes/auth/RUNTIME-NOTES.md
git commit -m "spike(auth): atomic credential rotation proven under concurrency"
```

---

### Task 7: Resolve the `@harperfast/oauth` Shopify-provider question

**Files:**
- Modify: `spikes/auth/RUNTIME-NOTES.md`

- [ ] **Step 1: Investigate**

Check <https://github.com/HarperFast/oauth> (README + providers) and Harper 5.2.0 docs for a Shopify **embedded** session-token/token-exchange provider.

- [ ] **Step 2: Record the finding**

In `RUNTIME-NOTES.md`, state whether such a provider exists and the decision: keep Shopify session JWT authoritative on the request path (expected), with a one-paragraph justification referencing the embedded-app third-party-cookie constraint. This feeds ADR-001.

- [ ] **Step 3: Commit**

```bash
git add spikes/auth/RUNTIME-NOTES.md
git commit -m "spike(auth): record @harperfast/oauth Shopify-provider decision"
```

---

### Task 8: Write ADR-001 and update the Phase 0 spec

**Files:**
- Create: `docs/adr/ADR-001-authentication.md`
- Modify: `docs/superpowers/specs/2026-08-04-phase-0-risk-retirement-design.md` (check Spike A DoD boxes)

- [ ] **Step 1: Write ADR-001**

Capture: decision (Shopify session JWT authoritative for merchant requests; expiring offline tokens for background access; atomic version-guarded rotation), context, the verifier's validated claim checks, the confirmed Harper runtime facts (header + secret accessors, concurrency primitive), the token-exchange + refresh request shapes, the `@harperfast/oauth` decision, and links to the spike code and redacted evidence. Note anything that surprised us and any constraint the scaffold (issue #4) must honor.

- [ ] **Step 2: Check the Spike A boxes in the Phase 0 spec**

Mark the auth-related DoD items complete in the spec, referencing ADR-001.

- [ ] **Step 3: Commit**

```bash
git add docs/adr/ADR-001-authentication.md docs/superpowers/specs/2026-08-04-phase-0-risk-retirement-design.md
git commit -m "docs(adr): ADR-001 authentication — Spike A complete"
```

---

## Self-Review

**Spec coverage (Spike A section of the Phase 0 spec):**
- Verify session JWT with negative cases → Task 2 (unit) + Task 4 (live). ✓
- Yield principal `{shopId,userId,roles,source}` → Task 2/3. ✓
- Exchange for offline token → Task 5. ✓
- Atomic refresh rotation → Task 6. ✓
- `@harperfast/oauth` Shopify-provider question → Task 7. ✓
- Output ADR-001 → Task 8. ✓
- Secret from Harper native secrets → Task 3 (`readSecret`) + already stored. ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/"write tests for the above" — every code step has real code. The two genuine spike unknowns (exact Harper header/secret/concurrency APIs; Shopify refresh-request params) are scoped to explicit discovery steps (Task 1, Task 6 Step 1) with concrete recorded deliverables, not left implicit in implementation steps.

**Type consistency:** `Principal`, `OfflineToken`, `CredentialStore`, `AuthError` names/shapes are consistent across tasks. `verifySessionToken(token, opts)` signature matches its test and its resource call site. `exchangeOfflineToken` return type feeds `refreshCredential` via `fetchNewToken`.

**Known adaptation points (not placeholders — flagged for the implementer):** the header-read and secret-accessor lines in Task 3 and the Harper-backed `CredentialStore` in Task 6 are written against the APIs Task 1 confirms; if the real API differs, correct the call site and keep the test green. This is inherent to a runtime-discovery spike and is why Task 1 exists.
