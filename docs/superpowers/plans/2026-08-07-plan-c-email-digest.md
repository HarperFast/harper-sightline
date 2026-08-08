# Plan C — Email Digest (Outbox, No Sender) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a merchant subscribe an address to a daily or weekly Sightline digest, build that digest on a schedule, and persist each fully-rendered message to an outbox table — everything a sender would need, without shipping a sender.

**Architecture:** Two new tables in `sightline_core`: `DigestSubscription` (one row per shop: address, cadence, last-built marker) and `DigestOutbox` (one row per shop per period, keyed `${shopId}:${periodStart}` so a re-run upserts rather than duplicates). A pure builder turns gathered counts into a subject and a text/HTML body; a background loop gathers, builds, and writes. The subscription endpoint is **the app's first write surface** — it writes Sightline's own data only, never Shopify's, so the read-only-toward-Shopify boundary is intact.

**Tech Stack:** Harper v5 native application (TypeScript via TypeStrip, `.ts` import extensions), GraphQL schema DSL, Polaris web components, `node:test` + `node:assert/strict`, zero runtime dependencies.

## Global Constraints

Every task's requirements implicitly include this section.

- **No sender.** Do not add SMTP, an email API, an HTTP call to a mail provider, or a runtime dependency. The deliverable is a persisted, ready-to-send message. `status` is `pending` and nothing ever sets it to `sent` in this plan.
- **Read-only toward Shopify.** This plan writes only Sightline's own tables. No Shopify write, no new scope, no capability change — `capabilitiesFor()` still grants `record` only.
- **Zero runtime dependencies.** `app/package.json` has `devDependencies` only.
- **All tables `@table @sealed`, PRIVATE.** Never add `@export`.
- **Epoch-ms timestamps are GraphQL `Float`**, never `Int`.
- **The notification address is a NEW data category and must be disclosed.** It is a merchant-supplied staff address, **not** customer PII — so the Privacy screen's "No customer PII is stored" banner stays true — but it must appear in `getPrivacy`'s `dataCategories`, in `docs/data-inventory.md`, and in the public privacy policy. Shipping the storage without the disclosure is a compliance defect.
- **No customer PII in a digest body, ever.** A digest may name orders (`#1001`, order id), counts, and timestamps. It may never contain a customer name, email, phone, or address — none of which the app stores anyway, but the builder must be tested to prove it.
- **Reject anything that could become header injection.** The stored subject and address will eventually be handed to a mail transport. Validate the address and strip/refuse CR, LF, and control characters at the boundary, not at send time.
- **Every query derives `shopId` from the authenticated principal, never caller input.** A merchant can only ever read or write their own subscription; cover it in `app/test/crossTenant.test.ts`.
- **Response fields must be allowlisted** in `app/src/apiContract.ts`, then `npm run contract:gen` re-run.
- **`app/web/src/view.ts` stays pure** — no DOM, no network, no Shopify globals.
- **Every screen handles loading, empty, partial, stale, auth-expired, and recoverable-error states**, is keyboard operable with visible focus, and conveys meaning without colour.
- **Log via `log()` from `app/src/observe.ts`.** Never `console.*`. **Never log the subscribed address** — it is the one merchant-identifying string the app now holds.
- **Formatting:** tabs. `npm run format:check` and `npm run lint:required` must pass.
- **After any schema change to a `@sealed` table, verify with `describe_table` after deploying.**
- **Git:** branch, squash-merge, **never assign PR reviewers**. Prefixes: `feat(scope):` / `fix(scope):` / `docs:`.

**Dependency note:** this plan needs Plan A (for `GapFinding.detector`, so the digest can count failed attempts separately). It does **not** depend on Plan B — `gatherDigestInput` does its own counting. If Plan B has landed, the digest's numbers will agree with the Overview's because both derive from the same latches.

---

## File Structure

**Created:**
- `app/src/digest.ts` — pure digest domain: period boundaries, the build decision, the subject/body renderers, and the outbox row shape. No table access, so it is entirely testable in plain node.
- `app/src/digestData.ts` — gathering the digest's inputs from tables (injected `QueryTable`s, so tests use `FakeTable`). Separate from `digest.ts` because rendering and gathering change for different reasons.
- `app/src/digestSubscription.ts` — address/cadence validation and the subscription read/write, shared by the resource and the job.
- `app/test/digest.test.ts`
- `app/test/digestData.test.ts`
- `app/test/digestSubscription.test.ts`

**Modified:**
- `app/schema.graphql` — `DigestSubscription`, `DigestOutbox`.
- `app/src/model.ts` — matching interfaces.
- `app/src/db.ts` — `DigestSubscriptions`, `DigestOutboxes` handles.
- `app/src/ledgerTargets.ts` — redaction targets for both tables; a separate 30-day outbox retention target list.
- `app/jobs.ts` — the digest loop, and the outbox purge.
- `app/src/lifecycle.ts` — uninstall clears the subscription.
- `app/src/queries.ts` — `getPrivacy` discloses the address.
- `app/src/privacyPolicy.ts` — public policy mentions the notification address.
- `app/src/apiContract.ts`, `app/resources.ts` — the digest endpoint.
- `app/web/src/api.ts`, `view.ts`, `main.ts`, `index.html` — the Notifications screen.
- `docs/data-inventory.md`, `docs/runbooks/` — record the new data and a runbook.

---

### Task 1: Schema, model, and lifecycle for the two tables

**Files:**
- Modify: `app/schema.graphql` (append a new section), `app/src/model.ts`, `app/src/db.ts`, `app/src/ledgerTargets.ts`
- Test: `app/test/redaction.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `DigestSubscription { shopId, email, cadence, status, createdAt, updatedAt, lastBuiltAt? }` — `cadence: 'daily' | 'weekly'`, `status: 'active' | 'paused'`
  - `DigestOutbox { id, shopId, email, cadence, periodStart, periodEnd, subject, bodyText, bodyHtml, unconfirmed, failedAttempts, deliveryGaps, recorderHealthy, status, createdAt }` — `status: 'pending' | 'sent' | 'skipped'`
  - `DigestSubscriptions`, `DigestOutboxes` table handles from `app/src/db.ts`
  - `OUTBOX_RETENTION_TARGETS: RetentionTarget[]` and `OUTBOX_RETENTION_DAYS = 30` from `app/src/ledgerTargets.ts`
  - Both tables added to `REDACT_TARGETS`

- [ ] **Step 1: Append the tables to `app/schema.graphql`**

Add to the **`sightline_core`** section (install-time configuration and generated artifacts, not the 7-day operational ledger):

```graphql
type DigestSubscription @table(database: "sightline_core") @sealed {
	# One notification address per shop. The ONLY merchant-identifying string this
	# app stores — it is a staff address supplied by the merchant, not customer
	# data, and it is disclosed on the Privacy screen and in the privacy policy.
	# Erased on uninstall and on shop redaction.
	shopId: ID! @primaryKey
	email: String
	cadence: String # daily | weekly
	status: String @indexed # active | paused
	createdAt: Float
	updatedAt: Float
	# Period start of the last digest built for this shop. The build decision keys
	# on this, so a re-run inside the same period is a no-op.
	lastBuiltAt: Float
}

type DigestOutbox @table(database: "sightline_core") @sealed {
	# A fully-rendered digest, ready for a sender that does not exist yet. Keyed
	# `${shopId}:${periodStart}` so rebuilding a period upserts one row rather than
	# duplicating it. Bodies contain order names, counts and timestamps only — never
	# customer data.
	id: ID! @primaryKey
	shopId: String! @indexed
	email: String
	cadence: String
	periodStart: Float! @indexed
	periodEnd: Float
	subject: String
	bodyText: String
	bodyHtml: String
	# The headline numbers, kept as columns so an operator can see what a digest
	# said without parsing its body.
	unconfirmed: Int
	failedAttempts: Int
	deliveryGaps: Int
	recorderHealthy: Boolean
	status: String! @indexed # pending | sent | skipped
	createdAt: Float! @indexed # retention key (30 days, not the ledger's 7)
}
```

- [ ] **Step 2: Mirror in `app/src/model.ts`**

```typescript
export type DigestCadence = 'daily' | 'weekly';
export type DigestStatus = 'pending' | 'sent' | 'skipped';

export interface DigestSubscription {
	shopId: string;
	email?: string;
	cadence?: DigestCadence;
	status?: 'active' | 'paused';
	createdAt?: number;
	updatedAt?: number;
	lastBuiltAt?: number;
}

export interface DigestOutbox {
	id: string; // `${shopId}:${periodStart}`
	shopId: string;
	email?: string;
	cadence?: DigestCadence;
	periodStart: number;
	periodEnd?: number;
	subject?: string;
	bodyText?: string;
	bodyHtml?: string;
	unconfirmed?: number;
	failedAttempts?: number;
	deliveryGaps?: number;
	recorderHealthy?: boolean;
	status: DigestStatus;
	createdAt: number;
}
```

- [ ] **Step 3: Add the table handles**

In `app/src/db.ts`, add `DigestSubscription`, `DigestOutbox` to the type import and:

```typescript
export const DigestSubscriptions = core.DigestSubscription as unknown as Table<DigestSubscription>;
export const DigestOutboxes = core.DigestOutbox as unknown as Table<DigestOutbox>;
```

- [ ] **Step 4: Write the failing redaction test**

Add to `app/test/redaction.test.ts` (match the file's existing `redactShop` test shape):

```typescript
test('shop redaction erases the notification subscription and the digest outbox', async () => {
	const subscriptions = new FakeTable('shopId', [
		{ shopId: 's1', email: 'ops@merchant.example', cadence: 'daily', status: 'active' },
		{ shopId: 's2', email: 'other@merchant.example', cadence: 'daily', status: 'active' },
	]);
	const outbox = new FakeTable('id', [
		{ id: 's1:100', shopId: 's1', periodStart: 100, status: 'pending', createdAt: 100 },
		{ id: 's2:100', shopId: 's2', periodStart: 100, status: 'pending', createdAt: 100 },
	]);
	await redactShop(
		[
			{ name: 'DigestSubscription', keyField: 'shopId', shopField: 'shopId', table: subscriptions },
			{ name: 'DigestOutbox', keyField: 'id', shopField: 'shopId', table: outbox },
		],
		's1',
	);
	assert.equal(await subscriptions.get('s1'), undefined);
	assert.equal(await outbox.get('s1:100'), undefined);
	// The other tenant is untouched.
	assert.notEqual(await subscriptions.get('s2'), undefined);
	assert.notEqual(await outbox.get('s2:100'), undefined);
});

