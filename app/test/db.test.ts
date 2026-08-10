import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DigestSubscriptions, DigestOutboxes, Shops } from '../src/db.ts';

// The point of this test is that it can be written at all. Before the `#harper`
// mapping, importing src/db.ts threw ERR_MODULE_NOT_FOUND and every module
// reaching it — resources.ts, jobs.ts, ledgerTargets.ts — was untestable.
test('the table handles load under node --test', () => {
	for (const handle of [DigestSubscriptions, DigestOutboxes, Shops]) {
		assert.ok(handle, 'a table handle must resolve');
	}
});
