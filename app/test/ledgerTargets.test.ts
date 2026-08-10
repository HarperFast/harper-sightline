import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ledgerTargets.ts wires DigestSubscription/DigestOutbox into REDACT_TARGETS,
// RETENTION_TARGETS, and OUTBOX_RETENTION_TARGETS by hand. Their correctness is
// entirely a question of WHICH list each entry sits in — exactly what
// redaction.test.ts's hand-built RedactTarget fixtures cannot check, since they
// never touch the real arrays.
//
// The real arrays can't be imported here: ledgerTargets.ts imports db.ts, which
// does `import { databases } from 'harper'` — a module that exists only inside
// the deployed Harper Fabric runtime and has no resolvable file under
// `node --test` (confirmed: ERR_MODULE_NOT_FOUND; `mock.module` can't rescue an
// import with no real file to mock, either). So this reads the actual source
// file as text and inspects the real entries, the same way privacyPolicy.test.ts
// reads shopify.app.toml rather than a copy of its scopes — a future edit that
// adds an orderField to a digest target, or moves one into the wrong retention
// list, fails here instead of drifting silently past a fixture-based test.
const SOURCE = readFileSync(new URL('../src/ledgerTargets.ts', import.meta.url), 'utf8');

// Slice out one exported array literal's body, from its opening `[` to the
// closing `];` at the start of a line (every array in this file is written
// that way — see the source itself).
function arrayBlock(exportName: string): string {
	const start = SOURCE.indexOf(`export const ${exportName}`);
	assert.ok(start !== -1, `${exportName} not found in ledgerTargets.ts`);
	const open = SOURCE.indexOf('[', start);
	const close = SOURCE.indexOf('\n];', open);
	assert.ok(close !== -1, `${exportName}'s closing "];" not found`);
	return SOURCE.slice(open, close);
}

// Every target in this file is a single-line object literal, so its whole entry
// can be pulled out with one line-bounded match.
function entry(block: string, name: string): string {
	const m = block.match(new RegExp(`\\{[^\\n]*name:\\s*'${name}'[^\\n]*\\}`));
	assert.ok(m, `no entry named '${name}' found in this array`);
	return m[0];
}

test('DigestSubscription and DigestOutbox are shop-redact targets with no orderField', () => {
	const redact = arrayBlock('REDACT_TARGETS');
	// No orderField is what makes redaction.ts's `if (!target.orderField)
	// continue;` skip these tables on customers/redact. An orderField here would
	// silently let customer redaction reach a table it must never touch.
	assert.ok(!entry(redact, 'DigestSubscription').includes('orderField'));
	assert.ok(!entry(redact, 'DigestOutbox').includes('orderField'));
});

test('digest tables are absent from the seven-day RETENTION_TARGETS', () => {
	const retention = arrayBlock('RETENTION_TARGETS');
	assert.ok(!retention.includes(`name: 'DigestSubscription'`), 'the subscription is core config, not a purge target at all');
	assert.ok(!retention.includes(`name: 'DigestOutbox'`), 'the outbox keeps 30 days — it must not be swept by the 7-day cutoff');
});

test('DigestOutbox has its own 30-day entry in OUTBOX_RETENTION_TARGETS', () => {
	const outboxRetention = arrayBlock('OUTBOX_RETENTION_TARGETS');
	const outboxEntry = entry(outboxRetention, 'DigestOutbox');
	assert.match(outboxEntry, /tsField:\s*'createdAt'/);
	assert.match(SOURCE, /export const OUTBOX_RETENTION_DAYS = 30;/);
});