test('customer redaction does NOT touch digest tables — they carry no customer linkage', async () => {
	const subscriptions = new FakeTable('shopId', [{ shopId: 's1', email: 'ops@merchant.example', status: 'active' }]);
	await redactOrders([{ name: 'DigestSubscription', keyField: 'shopId', shopField: 'shopId', table: subscriptions }], 's1', ['o1']);
	assert.notEqual(await subscriptions.get('s1'), undefined);
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `cd app && node --test test/redaction.test.ts`
Expected: FAIL if `redactOrders` deletes rows lacking an `orderField` — which is the behavior this test pins. If it already passes, that is correct existing behavior; keep the test as a regression guard.

- [ ] **Step 6: Wire the targets**

In `app/src/ledgerTargets.ts`, add `DigestSubscriptions, DigestOutboxes` to the `./db.ts` import, then add to `REDACT_TARGETS`:

```typescript
	// The notification address and the generated digests. No orderField: neither is
	// linked to a customer or an order, so customers/redact must NOT reach them —
	// only uninstall / shop-redact does.
	{ name: 'DigestSubscription', keyField: 'shopId', shopField: 'shopId', table: purgeable(DigestSubscriptions) },
	{ name: 'DigestOutbox', keyField: 'id', shopField: 'shopId', table: purgeable(DigestOutboxes) },
```

And append a separate retention list:

```typescript
// The digest outbox keeps a longer history than the 7-day ledger: a digest is a
// record of what the merchant was told, which is worth having after the events it
// described have been purged. It is NOT in RETENTION_TARGETS because that list is
// swept with a single seven-day cutoff.
export const OUTBOX_RETENTION_DAYS = 30;
export const OUTBOX_RETENTION_TARGETS: RetentionTarget[] = [
	{ name: 'DigestOutbox', keyField: 'id', tsField: 'createdAt', table: purgeable(DigestOutboxes) },
];
```

- [ ] **Step 7: Clear the subscription on uninstall**

In `app/src/lifecycle.ts`, find `uninstallShop` and add the subscription delete alongside the existing credential/shop handling, so an uninstalled shop stops being a digest target immediately rather than waiting for a compliance webhook:

```typescript
	// Stop notifying an uninstalled shop at once. Deleting (not pausing) is right:
	// the address is merchant data we no longer have a reason to hold.
	try {
		await DigestSubscriptions.delete(shopId);
	} catch {
		// no subscription — nothing to clear
	}
```

Add `DigestSubscriptions` to its `./db.ts` import.

- [ ] **Step 8: Run tests, typecheck, commit, deploy, verify**

Run: `cd app && npm test && npm run typecheck`
Expected: PASS.

```bash
git add app/schema.graphql app/src/model.ts app/src/db.ts app/src/ledgerTargets.ts app/src/lifecycle.ts app/test/redaction.test.ts
git commit -m "feat(digest): subscription and outbox tables with redaction wiring"
```

Run: `cd app && npm run deploy`

Verify with `describe_table` that `sightline_core.DigestSubscription` and `sightline_core.DigestOutbox` exist with every column listed above. Redeploy if any column is missing.

---

### Task 2: Pure digest domain — periods, the build decision, and rendering

**Files:**
- Create: `app/src/digest.ts`, `app/test/digest.test.ts`

**Interfaces:**
- Consumes: `DigestCadence`, `DigestOutbox` (Task 1).
- Produces:
  - `periodStartFor(cadence: DigestCadence, now: number): number` — start of the last **complete** period, UTC
  - `periodEndFor(cadence: DigestCadence, periodStart: number): number`
  - `shouldBuild(subscription: { status?: string; email?: string; lastBuiltAt?: number }, periodStart: number): boolean`
  - `interface DigestInput { shopId: string; cadence: DigestCadence; periodStart: number; periodEnd: number; unconfirmed: number; failedAttempts: number; deliveryGaps: number; recorderHealthy: boolean; deadLettered: number; topAwaiting: DigestOrderRef[] }` where `DigestOrderRef = { orderName?: string; orderId: string; ageHours: number }`
  - `digestSubject(input: DigestInput): string`
  - `digestText(input: DigestInput): string`
  - `digestHtml(input: DigestInput): string`
  - `hasSomethingToSay(input: DigestInput): boolean`
  - `outboxRow(input: DigestInput, email: string, now: number): DigestOutbox`

- [ ] **Step 1: Write the failing tests**

Create `app/test/digest.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestHtml, digestSubject, digestText, hasSomethingToSay, outboxRow, periodEndFor, periodStartFor, shouldBuild, type DigestInput } from '../src/digest.ts';

const DAY = 86_400_000;
// Wednesday 2026-08-05T14:30:00Z — deliberately mid-day and mid-week so period
// flooring is actually exercised.
const NOW = Date.parse('2026-08-05T14:30:00Z');

function input(over: Partial<DigestInput> = {}): DigestInput {
	return {
		shopId: 's1.myshopify.com',
		cadence: 'daily',
		periodStart: Date.parse('2026-08-04T00:00:00Z'),
		periodEnd: Date.parse('2026-08-05T00:00:00Z'),
		unconfirmed: 0,
		failedAttempts: 0,
		deliveryGaps: 0,
		recorderHealthy: true,
		deadLettered: 0,
		topAwaiting: [],
		...over,
	};
}

test('the daily period is the last COMPLETE UTC day', () => {
	const start = periodStartFor('daily', NOW);
	assert.equal(new Date(start).toISOString(), '2026-08-04T00:00:00.000Z');
	assert.equal(new Date(periodEndFor('daily', start)).toISOString(), '2026-08-05T00:00:00.000Z');
});

test('the weekly period is the last complete Monday-to-Monday week', () => {
	const start = periodStartFor('weekly', NOW);
	// The Monday before the Monday of the current week.
	assert.equal(new Date(start).toISOString(), '2026-07-27T00:00:00.000Z');
	assert.equal(new Date(periodEndFor('weekly', start)).toISOString(), '2026-08-03T00:00:00.000Z');
});

test('a period never includes the present, so a digest never reports a partial window', () => {
	assert.ok(periodEndFor('daily', periodStartFor('daily', NOW)) <= NOW);
	assert.ok(periodEndFor('weekly', periodStartFor('weekly', NOW)) <= NOW);
});

test('build only for an active subscription with an address, once per period', () => {
	const periodStart = periodStartFor('daily', NOW);
	assert.equal(shouldBuild({ status: 'active', email: 'a@b.example' }, periodStart), true);
	assert.equal(shouldBuild({ status: 'active', email: 'a@b.example', lastBuiltAt: periodStart }, periodStart), false);
	assert.equal(shouldBuild({ status: 'active', email: 'a@b.example', lastBuiltAt: periodStart - DAY }, periodStart), true);
	assert.equal(shouldBuild({ status: 'paused', email: 'a@b.example' }, periodStart), false);
	assert.equal(shouldBuild({ status: 'active' }, periodStart), false);
	assert.equal(shouldBuild({}, periodStart), false);
});

test('a quiet, healthy period has nothing to say', () => {
	assert.equal(hasSomethingToSay(input()), false);
});

test('anything worth acting on means there is something to say', () => {
	assert.equal(hasSomethingToSay(input({ unconfirmed: 1 })), true);
	assert.equal(hasSomethingToSay(input({ failedAttempts: 1 })), true);
	assert.equal(hasSomethingToSay(input({ deliveryGaps: 1 })), true);
	assert.equal(hasSomethingToSay(input({ recorderHealthy: false, deadLettered: 2 })), true);
});

test('the subject leads with the most actionable number and never says failed about an absence', () => {
	assert.match(digestSubject(input({ unconfirmed: 3 })), /3 orders? awaiting confirmation/i);
	assert.match(digestSubject(input({ failedAttempts: 2, unconfirmed: 3 })), /2 fulfillment attempts? did not succeed/i);
	assert.match(digestSubject(input({ recorderHealthy: false, deadLettered: 5 })), /needs attention/i);
	assert.doesNotMatch(digestSubject(input({ unconfirmed: 3 })), /failed/i);
});

test('the subject has no CR or LF, so it can never inject a mail header', () => {
	for (const subject of [
		digestSubject(input({ unconfirmed: 3 })),
		digestSubject(input({ failedAttempts: 1 })),
		digestSubject(input({ recorderHealthy: false, deadLettered: 1 })),
	]) {
		assert.doesNotMatch(subject, /[\r\n]/);
	}
}); 

test('the text body states the window, the counts, and the claim boundary', () => {
	const body = digestText(input({ unconfirmed: 2, topAwaiting: [{ orderName: '#1001', orderId: '7518851989809', ageHours: 80 }] }));
	assert.match(body, /2026-08-04/);
	assert.match(body, /#1001/);
	assert.match(body, /80h|3d/);
	// The load-bearing boundary must travel with the message.
	assert.match(body, /does not prove that a warehouse or carrier failed/i);
});

test('the body never contains customer data', () => {
	const body = digestText(input({ unconfirmed: 1, topAwaiting: [{ orderName: '#1001', orderId: 'o1', ageHours: 10 }] }));
	for (const forbidden of ['@gmail', 'customer', 'phone', 'address', 'shipping_address']) {
		assert.equal(body.toLowerCase().includes(forbidden), false, `digest must not contain ${forbidden}`);
	}
});

test('the html body escapes hostile order names', () => {
	const html = digestHtml(input({ unconfirmed: 1, topAwaiting: [{ orderName: '<script>alert(1)</script>', orderId: 'o1', ageHours: 5 }] }));
	assert.doesNotMatch(html, /<script>alert/);
	assert.match(html, /&lt;script&gt;/);
});

test('an outbox row is keyed by shop and period so a rebuild upserts', () => {
	const row = outboxRow(input({ unconfirmed: 2, failedAttempts: 1, deliveryGaps: 3 }), 'ops@merchant.example', NOW);
	assert.equal(row.id, `s1.myshopify.com:${Date.parse('2026-08-04T00:00:00Z')}`);
	assert.equal(row.status, 'pending');
	assert.equal(row.email, 'ops@merchant.example');
	assert.equal(row.unconfirmed, 2);
	assert.equal(row.failedAttempts, 1);
	assert.equal(row.deliveryGaps, 3);
	assert.equal(row.createdAt, NOW);
	assert.ok((row.bodyText ?? '').length > 0);
	assert.ok((row.bodyHtml ?? '').length > 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && node --test test/digest.test.ts`
Expected: FAIL — cannot find module `../src/digest.ts`.

- [ ] **Step 3: Implement `app/src/digest.ts`**

```typescript
import type { DigestCadence, DigestOutbox } from './model.ts';

// The digest's pure domain: when a period is, whether to build, and what the
// message says. No table access and no clock of its own — every function takes
// the time it needs — so the whole thing is testable in plain node.
//
// There is deliberately NO SENDER. This renders and returns a message; the job
// persists it to the outbox with status 'pending'. Delivery is a separate
// decision with its own compliance surface (unsubscribe handling, bounce
// handling, a provider relationship) and none of it is in scope here.

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

// Periods are UTC and always CLOSED: the digest describes the last complete day
// or week, never a partial one in progress. A merchant reading "3 orders awaiting"
// for a window that is still open would have no way to know the number will move.
//
// UTC rather than the store's timezone is a deliberate simplification: it keeps
// the boundary arithmetic trivial and identical across cluster nodes, and every
// message names its window explicitly, so nothing is ambiguous even when the
// store's day differs.
export function periodStartFor(cadence: DigestCadence, now: number): number {
	const midnight = Math.floor(now / DAY_MS) * DAY_MS;
	if (cadence === 'weekly') {
		// getUTCDay: 0 = Sunday. Shift so Monday = 0, then step back a full week.
		const dayOfWeek = (new Date(midnight).getUTCDay() + 6) % 7;
		return midnight - dayOfWeek * DAY_MS - WEEK_MS;
	}
	return midnight - DAY_MS;
}

export function periodEndFor(cadence: DigestCadence, periodStart: number): number {
	return periodStart + (cadence === 'weekly' ? WEEK_MS : DAY_MS);
}

// Build when the subscription is usable and this period has not been built yet.
// Keying on the period (not on elapsed time) makes the loop idempotent: several
// ticks, several worker threads, or several cluster nodes all converge on one row.
export function shouldBuild(subscription: { status?: string; email?: string; lastBuiltAt?: number }, periodStart: number): boolean {
	if (subscription.status !== 'active') return false;
	if (!subscription.email) return false;
	return (subscription.lastBuiltAt ?? 0) < periodStart;
}

export interface DigestOrderRef {
	orderName?: string;
	orderId: string;
	ageHours: number;
}

export interface DigestInput {
	shopId: string;
	cadence: DigestCadence;
	periodStart: number;
	periodEnd: number;
	unconfirmed: number;
	failedAttempts: number;
	deliveryGaps: number;
	recorderHealthy: boolean;
	deadLettered: number;
	topAwaiting: DigestOrderRef[];
}

// A digest with nothing to report is not sent. A recurring "all clear" email
// trains people to ignore the channel, and the app itself is always available for
// a health check.
export function hasSomethingToSay(input: DigestInput): boolean {
	return input.unconfirmed > 0 || input.failedAttempts > 0 || input.deliveryGaps > 0 || !input.recorderHealthy;
}

function day(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

function plural(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

function label(order: DigestOrderRef): string {
	return order.orderName ?? order.orderId;
}

function age(hours: number): string {
	return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

// Escaping for the HTML body. Same rules as the SPA's `esc`, duplicated here
// rather than imported because src/ must not depend on web/.
function esc(value: unknown): string {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

// The subject leads with the most actionable fact. A failed attempt outranks an
// absence (it is direct evidence), and a broken recorder outranks both, because
// while the recorder is unhealthy the other numbers may be incomplete.
//
// Never contains CR or LF: this string will eventually be written into a mail
// header, and a newline there is a header-injection vector.
export function digestSubject(input: DigestInput): string {
	const window = input.cadence === 'weekly' ? `week of ${day(input.periodStart)}` : day(input.periodStart);
	let lead: string;
	if (!input.recorderHealthy) lead = 'Sightline needs attention';
	else if (input.failedAttempts > 0) lead = `${plural(input.failedAttempts, 'fulfillment attempt', 'fulfillment attempts')} did not succeed`;
	else if (input.unconfirmed > 0) lead = `${plural(input.unconfirmed, 'order', 'orders')} awaiting confirmation`;
	else if (input.deliveryGaps > 0) lead = `${plural(input.deliveryGaps, 'change', 'changes')} found by direct check`;
	else lead = 'Nothing to report';
	return `Sightline: ${lead} (${window})`.replace(/[\r\n]+/g, ' ');
}

// The product-truth boundary travels WITH the message. A digest is read outside
// the app, often forwarded, so it cannot rely on a screen to carry the caveat.
const BOUNDARY = 'These are observations of your Shopify data. An order with no observed confirmation does not prove that a warehouse or carrier failed — it means Shopify has not shown the expected fulfillment confirmation yet.';

export function digestText(input: DigestInput): string {
	const lines: string[] = [];
	lines.push(`Sightline digest for ${input.shopId}`);
	lines.push(`Window: ${day(input.periodStart)} to ${day(input.periodEnd)} (UTC)`);
	lines.push('');
	if (!input.recorderHealthy) {
		lines.push(`RECORDER NEEDS ATTENTION: ${plural(input.deadLettered, 'delivery', 'deliveries')} could not be processed, so the numbers below may be incomplete.`);
		lines.push('');
	}
	lines.push(`Orders awaiting fulfillment confirmation: ${input.unconfirmed}`);
	lines.push(`Fulfillment attempts that did not succeed: ${input.failedAttempts}`);
	lines.push(`Changes found by direct check rather than webhook: ${input.deliveryGaps}`);
	if (input.topAwaiting.length > 0) {
		lines.push('');
		lines.push('Longest waiting:');
		for (const order of input.topAwaiting) lines.push(`  ${label(order)} — waiting ${age(order.ageHours)}`);
	}
	lines.push('');
	lines.push(BOUNDARY);
	lines.push('');
	lines.push('Sightline is read-only and never sits in your fulfillment path.');
	return lines.join('\n');
}

export function digestHtml(input: DigestInput): string {
	const rows = input.topAwaiting
		.map((order) => `<tr><td>${esc(label(order))}</td><td>waiting ${esc(age(order.ageHours))}</td></tr>`)
		.join('');
	return [
		`<h2>Sightline digest for ${esc(input.shopId)}</h2>`,
		`<p>Window: ${esc(day(input.periodStart))} to ${esc(day(input.periodEnd))} (UTC)</p>`,
		input.recorderHealthy
			? ''
			: `<p><strong>Recorder needs attention:</strong> ${esc(plural(input.deadLettered, 'delivery', 'deliveries'))} could not be processed, so the numbers below may be incomplete.</p>`,
		'<ul>',
		`<li>Orders awaiting fulfillment confirmation: ${input.unconfirmed}</li>`,
		`<li>Fulfillment attempts that did not succeed: ${input.failedAttempts}</li>`,
		`<li>Changes found by direct check rather than webhook: ${input.deliveryGaps}</li>`,
		'</ul>',
		rows ? `<h3>Longest waiting</h3><table>${rows}</table>` : '',
		`<p>${esc(BOUNDARY)}</p>`,
		'<p>Sightline is read-only and never sits in your fulfillment path.</p>',
	]
		.filter(Boolean)
		.join('\n');
}

// One row per shop per period — a rebuild of the same period upserts rather than
// duplicating, which is what makes the loop safe to run from several threads.
export function outboxRow(input: DigestInput, email: string, now: number): DigestOutbox {
	return {
		id: `${input.shopId}:${input.periodStart}`,
		shopId: input.shopId,
		email,
		cadence: input.cadence,
		periodStart: input.periodStart,
		periodEnd: input.periodEnd,
		subject: digestSubject(input),
		bodyText: digestText(input),
		bodyHtml: digestHtml(input),
		unconfirmed: input.unconfirmed,
		failedAttempts: input.failedAttempts,
		deliveryGaps: input.deliveryGaps,
		recorderHealthy: input.recorderHealthy,
		status: 'pending',
		createdAt: now,
	};
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && node --test test/digest.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/digest.ts app/test/digest.test.ts
git commit -m "feat(digest): pure period, decision and rendering domain"
```

---

### Task 3: Gather the digest's inputs from tables

**Files:**
- Create: `app/src/digestData.ts`, `app/test/digestData.test.ts`

**Interfaces:**
- Consumes: `QueryTable` (from `./queries.ts`), `DigestInput` (Task 2), `DETECTOR_FAILED` (Plan A).
- Produces: `TOP_AWAITING = 5`; `gatherDigestInput(tables: { projections: QueryTable; findings: QueryTable; events: QueryTable; deliveries: QueryTable }, shopId: string, cadence: DigestCadence, periodStart: number, periodEnd: number, now: number): Promise<DigestInput>`

- [ ] **Step 1: Write the failing tests**

Create `app/test/digestData.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTable } from './fakeTable.ts';
import { gatherDigestInput, TOP_AWAITING } from '../src/digestData.ts';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.parse('2026-08-05T14:30:00Z');
const PERIOD_START = Date.parse('2026-08-04T00:00:00Z');
const PERIOD_END = Date.parse('2026-08-05T00:00:00Z');

function tables() {
	return {
		projections: new FakeTable('id', [
			{ id: 's1:oA', shopId: 's1', orderId: 'oA', orderName: '#1001', paidAt: NOW - 100 * HOUR, requiresFulfillment: true, lastEventAt: NOW - 100 * HOUR },
			{ id: 's1:oB', shopId: 's1', orderId: 'oB', orderName: '#1002', paidAt: NOW - 30 * HOUR, requiresFulfillment: true, lastEventAt: NOW - 30 * HOUR },
			{ id: 's1:oC', shopId: 's1', orderId: 'oC', orderName: '#1003', paidAt: NOW - 5 * HOUR, requiresFulfillment: true, fulfilledAt: NOW - 4 * HOUR, lastEventAt: NOW - 4 * HOUR },
			{ id: 's2:oA', shopId: 's2', orderId: 'oA', orderName: '#9999', paidAt: NOW - 50 * HOUR, requiresFulfillment: true, lastEventAt: NOW - 50 * HOUR },
		]),
		findings: new FakeTable('id', [
			{ id: 'fulfillment_confirmation:s1:oA:1', shopId: 's1', orderId: 'oA', detector: 'fulfillment_confirmation', status: 'unconfirmed', detectedAt: PERIOD_START + HOUR },
			{ id: 'fulfillment_attempt_failed:s1:oB:1', shopId: 's1', orderId: 'oB', detector: 'fulfillment_attempt_failed', status: 'unconfirmed', detectedAt: PERIOD_START + 2 * HOUR },
			{ id: 'fulfillment_confirmation:s1:oOld:1', shopId: 's1', orderId: 'oOld', detector: 'fulfillment_confirmation', status: 'resolved', detectedAt: PERIOD_START + 3 * HOUR },
			{ id: 'fulfillment_confirmation:s2:oA:1', shopId: 's2', orderId: 'oA', detector: 'fulfillment_confirmation', status: 'unconfirmed', detectedAt: PERIOD_START + HOUR },
		]),
		events: new FakeTable('eventId', [
			{ eventId: 's1:e1', shopId: 's1', domain: 'order', source: 'webhook', occurredAt: PERIOD_START + HOUR, receivedAt: PERIOD_START + HOUR },
			{ eventId: 'recon:s1:o9:paid', shopId: 's1', domain: 'order', source: 'reconciliation', occurredAt: PERIOD_START + 2 * HOUR, receivedAt: PERIOD_START + 2 * HOUR },
			{ eventId: 'recon:s1:oOut:paid', shopId: 's1', domain: 'order', source: 'reconciliation', occurredAt: PERIOD_START - 5 * DAY, receivedAt: PERIOD_START - 5 * DAY },
			{ eventId: 'recon:s2:o9:paid', shopId: 's2', domain: 'order', source: 'reconciliation', occurredAt: PERIOD_START + 2 * HOUR, receivedAt: PERIOD_START + 2 * HOUR },
		]),
		deliveries: new FakeTable('id', [{ id: 's1:d1', shopId: 's1', status: 'processed', receivedAt: PERIOD_START }]),
	};
}

test('counts are scoped to the shop and to the period', async () => {
	const input = await gatherDigestInput(tables(), 's1', 'daily', PERIOD_START, PERIOD_END, NOW);
	assert.equal(input.unconfirmed, 2, 'both unconfirmed findings, absence and failed-attempt');
	assert.equal(input.failedAttempts, 1);
	assert.equal(input.deliveryGaps, 1, 'only the in-period reconciliation-only event');
	assert.equal(input.shopId, 's1');
	assert.equal(input.cadence, 'daily');
	assert.equal(input.periodStart, PERIOD_START);
	assert.equal(input.periodEnd, PERIOD_END);
});

test('the longest-waiting orders are listed oldest first and capped', async () => {
	const input = await gatherDigestInput(tables(), 's1', 'daily', PERIOD_START, PERIOD_END, NOW);
	assert.deepEqual(
		input.topAwaiting.map((o) => o.orderName),
		['#1001', '#1002'],
	);
	assert.equal(input.topAwaiting[0].ageHours, 100);
	assert.ok(input.topAwaiting.length <= TOP_AWAITING);
});

test('a fulfilled order is not listed as waiting', async () => {
	const input = await gatherDigestInput(tables(), 's1', 'daily', PERIOD_START, PERIOD_END, NOW);
	assert.equal(
		input.topAwaiting.some((o) => o.orderName === '#1003'),
		false,
	);
});

test('another tenant data never appears in a digest', async () => {
	const input = await gatherDigestInput(tables(), 's1', 'daily', PERIOD_START, PERIOD_END, NOW);
	assert.equal(
		input.topAwaiting.some((o) => o.orderName === '#9999'),
		false,
	);
	assert.equal(input.unconfirmed, 2);
});

test('dead-lettered deliveries make the recorder unhealthy', async () => {
	const t = tables();
	await t.deliveries.put({ id: 's1:d2', shopId: 's1', status: 'dead_letter', receivedAt: PERIOD_START });
	const input = await gatherDigestInput(t, 's1', 'daily', PERIOD_START, PERIOD_END, NOW);
	assert.equal(input.recorderHealthy, false);
	assert.equal(input.deadLettered, 1);
});

test('a shop with nothing at all gathers a clean, zeroed input', async () => {
	const input = await gatherDigestInput(tables(), 'unknown.myshopify.com', 'daily', PERIOD_START, PERIOD_END, NOW);
	assert.equal(input.unconfirmed, 0);
	assert.equal(input.failedAttempts, 0);
	assert.equal(input.deliveryGaps, 0);
	assert.equal(input.recorderHealthy, true);
	assert.deepEqual(input.topAwaiting, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && node --test test/digestData.test.ts`
Expected: FAIL — cannot find module `../src/digestData.ts`.

- [ ] **Step 3: Implement `app/src/digestData.ts`**

```typescript
import type { DigestCadence, GapFinding, OrderProjection } from './model.ts';
import type { QueryTable } from './queries.ts';
import type { DigestInput, DigestOrderRef } from './digest.ts';
import { DETECTOR_FAILED } from './detector.ts';

// Gathering the digest's inputs. Split from digest.ts because rendering changes
// for editorial reasons and gathering changes for schema reasons.
//
// Every search is constrained by shopId — a digest is the one artifact that
// leaves the app, so cross-tenant bleed here would be the worst possible place
// for it. The adversarial tests in test/digestData.test.ts pin that.

// How many orders to name. Enough to be actionable, few enough that the message
// stays readable and does not become a data export.
export const TOP_AWAITING = 5;

export async function gatherDigestInput(
	tables: { projections: QueryTable; findings: QueryTable; events: QueryTable; deliveries: QueryTable },
	shopId: string,
	cadence: DigestCadence,
	periodStart: number,
	periodEnd: number,
	now: number,
): Promise<DigestInput> {
	// Findings DETECTED in the period. Counting by detection time (rather than
	// current state) is what makes the digest a report about that window instead of
	// a snapshot that happens to be sent on a schedule.
	let unconfirmed = 0;
	let failedAttempts = 0;
	for await (const row of tables.findings.search({ conditions: [{ attribute: 'shopId', value: shopId }] })) {
		const finding = row as unknown as GapFinding;
		const detectedAt = finding.detectedAt ?? 0;
		if (detectedAt < periodStart || detectedAt >= periodEnd) continue;
		if (finding.status !== 'unconfirmed') continue;
		unconfirmed++;
		if (finding.detector === DETECTOR_FAILED) failedAttempts++;
	}

	// Changes that reached us only through a direct Admin API check — the webhook
	// never arrived. Evidence about OUR capture path only (see the integrity copy).
	let deliveryGaps = 0;
	for await (const row of tables.events.search({
		conditions: [
			{ attribute: 'shopId', value: shopId },
			{ attribute: 'source', value: 'reconciliation' },
			{ attribute: 'occurredAt', value: periodStart, comparator: 'greater_than_equal' },
			{ attribute: 'occurredAt', value: periodEnd, comparator: 'less_than' },
		],
		operator: 'and',
		select: ['eventId'],
	})) {
		deliveryGaps++;
	}

	// Recorder health, so a digest can never report "all quiet" from an incomplete
	// pipeline. Same signal the Overview uses.
	let deadLettered = 0;
	for await (const _row of tables.deliveries.search({
		conditions: [
			{ attribute: 'shopId', value: shopId },
			{ attribute: 'status', value: 'dead_letter' },
		],
		operator: 'and',
		select: ['id'],
	})) {
		deadLettered++;
	}

	// The orders that have been waiting longest, as of NOW rather than as of the
	// period end: a merchant acting on this message needs the current wait.
	const awaiting: DigestOrderRef[] = [];
	for await (const row of tables.projections.search({ conditions: [{ attribute: 'shopId', value: shopId }] })) {
		const p = row as unknown as OrderProjection;
		const isAwaiting =
			p.paidAt !== undefined &&
			p.requiresFulfillment === true &&
			p.fulfilledAt === undefined &&
			p.cancelledAt === undefined &&
			p.fullyRefundedAt === undefined;
		if (!isAwaiting) continue;
		awaiting.push({
			orderName: p.orderName,
			orderId: p.orderId,
			ageHours: Math.max(0, Math.floor((now - (p.paidAt as number)) / 3_600_000)),
		});
	}
	awaiting.sort((a, b) => b.ageHours - a.ageHours);

	return {
		shopId,
		cadence,
		periodStart,
		periodEnd,
		unconfirmed,
		failedAttempts,
		deliveryGaps,
		recorderHealthy: deadLettered === 0,
		deadLettered,
		topAwaiting: awaiting.slice(0, TOP_AWAITING),
	};
}
```

**Note for the implementer:** the awaiting predicate is duplicated here from `isAwaitingConfirmation` in `app/src/orders.ts`. If Plan B has already merged, **import and use `isAwaitingConfirmation` instead** and delete the inline copy — one definition of "awaiting" is a hard rule in Plan B. If Plan B has not merged, leave the inline copy and add a `// TODO(plan-b)` comment naming the function to switch to.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && node --test test/digestData.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/digestData.ts app/test/digestData.test.ts
git commit -m "feat(digest): gather per-shop digest inputs, tenant-scoped"
```

---

### Task 4: Subscription validation and the digest endpoint

The app's first write endpoint. It writes Sightline's own configuration only.

**Files:**
- Create: `app/src/digestSubscription.ts`, `app/test/digestSubscription.test.ts`
- Modify: `app/src/apiContract.ts`, `app/resources.ts`
- Test: `app/test/crossTenant.test.ts`

**Interfaces:**
- Consumes: `DigestSubscription` model, `DigestSubscriptions` handle (Task 1); `writeAudit` (existing, `app/src/audit.ts`).
- Produces:
  - `MAX_EMAIL_LENGTH = 254`
  - `normalizeEmail(raw: unknown): string | undefined` — trims, lowercases, rejects invalid/oversized/control-character input by returning `undefined`
  - `normalizeCadence(raw: unknown): DigestCadence | undefined`
  - `interface SubscriptionView { email?: string; cadence: DigestCadence; status: 'active' | 'paused'; lastBuiltAt?: number }`
  - `toSubscriptionView(row: DigestSubscription | undefined): SubscriptionView`
  - `applySubscriptionUpdate(existing: DigestSubscription | undefined, shopId: string, body: { email?: unknown; cadence?: unknown; status?: unknown }, now: number): DigestSubscription`
  - `GET /api/v1/digest` and `PUT /api/v1/digest`

- [ ] **Step 1: Write the failing tests**

Create `app/test/digestSubscription.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySubscriptionUpdate, MAX_EMAIL_LENGTH, normalizeCadence, normalizeEmail, toSubscriptionView } from '../src/digestSubscription.ts';

const NOW = 1_775_000_000_000;

test('a plain address is trimmed and lowercased', () => {
	assert.equal(normalizeEmail('  Ops@Merchant.Example '), 'ops@merchant.example');
});

test('addresses that could inject a mail header are rejected', () => {
	// Newlines terminate a header; a rejected address is far better than a
	// sanitized one that silently differs from what the merchant typed.
	assert.equal(normalizeEmail('ops@merchant.example\nBcc: attacker@evil.example'), undefined);
	assert.equal(normalizeEmail('ops@merchant.example\r\nSubject: x'), undefined);
	assert.equal(normalizeEmail('ops@merchant.example\u0000'), undefined);
});

test('structurally invalid addresses are rejected', () => {
	for (const bad of ['', '   ', 'nope', 'a@', '@b.example', 'a b@c.example', 'a@b', 'a@@b.example']) {
		assert.equal(normalizeEmail(bad), undefined, `${JSON.stringify(bad)} must be rejected`);
	}
});

test('oversized addresses are rejected', () => {
	assert.equal(normalizeEmail(`${'a'.repeat(MAX_EMAIL_LENGTH)}@b.example`), undefined);
});

test('non-string input is rejected rather than coerced', () => {
	for (const bad of [undefined, null, 42, {}, ['a@b.example']]) {
		assert.equal(normalizeEmail(bad), undefined);
	}
});

test('cadence accepts only the two known values', () => {
	assert.equal(normalizeCadence('daily'), 'daily');
	assert.equal(normalizeCadence('weekly'), 'weekly');
	assert.equal(normalizeCadence('hourly'), undefined);
	assert.equal(normalizeCadence(undefined), undefined);
});

test('an absent subscription views as paused with a daily default', () => {
	assert.deepEqual(toSubscriptionView(undefined), { cadence: 'daily', status: 'paused' });
});

test('a view never exposes anything beyond the four subscription facts', () => {
	const view = toSubscriptionView({ shopId: 's1', email: 'ops@merchant.example', cadence: 'weekly', status: 'active', createdAt: 1, updatedAt: 2, lastBuiltAt: 3 });
	assert.deepEqual(Object.keys(view).sort(), ['cadence', 'email', 'lastBuiltAt', 'status']);
});

test('subscribing sets the address, activates, and stamps the times', () => {
	const row = applySubscriptionUpdate(undefined, 's1', { email: 'Ops@Merchant.example', cadence: 'weekly' }, NOW);
	assert.equal(row.shopId, 's1');
	assert.equal(row.email, 'ops@merchant.example');
	assert.equal(row.cadence, 'weekly');
	assert.equal(row.status, 'active');
	assert.equal(row.createdAt, NOW);
	assert.equal(row.updatedAt, NOW);
});

test('an update preserves createdAt and the last-built marker', () => {
	const existing = { shopId: 's1', email: 'old@merchant.example', cadence: 'daily' as const, status: 'active' as const, createdAt: 1, updatedAt: 1, lastBuiltAt: 500 };
	const row = applySubscriptionUpdate(existing, 's1', { email: 'new@merchant.example' }, NOW);
	assert.equal(row.email, 'new@merchant.example');
	assert.equal(row.createdAt, 1);
	assert.equal(row.lastBuiltAt, 500);
	assert.equal(row.updatedAt, NOW);
});

test('an invalid address throws rather than silently storing nothing', () => {
	assert.throws(() => applySubscriptionUpdate(undefined, 's1', { email: 'nope' }, NOW), /email/i);
});

test('pausing keeps the address so it can be resumed without retyping', () => {
	const existing = { shopId: 's1', email: 'ops@merchant.example', cadence: 'daily' as const, status: 'active' as const, createdAt: 1, updatedAt: 1 };
	const row = applySubscriptionUpdate(existing, 's1', { status: 'paused' }, NOW);
	assert.equal(row.status, 'paused');
	assert.equal(row.email, 'ops@merchant.example');
});

test('an empty address explicitly unsubscribes and clears the stored address', () => {
	const existing = { shopId: 's1', email: 'ops@merchant.example', cadence: 'daily' as const, status: 'active' as const, createdAt: 1, updatedAt: 1 };
	const row = applySubscriptionUpdate(existing, 's1', { email: '' }, NOW);
	assert.equal(row.email, undefined);
	assert.equal(row.status, 'paused');
});

test('the shopId always comes from the caller argument, never the body', () => {
	const row = applySubscriptionUpdate(undefined, 's1', { email: 'a@b.example', shopId: 'victim.myshopify.com' } as Record<string, unknown>, NOW);
	assert.equal(row.shopId, 's1');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && node --test test/digestSubscription.test.ts`
Expected: FAIL — cannot find module `../src/digestSubscription.ts`.

- [ ] **Step 3: Implement `app/src/digestSubscription.ts`**

```typescript
import type { DigestCadence, DigestSubscription } from './model.ts';

// Validation and shaping for the notification subscription — the app's only
// merchant-supplied input, and the only merchant-identifying string it stores.
//
// Validation is strict and REJECTS rather than sanitizes. The stored address will
// eventually be handed to a mail transport, where a CR or LF is a header
// injection; quietly stripping characters would also mean storing an address the
// merchant did not type, which then silently fails to deliver.

// RFC 5321's practical maximum.
export const MAX_EMAIL_LENGTH = 254;

// Deliberately conservative: one @, no whitespace, no control characters, a dot
// in the domain. It rejects some exotic-but-legal addresses, which is the right
// trade for a notification field a merchant can retype.
const EMAIL_SHAPE = /^[^\s@,;:<>"'\\()[\]]+@[^\s@,;:<>"'\\()[\]]+\.[^\s@,;:<>"'\\()[\]]{2,}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function normalizeEmail(raw: unknown): string | undefined {
	if (typeof raw !== 'string') return undefined;
	if (CONTROL_CHARS.test(raw)) return undefined;
	const email = raw.trim().toLowerCase();
	if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return undefined;
	if (!EMAIL_SHAPE.test(email)) return undefined;
	return email;
}

export function normalizeCadence(raw: unknown): DigestCadence | undefined {
	return raw === 'daily' || raw === 'weekly' ? raw : undefined;
}

export interface SubscriptionView {
	email?: string;
	cadence: DigestCadence;
	status: 'active' | 'paused';
	lastBuiltAt?: number;
}

// What the API returns. An explicit projection, not the stored row: the row will
// grow, and a notification setting must never become a place other state leaks.
export function toSubscriptionView(row: DigestSubscription | undefined): SubscriptionView {
	return {
		...(row?.email ? { email: row.email } : {}),
		cadence: row?.cadence ?? 'daily',
		status: row?.status === 'active' ? 'active' : 'paused',
		...(row?.lastBuiltAt === undefined ? {} : { lastBuiltAt: row.lastBuiltAt }),
	};
}

function badRequest(message: string): Error & { statusCode: number } {
	const e = new Error(message) as Error & { statusCode: number };
	e.statusCode = 400;
	return e;
}

// Merge an update onto the existing row. `shopId` comes from the verified
// principal via the argument — a shopId in the BODY is ignored entirely, which is
// the tenant-isolation invariant for the app's first write endpoint.
export function applySubscriptionUpdate(
	existing: DigestSubscription | undefined,
	shopId: string,
	body: { email?: unknown; cadence?: unknown; status?: unknown },
	now: number,
): DigestSubscription {
	const next: DigestSubscription = {
		shopId,
		email: existing?.email,
		cadence: existing?.cadence ?? 'daily',
		status: existing?.status ?? 'paused',
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
		...(existing?.lastBuiltAt === undefined ? {} : { lastBuiltAt: existing.lastBuiltAt }),
	};

	if (body.email !== undefined) {
		// An explicitly empty string is "unsubscribe me", which is a legitimate and
		// important action; anything else that fails validation is an error the
		// merchant needs to see rather than a silent no-op.
		if (typeof body.email === 'string' && body.email.trim() === '') {
			next.email = undefined;
			next.status = 'paused';
		} else {
			const email = normalizeEmail(body.email);
			if (!email) throw badRequest('email is not a valid address');
			next.email = email;
			// Supplying an address is the act of subscribing.
			next.status = 'active';
		}
	}

	if (body.cadence !== undefined) {
		const cadence = normalizeCadence(body.cadence);
		if (!cadence) throw badRequest('cadence must be daily or weekly');
		next.cadence = cadence;
	}

	if (body.status !== undefined) {
		if (body.status !== 'active' && body.status !== 'paused') throw badRequest('status must be active or paused');
		if (body.status === 'active' && !next.email) throw badRequest('an address is required before activating');
		next.status = body.status;
	}

	return next;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && node --test test/digestSubscription.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Add the endpoint**

In `app/src/apiContract.ts`, add to `API_CONTRACT.resources`:

```typescript
			digest: {
				path: '/api/v1/digest',
				fields: ['email', 'cadence', 'status', 'lastBuiltAt'],
				// The app's only write surface, and it writes Sightline's own
				// configuration — never Shopify data.
				methods: ['GET', 'PUT'],
			},
```

In `app/resources.ts`, add after `PrivacyResource`:

```typescript
// The notification subscription — the app's ONLY write endpoint, and it writes
// Sightline's own configuration, never Shopify's data. shopId comes from the
// verified principal; a shopId in the body is ignored.
//
// Every change is audited, and the address is never logged: it is the one
// merchant-identifying string this app holds.
export class DigestResource extends Resource {
	static path = '/api/v1/digest';
	allowRead() {
		return true;
	}
	allowUpdate() {
		return true;
	}
	async get() {
		const shopId = (await identity.authenticate(this.getContext())).shopId;
		return toSubscriptionView(await DigestSubscriptionsTable.get(shopId));
	}
	async put() {
		const ctx = this.getContext();
		const shopId = (await identity.authenticate(ctx)).shopId;
		const resolved = await ctx.data;
		// The raw-JSON content-type handler means bodies arrive as a Buffer.
		let body: Record<string, unknown> = {};
		try {
			const text = Buffer.isBuffer(resolved) ? resolved.toString('utf8') : typeof resolved === 'string' ? resolved : '';
			const parsed = JSON.parse(text);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
		} catch {
			throw httpError('body must be a JSON object', 400);
		}

		const now = Date.now();
		const existing = await DigestSubscriptionsTable.get(shopId);
		const next = applySubscriptionUpdate(existing, shopId, body, now);
		await DigestSubscriptionsTable.put(next);
		// Audit the CHANGE, never the address itself.
		await writeAudit(`digest:${shopId}:${now}`, shopId, 'digest.subscription.updated', now, `status=${next.status} cadence=${next.cadence} hasEmail=${Boolean(next.email)}`);
		return toSubscriptionView(next);
	}
}
```

Add the imports: `DigestSubscriptions as DigestSubscriptionsTable` to the `./src/db.ts` import; `applySubscriptionUpdate, toSubscriptionView` from `./src/digestSubscription.ts`.

- [ ] **Step 6: Add the cross-tenant cases**

Add to `app/test/crossTenant.test.ts`, in that file's victim/attacker style, cases asserting: `toSubscriptionView` of the victim's row is never reachable through the attacker's principal (assert on `applySubscriptionUpdate` ignoring a body `shopId`, and on the resource-level contract that `get`/`put` key on the principal's shopId only); and that an update body carrying `shopId`, `lastBuiltAt`, or `createdAt` cannot overwrite those fields for another tenant:

```typescript
test('a digest update body cannot retarget or backdate another tenant subscription', () => {
	const victim = { shopId: 'victim.myshopify.com', email: 'victim@example.com', cadence: 'daily' as const, status: 'active' as const, createdAt: 1, updatedAt: 1, lastBuiltAt: 999 };
	// The attacker's principal is attacker.myshopify.com; the body lies.
	const row = applySubscriptionUpdate(undefined, 'attacker.myshopify.com', { email: 'attacker@example.com', shopId: victim.shopId, lastBuiltAt: 0, createdAt: 0 } as Record<string, unknown>, 2000);
	assert.equal(row.shopId, 'attacker.myshopify.com');
	assert.equal(row.lastBuiltAt, undefined);
	assert.equal(row.createdAt, 2000);
});
```

- [ ] **Step 7: Verify and commit**

Run: `cd app && npm run contract:gen && npm test && npm run typecheck && npm run lint:required && npm run format:check`
Expected: all PASS.

```bash
git add app/src/digestSubscription.ts app/src/apiContract.ts app/resources.ts contracts/sightline-api-v1.json app/test/digestSubscription.test.ts app/test/crossTenant.test.ts
git commit -m "feat(digest): subscription endpoint with strict address validation"
```

---

### Task 5: Notifications screen

**Files:**
- Modify: `app/web/src/api.ts`, `app/web/src/view.ts`, `app/web/src/main.ts`, `app/web/index.html`
- Test: `app/test/view.test.ts`

**Interfaces:**
- Consumes: `GET`/`PUT /api/v1/digest` (Task 4).
- Produces: `api.ts`: `interface DigestSettings { email?: string; cadence: string; status: string; lastBuiltAt?: number }`, `apiDigest()`, `apiSaveDigest(body)`; `view.ts`: `notificationsView(settings, now, strip, message?)`; `main.ts`: the `#/notifications` route and its save handler.

- [ ] **Step 1: Add the client calls**

In `app/web/src/api.ts`:

```typescript
export interface DigestSettings {
	email?: string;
	cadence: string;
	status: string;
	lastBuiltAt?: number;
}
```

```typescript
export const apiDigest = () => get<DigestSettings>('/api/v1/digest');

// The one write the SPA performs, and it writes Sightline's own settings.
export async function apiSaveDigest(body: { email?: string; cadence?: string; status?: string }): Promise<DigestSettings> {
	const token = await shopify.idToken();
	const res = await nativeFetch()('/api/v1/digest', {
		method: 'PUT',
		headers: { 'X-Shopify-Session-Token': token, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		let detail = '';
		try {
			detail = ((await res.json()) as { error?: string }).error ?? '';
		} catch {
			// no JSON body
		}
		throw new Error(`${res.status}${detail ? ` ${detail}` : ''}`);
	}
	return res.json() as Promise<DigestSettings>;
}
```

- [ ] **Step 2: Write the failing view tests**

Add to `app/test/view.test.ts`:

```typescript
test('the notifications screen offers an address, a cadence, and a save action', () => {
	const html = notificationsView({ cadence: 'daily', status: 'paused' }, NOW, '');
	assert.match(html, /id="f-email"/);
	assert.match(html, /id="f-cadence"/);
	assert.match(html, /data-save-digest/);
});

test('an active subscription shows its address and current cadence selected', () => {
	const html = notificationsView({ email: 'ops@merchant.example', cadence: 'weekly', status: 'active' }, NOW, '');
	assert.match(html, /ops@merchant\.example/);
	assert.match(html, /value="weekly" selected/);
	assert.match(html, /active/);
});

test('the screen states plainly that digests are stored, not yet sent', () => {
	// Promising email that does not go out would be the worst possible copy here.
	const html = notificationsView({ cadence: 'daily', status: 'paused' }, NOW, '');
	assert.match(html, /not yet|will not be sent|stored/i);
});

test('the screen discloses that the address is stored and how to remove it', () => {
	const html = notificationsView({ email: 'ops@merchant.example', cadence: 'daily', status: 'active' }, NOW, '');
	assert.match(html, /stored/i);
	assert.match(html, /clear|remove|empty/i);
});

test('a save error is shown to the merchant rather than swallowed', () => {
	assert.match(notificationsView({ cadence: 'daily', status: 'paused' }, NOW, '', { tone: 'critical', text: 'email is not a valid address' }), /not a valid address/);
});

test('a save confirmation is shown on success', () => {
	assert.match(notificationsView({ cadence: 'daily', status: 'active', email: 'a@b.example' }, NOW, '', { tone: 'success', text: 'Saved' }), /Saved/);
});

test('a hostile stored address cannot inject markup', () => {
	const html = notificationsView({ email: '"><script>alert(1)</script>', cadence: 'daily', status: 'active' }, NOW, '');
	assert.doesNotMatch(html, /<script>alert/);
});
```

Extend the imports with `notificationsView` and `type DigestSettings`.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd app && node --test test/view.test.ts`
Expected: FAIL — `notificationsView` is not exported.

- [ ] **Step 4: Implement the view**

Add to `app/web/src/view.ts`:

```typescript
// ── notifications ────────────────────────────────────────────────────────────
// The digest subscription. Two things this screen must be honest about:
//
// 1. Nothing is sent yet. Digests are built and stored; delivery is not built.
//    Promising an email that never arrives would be worse than offering nothing.
// 2. The address is stored. It is the only merchant-identifying string the app
//    holds, so the screen says so and says how to remove it.
export const CADENCES: Array<[string, string]> = [
	['daily', 'Daily'],
	['weekly', 'Weekly'],
];

export function notificationsView(
	settings: DigestSettings,
	now: number,
	strip: string,
	message?: { tone: string; text: string },
): string {
	const cadenceOptions = CADENCES.map(
		([value, label]) => `<option value="${esc(value)}"${value === settings.cadence ? ' selected' : ''}>${esc(label)}</option>`,
	).join('');
	const status = settings.status === 'active' ? badge('active', 'success') : badge('paused', 'neutral');

	return page(
		'Notifications',
		`${strip}
		${message ? `<s-section><s-banner tone="${esc(message.tone)}"><s-paragraph>${esc(message.text)}</s-paragraph></s-banner></s-section>` : ''}
		<s-section heading="Operations digest">
			<s-banner tone="info" heading="Digests are being prepared, not yet delivered">
				<s-paragraph>Sightline builds your digest on schedule and stores it. Email delivery is not switched on yet, so nothing will be sent to this address for now — subscribing tells us you want it and makes sure your first digest is ready when delivery ships.</s-paragraph>
			</s-banner>
			<s-stack direction="inline" gap="small-200" alignItems="center">${status}${
				settings.lastBuiltAt === undefined
					? `<s-text color="subdued">No digest prepared yet</s-text>`
					: `<s-text color="subdued">Last digest prepared ${esc(relative(settings.lastBuiltAt, now))}</s-text>`
			}</s-stack>
			<s-stack id="digestForm" direction="inline" gap="base" alignItems="end">
				<s-text-field id="f-email" label="Notification email" placeholder="ops@yourstore.com" value="${esc(settings.email ?? '')}"></s-text-field>
				<s-select id="f-cadence" label="Frequency">${cadenceOptions}</s-select>
				<s-button variant="primary" data-save-digest>Save</s-button>
			</s-stack>
			<s-paragraph><s-text color="subdued">Clear the field and save to remove your address and stop preparing digests. The address is stored with your shop's Sightline data and is erased when you uninstall.</s-text></s-paragraph>
		</s-section>
		<s-section heading="What a digest contains">
			${bullets([
				'How many orders are awaiting fulfillment confirmation',
				'How many fulfillment attempts Shopify recorded as unsuccessful',
				'How many changes Sightline found by direct check rather than by webhook',
				'Whether the recorder itself needs attention',
				'The orders that have been waiting longest, by order name',
			])}
			<s-paragraph><s-text color="subdued">A digest never contains customer names, emails, phone numbers, or addresses — Sightline does not store them.</s-text></s-paragraph>
		</s-section>`,
	);
}
```

Add `DigestSettings` to the type import at the top of `view.ts`.

- [ ] **Step 5: Wire the route and nav**

In `app/web/src/main.ts`:

```typescript
async function notifications(message?: { tone: string; text: string }): Promise<void> {
	loading();
	const contextHtml = await strip();
	const settings = await apiDigest();
	render(notificationsView(settings, Date.now(), contextHtml, message));
	document.querySelector('[data-save-digest]')?.addEventListener('click', () => {
		void (async () => {
			try {
				await apiSaveDigest({ email: fieldValue('f-email'), cadence: fieldValue('f-cadence') });
				await notifications({ tone: 'success', text: 'Saved.' });
			} catch (err) {
				// A 400 carries the validation reason; show it rather than a bare code.
				const text = String((err as Error).message).replace(/^400\s*/, '') || 'Could not save.';
				await notifications({ tone: 'critical', text });
			}
		})();
	});
}
```

In `route()`, add:

```typescript
			else if (path === '/notifications') await notifications();
```

Extend the imports: `apiDigest`, `apiSaveDigest` from `./api.ts`; `notificationsView` from `./view.ts`.

In `app/web/index.html`, add to **both** navs, before Privacy:

```html
			<s-link href="#/notifications">Notifications</s-link>
```

```html
			<s-link href="#/notifications" data-nav="/notifications">Notifications</s-link>
```

- [ ] **Step 6: Verify and commit**

Run: `cd app && npm test && npm run typecheck && npm run build && npm run lint:required && npm run format:check`
Expected: all PASS.

```bash
git add app/web/src/api.ts app/web/src/view.ts app/web/src/main.ts app/web/index.html app/test/view.test.ts
git commit -m "feat(ui): notifications screen for the operations digest"
```

---

### Task 6: The digest build loop

**Files:**
- Modify: `app/jobs.ts`
- Test: `app/test/digest.test.ts` (loop-level decisions are covered by `shouldBuild`; this task adds the wiring)

**Interfaces:**
- Consumes: `periodStartFor`, `periodEndFor`, `shouldBuild`, `hasSomethingToSay`, `outboxRow` (Task 2); `gatherDigestInput` (Task 3); `OUTBOX_RETENTION_TARGETS`, `OUTBOX_RETENTION_DAYS` (Task 1).
- Produces: `runDigestBuild(now?): Promise<{ built: number; skipped: number }>`, `startDigestLoop(): void`, and outbox purging folded into the existing purge tick.

- [ ] **Step 1: Write the failing test**

Add to `app/test/digest.test.ts`:

```typescript
test('a period that has already been built is not rebuilt, whatever the clock says', () => {
	// The loop's idempotency reduces to this: several ticks, threads, or nodes in
	// the same period all decline after the first build.
	const periodStart = periodStartFor('daily', NOW);
	const subscription = { status: 'active', email: 'a@b.example', lastBuiltAt: periodStart };
	assert.equal(shouldBuild(subscription, periodStart), false);
	assert.equal(shouldBuild(subscription, periodStartFor('daily', NOW + DAY)), true);
});

test('an outbox id is stable for a period, so a rebuild overwrites rather than duplicating', () => {
	const first = outboxRow(input({ unconfirmed: 1 }), 'a@b.example', NOW);
	const second = outboxRow(input({ unconfirmed: 5 }), 'a@b.example', NOW + 1000);
	assert.equal(first.id, second.id);
	assert.notEqual(first.unconfirmed, second.unconfirmed);
});
```

Run: `cd app && node --test test/digest.test.ts`
Expected: PASS (these pin Task 2's behavior explicitly for the loop's benefit).

- [ ] **Step 2: Add the loop to `app/jobs.ts`**

```typescript
// Digest build (Plan C). Builds each subscriber's digest for the last COMPLETE
// period and writes it to the outbox with status 'pending'. THERE IS NO SENDER —
// delivery is a separate decision with its own compliance surface, so this loop
// deliberately stops at a persisted, ready-to-send message.
//
// Idempotent by construction: the outbox id is `${shopId}:${periodStart}` and the
// build decision keys on the subscription's lastBuiltAt, so overlapping ticks
// across threads and cluster nodes converge on one row per period.
const DIGEST_INTERVAL_MS = 3_600_000; // hourly; the period check does the real gating
const DIGEST_INITIAL_DELAY_MS = 90_000;
const digestTicker = ticker('digest', 30 * 60_000);

export async function runDigestBuild(now = Date.now()): Promise<{ built: number; skipped: number }> {
	let built = 0;
	let skipped = 0;
	for await (const row of DigestSubscriptions.search({ conditions: [{ attribute: 'status', value: 'active' }] })) {
		const subscription = row as unknown as DigestSubscription;
		const cadence = subscription.cadence ?? 'daily';
		const periodStart = periodStartFor(cadence, now);
		if (!shouldBuild(subscription, periodStart)) {
			skipped++;
			continue;
		}
		const periodEnd = periodEndFor(cadence, periodStart);
		const input = await gatherDigestInput(
			{
				projections: Projections as unknown as QueryTable,
				findings: Findings as unknown as QueryTable,
				events: Events as unknown as QueryTable,
				deliveries: Deliveries as unknown as QueryTable,
			},
			subscription.shopId,
			cadence,
			periodStart,
			periodEnd,
			now,
		);

		// A quiet, healthy period produces no digest. A recurring "all clear" trains
		// people to ignore the channel. The period is still marked built, so the
		// next tick does not re-gather it.
		if (hasSomethingToSay(input) && subscription.email) {
			await DigestOutboxes.put(outboxRow(input, subscription.email, now));
			built++;
		} else {
			skipped++;
		}
		await DigestSubscriptions.patch(subscription.shopId, { lastBuiltAt: periodStart, updatedAt: now });
	}
	return { built, skipped };
}

function digestTick(): void {
	void digestTicker.run(async () => {
		try {
			const r = await runDigestBuild();
			// Never log the address — it is the one merchant-identifying string held.
			if (r.built) log('info', 'digest.built', { built: r.built, skipped: r.skipped });
		} catch (e: unknown) {
			log('error', 'digest.error', { message: (e as Error).message });
		}
	});
}

export function startDigestLoop(): void {
	setTimeout(digestTick, DIGEST_INITIAL_DELAY_MS);
	setInterval(digestTick, DIGEST_INTERVAL_MS);
}
```

Add `startDigestLoop();` to the block of loop starts at the bottom, and extend the imports: `DigestOutboxes, DigestSubscriptions` from `./src/db.ts`; `hasSomethingToSay, outboxRow, periodEndFor, periodStartFor, shouldBuild` from `./src/digest.ts`; `gatherDigestInput` from `./src/digestData.ts`; `DigestSubscription` from `./src/model.ts`.

- [ ] **Step 3: Purge the outbox on its own longer schedule**

In `app/jobs.ts`'s `runPurge`, add the outbox sweep so both retentions are exercised by the same tick:

```typescript
export function runPurge(now = Date.now()): Promise<PurgeResult> {
	return purgeExpired(RETENTION_TARGETS, now);
}

// The digest outbox keeps 30 days, not the ledger's 7: a digest is a record of
// what the merchant was told, worth keeping after the events it described expire.
export function runOutboxPurge(now = Date.now()): Promise<PurgeResult> {
	return purgeExpired(OUTBOX_RETENTION_TARGETS, now, OUTBOX_RETENTION_DAYS);
}
```

In `purgeTick`, after the existing `runPurge()` handling, add:

```typescript
			const outbox = await runOutboxPurge();
			if (outbox.deleted) log('trace', 'purge.outbox', { deleted: outbox.deleted });
			if (outbox.failures.length) log('warn', 'purge.outbox.failures', { count: outbox.failures.length, failures: outbox.failures });
```

Extend the `./src/ledgerTargets.ts` import with `OUTBOX_RETENTION_DAYS, OUTBOX_RETENTION_TARGETS`.

- [ ] **Step 4: Add a retention test for the 30-day window**

Add to `app/test/retention.test.ts`:

```typescript
test('digest outbox rows are purged after thirty days, not seven', async () => {
	const outbox = new FakeTable('id', [
		{ id: 's1:old', shopId: 's1', periodStart: 1, status: 'pending', createdAt: NOW - 40 * DAY },
		{ id: 's1:recent', shopId: 's1', periodStart: 2, status: 'pending', createdAt: NOW - 10 * DAY },
	]);
	const result = await purgeExpired([{ name: 'DigestOutbox', keyField: 'id', tsField: 'createdAt', table: outbox }], NOW, 30);
	assert.equal(result.deleted, 1);
	assert.equal(await outbox.get('s1:old'), undefined);
	// Ten days old survives a 30-day retention but would NOT survive the ledger's 7.
	assert.notEqual(await outbox.get('s1:recent'), undefined);
});
```

- [ ] **Step 5: Verify and commit**

Run: `cd app && npm test && npm run typecheck && npm run lint:required && npm run format:check`
Expected: all PASS.

```bash
git add app/jobs.ts app/test/digest.test.ts app/test/retention.test.ts
git commit -m "feat(digest): hourly build loop with per-period idempotency and 30-day outbox retention"
```

---

### Task 7: Disclose the stored address everywhere it must be disclosed

Storing a merchant address without disclosing it is a compliance defect. This task closes it in the three places that matter: the in-app Privacy screen, the public privacy policy an App Store reviewer reads, and the data inventory.

**Files:**
- Modify: `app/src/queries.ts` (`getPrivacy`), `app/src/privacyPolicy.ts`, `docs/data-inventory.md`
- Create: `docs/runbooks/digest-not-building.md`
- Test: `app/test/queries.test.ts`, `app/test/privacyPolicy.test.ts`

**Interfaces:**
- Consumes: `DigestSubscriptions` (Task 1).
- Produces: `getPrivacy` gains `notifications: { emailStored: boolean; cadence?: string; status: string }` and a `dataCategories` entry; the public policy gains a notification-address paragraph.

- [ ] **Step 1: Write the failing tests**

Add to `app/test/queries.test.ts`:

```typescript
test('the privacy payload discloses whether a notification address is stored, without echoing it', async () => {
	const { events, findings, projections, deliveries, shops } = fixtures();
	const subscriptions = new FakeTable('shopId', [{ shopId: 's1', email: 'ops@merchant.example', cadence: 'daily', status: 'active' }]);
	const privacy = await getPrivacy({ events, findings, projections, deliveries, shops, digestSubscriptions: subscriptions }, 's1', NOW);
	const notifications = privacy.notifications as { emailStored: boolean; status: string };
	assert.equal(notifications.emailStored, true);
	assert.equal(notifications.status, 'active');
	// The address itself is on the Notifications screen; the privacy payload states
	// only that one exists, so this endpoint cannot become an address disclosure.
	assert.equal(JSON.stringify(privacy).includes('ops@merchant.example'), false);
});

test('a shop with no subscription reports none stored', async () => {
	const { events, findings, projections, deliveries, shops } = fixtures();
	const privacy = await getPrivacy({ events, findings, projections, deliveries, shops, digestSubscriptions: new FakeTable('shopId') }, 's1', NOW);
	assert.equal((privacy.notifications as { emailStored: boolean }).emailStored, false);
});

test('the data categories disclose the notification address', async () => {
	const { events, findings, projections, deliveries, shops } = fixtures();
	const privacy = await getPrivacy({ events, findings, projections, deliveries, shops, digestSubscriptions: new FakeTable('shopId') }, 's1', NOW);
	assert.ok((privacy.dataCategories as string[]).some((c) => /notification email/i.test(c)));
});

test('the no-customer-PII promise is unchanged by the notification address', async () => {
	const { events, findings, projections, deliveries, shops } = fixtures();
	const privacy = await getPrivacy({ events, findings, projections, deliveries, shops, digestSubscriptions: new FakeTable('shopId') }, 's1', NOW);
	// A merchant's own staff address is not customer data.
	assert.equal(privacy.storesCustomerPii, false);
	assert.deepEqual(privacy.excludedFields, ['customer name', 'customer email', 'customer phone', 'shipping & billing address']);
});
```

Add to `app/test/privacyPolicy.test.ts`:

```typescript
test('the public policy discloses the notification address, its purpose, and its deletion', () => {
	const html = privacyPolicyHtml({ email: 'support@harperdb.io' }, '2026-08-07');
	assert.match(html, /notification email/i);
	assert.match(html, /uninstall/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && node --test test/queries.test.ts test/privacyPolicy.test.ts`
Expected: FAIL — `privacy.notifications` is `undefined`.

- [ ] **Step 3: Disclose it in `getPrivacy`**

In `app/src/queries.ts`, widen `getPrivacy`'s table parameter to include an optional `digestSubscriptions?: QueryTable`, add the new data category, and return the disclosure:

```typescript
	// Whether a notification address is on file for this shop — stated, never
	// echoed. The address is the merchant's own and is shown on the Notifications
	// screen; repeating it here would make an audit endpoint into a second place it
	// can leak from.
	const subscription = tables.digestSubscriptions ? await tables.digestSubscriptions.get(shopId) : undefined;
	const notifications = {
		emailStored: Boolean(subscription && subscription.shopId === shopId && subscription.email),
		...(subscription && subscription.shopId === shopId && typeof subscription.cadence === 'string' ? { cadence: subscription.cadence } : {}),
		status: subscription && subscription.shopId === shopId && subscription.status === 'active' ? 'active' : 'paused',
	};
```

Add `'notification email you supply for digests (merchant contact, not customer data)'` to the `dataCategories` array, add `notifications,` to the returned object, and add `'notifications'` to the `privacy` resource's `fields` in `app/src/apiContract.ts`.

In `app/resources.ts`, pass the table through: add `DigestSubscriptions as DigestSubscriptionsTable` to the db import if not already added in Task 4, define `const DigestSubscriptionsQ = DigestSubscriptionsTable as unknown as QueryTable;`, and add `digestSubscriptions: DigestSubscriptionsQ` to the `getPrivacy` call's table object.

In `app/web/src/api.ts`, add to `Privacy`:

```typescript
	notifications: { emailStored: boolean; cadence?: string; status: string };
```

In `app/web/src/view.ts`'s `privacyView`, add a row to the Installation `fields()` list and a link to the screen that manages it:

```typescript
					[
						'Notification email',
						p.notifications?.emailStored
							? `${badge(p.notifications.status === 'active' ? 'stored' : 'stored, paused', 'info')} · <s-link href="#/notifications">Manage</s-link>`
							: `<s-text color="subdued">none stored</s-text> · <s-link href="#/notifications">Add one</s-link>`,
					],
```

Add a view test:

```typescript
test('the privacy screen states whether a notification address is stored', () => {
	assert.match(privacyView(privacy({ notifications: { emailStored: true, status: 'active' } }), NOW, ''), /Notification email[\s\S]*stored/);
	assert.match(privacyView(privacy({ notifications: { emailStored: false, status: 'paused' } }), NOW, ''), /none stored/);
});
```

(Extend the `privacy()` fixture helper in `view.test.ts` with a default `notifications: { emailStored: false, status: 'paused' }`.)

- [ ] **Step 4: Update the public privacy policy**

In `app/src/privacyPolicy.ts`, add a section to the rendered HTML, in the file's existing style:

```
Notification email. If you choose to receive an operations digest, Sightline stores the email address you enter and how often you asked for it. This is your own contact address, not customer data. It is used only to prepare and (once delivery is available) send your digest, is never shared or sold, and is deleted when you clear it in the app or uninstall Sightline. Digests contain order names, counts, and timestamps only — never customer names, emails, phone numbers, or addresses.
```

- [ ] **Step 5: Update the data inventory and add a runbook**

In `docs/data-inventory.md`, add:

| Table | Field(s) | Purpose | Retention |
|---|---|---|---|
| `DigestSubscription` | `email`, `cadence`, `status`, `lastBuiltAt` | Merchant-supplied notification address and frequency. **The only merchant-identifying string stored.** Not customer data. | Deleted on clear, uninstall, or shop-redact; not aged out |
| `DigestOutbox` | `email`, `subject`, `bodyText`, `bodyHtml`, counts | Rendered digests awaiting a sender. Bodies carry order names, counts, timestamps — no customer data. | 30-day purge; erased on uninstall/shop-redact |

Add one line to the summary: *"The notification address is merchant contact data, disclosed on the Privacy screen and in the public policy. The customer-field exclusion list is unchanged, and `storesCustomerPii` remains false."*

Create `docs/runbooks/digest-not-building.md`, matching the format of the existing runbooks in that directory (they follow symptom → check → cause → action → escalation):

```markdown
# Runbook: digests are not being built

**Symptom.** A shop has an active subscription but `DigestOutbox` has no recent row, or `digest.built` never appears in the logs.

**Checks, in order.**
1. `log` search for `digest.error` — an exception aborts the whole pass.
2. `log` search for `tick.stalled` with `loop: "digest"` — a wedged pass.
3. Read the subscription: `status` must be `active` and `email` must be set. `shouldBuild` declines otherwise, and the Notifications screen shows the same state.
4. Compare `lastBuiltAt` to the current period start (`periodStartFor`). If they are equal, the period is already built — this is correct behavior, not a fault.
5. If `lastBuiltAt` advanced but no outbox row exists, the period was genuinely quiet: `hasSomethingToSay` was false. Also correct — a healthy, quiet period produces no digest by design.

**Likely causes and actions.**
- *Quiet period.* No action. Confirm by gathering the same window manually.
- *Wedged loop.* The ticker's stall budget (30 min) allows a new pass; if `tick.stalled` repeats, restart the component and file the stack from `digest.error`.
- *Subscription paused by uninstall.* `uninstallShop` deletes the subscription. Expected if the app was removed.
- *Purge removed the evidence.* Outbox rows older than 30 days are purged; a missing old digest is expected.

**Escalation.** If digests stop for every shop at once, treat it as a component-level fault and check the ops snapshot for overall health before digging into the digest loop.

**Note.** There is no sender. A `pending` outbox row is the finished state today; nothing being delivered is not a fault.
```

Add the new runbook to the alert→runbook→owner map in `docs/runbooks/`.

- [ ] **Step 6: Full verification**

Run: `cd app && npm run contract:gen && npm test && npm run typecheck && npm run build && npm run lint:required && npm run format:check`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add app/src/queries.ts app/src/apiContract.ts app/src/privacyPolicy.ts app/resources.ts app/web/src/api.ts app/web/src/view.ts contracts/sightline-api-v1.json app/test/queries.test.ts app/test/privacyPolicy.test.ts app/test/view.test.ts docs/data-inventory.md docs/runbooks
git commit -m "feat(digest): disclose the stored notification address in-app, in policy, and in the inventory"
```

- [ ] **Step 8: Deploy and verify live**

Run: `cd app && npm run deploy && npm run smoke`
Expected: smoke passes.

Verify with `describe_table` that both digest tables still carry every column, then in the embed:
1. Open **Notifications**. Confirm the "not yet delivered" banner is present and the state reads paused with no address.
2. Save an invalid address (`nope`). Confirm the validation message appears rather than a bare `400`.
3. Save a valid address. Confirm it reads active, and confirm the Privacy screen now says an address is stored — **and does not show the address itself**.
4. Confirm no log line anywhere contains the address (search the logs for the local part).
5. Force a build without waiting a day: temporarily set the subscription's `lastBuiltAt` to `0` via the ops API, wait for a digest tick (≈90s after boot, then hourly), and confirm one `DigestOutbox` row appears with a sensible subject and body, `status: 'pending'`.
6. Confirm re-running the tick does **not** create a second row for the same period.
7. Clear the address and save. Confirm the subscription reads paused with no address, and that Privacy reports none stored.
8. Uninstall the app on the dev store and confirm the subscription row is gone; reinstall to continue working.

- [ ] **Step 9: Open the PR**

```bash
gh pr create --title "feat: operations digest built to an outbox (no sender)" --body "$(cat <<'EOF'
Implements Plan C (docs/superpowers/plans/2026-08-07-plan-c-email-digest.md).

- DigestSubscription + DigestOutbox tables in sightline_core
- Pure digest domain: closed UTC periods, per-period build decision, subject/text/HTML rendering with the product-truth boundary carried in the message
- Tenant-scoped gathering of counts, delivery gaps, recorder health, and longest-waiting orders
- GET/PUT /api/v1/digest — the app's first write endpoint, writing Sightline's own config only; strict address validation that REJECTS header-injection and malformed input
- Notifications screen that is explicit that digests are prepared, not yet delivered
- Hourly build loop, idempotent per period; 30-day outbox retention
- The stored address is disclosed on the Privacy screen, in the public policy, and in the data inventory; storesCustomerPii remains false
- Runbook for "digests are not being built"

NO SENDER: digests are persisted with status 'pending'. Delivery is out of scope.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Squash-merge with no reviewers.

---

## Deferred from this plan

- **Actual delivery.** Needs a mail provider, unsubscribe handling (a one-click unsubscribe link implies an unauthenticated endpoint and a token scheme), bounce/complaint handling, and a decision about sending from a Harper component versus a separate worker. The outbox is the seam.
- **Per-recipient or multi-address subscriptions.** One address per shop keeps the tenant model trivial. Multiple recipients means a child table and a per-recipient unsubscribe state.
- **Store-timezone period boundaries.** Periods are UTC and every message names its window. Aligning to `Shop.ianaTimezone` is a small change to `periodStartFor` plus a per-shop timezone read, worth doing when delivery ships and "your Monday" starts mattering.
- **Threshold alerts.** A digest is a scheduled summary, not an alert. "Tell me within an hour when an order passes 24h" is a different feature with different plumbing.
</content>
