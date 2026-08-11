import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REDACT_TARGETS, RETENTION_TARGETS, OUTBOX_RETENTION_TARGETS } from '../src/retention/ledgerTargets.ts';
import { OUTBOX_RETENTION_DAYS } from '../src/retention/retention.ts';

// ledgerTargets.ts wires DigestSubscription/DigestOutbox into REDACT_TARGETS,
// RETENTION_TARGETS, and OUTBOX_RETENTION_TARGETS by hand. Their correctness is
// entirely a question of WHICH list each entry sits in — exactly what
// redaction.test.ts's hand-built RedactTarget fixtures cannot check, since they
// never touch the real arrays.
//
// db.ts imports table handles through `#harper`, which resolves to a stub under
// `node --test --conditions=test` (see package.json's `imports` map), so the
// real arrays can be imported and asserted on directly — no more reading
// ledgerTargets.ts as text.

function findEntry<T extends { name: string }>(targets: T[], name: string): T {
	const entry = targets.find((t) => t.name === name);
	assert.ok(entry, `no entry named '${name}' found in this array`);
	return entry;
}

test('DigestSubscription and DigestOutbox are shop-redact targets with no orderField', () => {
	// No orderField is what makes redaction.ts's `if (!target.orderField)
	// continue;` skip these tables on customers/redact. An orderField here would
	// silently let customer redaction reach a table it must never touch.
	const subscription = findEntry(REDACT_TARGETS, 'DigestSubscription');
	const outbox = findEntry(REDACT_TARGETS, 'DigestOutbox');
	assert.equal(subscription.orderField, undefined);
	assert.equal(outbox.orderField, undefined);
});

test('digest tables are absent from the seven-day RETENTION_TARGETS', () => {
	const names = RETENTION_TARGETS.map((t) => t.name);
	assert.ok(!names.includes('DigestSubscription'), 'the subscription is core config, not a purge target at all');
	assert.ok(!names.includes('DigestOutbox'), 'the outbox keeps 30 days — it must not be swept by the 7-day cutoff');
});

test('DigestOutbox has its own 30-day entry in OUTBOX_RETENTION_TARGETS', () => {
	const outboxEntry = findEntry(OUTBOX_RETENTION_TARGETS, 'DigestOutbox');
	assert.equal(outboxEntry.tsField, 'createdAt');
	assert.equal(OUTBOX_RETENTION_DAYS, 30);
});
