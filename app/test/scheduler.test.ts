import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// config.yaml's `scheduler` block is wired by STRING: `handler: ./jobs.ts#detectJob`
// names an export that nothing type-checks and nothing links at build time. A
// typo, a renamed export, or a job dropped from the block during a refactor
// produces no error anywhere — the job simply never runs, and the symptom is
// silence. That is the same class of failure harperImports.test.ts exists for (a
// mapping nothing offline exercises), and the same defence applies: pin the
// wiring's shape from the outside.
//
// This is a SOURCE-level check on purpose. Importing jobs.ts to read the exports
// directly would start the 10s processing interval and the purge's post-deploy
// timer inside the test process — which is precisely why every sweep's logic
// lives in a deps-injected module (see src/retention/purgeCycle.ts's note) and
// why no other test imports jobs.ts either.

const config = readFileSync(new URL('../config.yaml', import.meta.url), 'utf8');
const jobsSource = readFileSync(new URL('../jobs.ts', import.meta.url), 'utf8');

// Deliberately not a YAML parser: this repo ships no YAML dependency, and the two
// fields worth pinning are trivially greppable.
function declaredJobs(): Array<{ name: string; schedule: string; handler: string }> {
	const out: Array<{ name: string; schedule: string; handler: string }> = [];
	// Only the scheduler block, so an `env:` entry can never be mistaken for a job.
	const block = /\nscheduler:\n([\s\S]*?)(?=\n[a-zA-Z]|$)/.exec(config)?.[1] ?? '';
	for (const entry of block.split(/^\s*- /m).slice(1)) {
		const name = /name:\s*(\S+)/.exec(entry)?.[1];
		const schedule = /(?:interval|cron):\s*'?([^'\n]+)'?/.exec(entry)?.[1]?.trim();
		const handler = /handler:\s*(\S+)/.exec(entry)?.[1];
		if (name && schedule && handler) out.push({ name, schedule, handler });
	}
	return out;
}

test('the scheduler block declares the seven sweeps that moved off setInterval', () => {
	const jobs = declaredJobs();
	assert.equal(jobs.length, 7, `expected 7 scheduler jobs, parsed ${jobs.length}: ${jobs.map((j) => j.name).join(', ')}`);
	const names = jobs.map((j) => j.name).sort();
	assert.deepEqual(names, [
		'sightline-detect',
		'sightline-digest',
		'sightline-inventory-enrich',
		'sightline-ops-snapshot',
		'sightline-purge',
		'sightline-reconcile',
		'sightline-state-backfill',
	]);
});

test('every declared handler names an export that actually exists in jobs.ts', () => {
	for (const { name, handler } of declaredJobs()) {
		const [path, exportName] = handler.split('#');
		assert.equal(path, './jobs.ts', `${name}: handler must point at ./jobs.ts, got ${path}`);
		assert.ok(exportName, `${name}: handler must name an export (path#export), got ${handler}`);
		// The handlers are `export const <name> = job(...)`. A missing export here is
		// a job that silently never fires on the instance.
		assert.match(
			jobsSource,
			new RegExp(`export const ${exportName}\\b`),
			`${name}: jobs.ts has no \`export const ${exportName}\` — the job would never run`,
		);
	}
});

test('every job handler is registered exactly once', () => {
	// Two jobs sharing a handler means one sweep runs at two cadences — cheap to
	// introduce by copy-paste when adding a job, invisible afterwards.
	const handlers = declaredJobs().map((j) => j.handler);
	assert.equal(new Set(handlers).size, handlers.length, `duplicate handler in the scheduler block: ${handlers.join(', ')}`);
});

test('schedules stay within the scheduler intervals Harper accepts', () => {
	// One second to 365 days. A value outside that (or a unit typo like `1min`)
	// is rejected at load, taking the whole scheduler block with it.
	for (const { name, schedule } of declaredJobs()) {
		assert.match(schedule, /^(\d+(s|m|h|d)|\d+)$/, `${name}: '${schedule}' is not a duration the scheduler parses (e.g. 90s, 5m, 1h, 1d)`);
	}
});

test('the 10s processing loop is NOT on the scheduler, and is still started on import', () => {
	// The deliberate exception, documented under SCHEDULING in jobs.ts: a ~6.5-minute
	// leader failover would park deliveries past BACKLOG_STALE_MS (5 min) and trip
	// the health snapshot on every leader change. If someone later moves it, this
	// test should fail and make them re-read that reasoning first.
	assert.ok(
		!declaredJobs().some((j) => /process/i.test(j.handler)),
		'the delivery-processing loop must stay a per-node setInterval — see SCHEDULING in jobs.ts',
	);
	assert.match(jobsSource, /^startProcessingLoop\(\);$/m, 'jobs.ts must still start the processing loop on import');
	assert.match(
		jobsSource,
		/^startPurgeBootPass\(\);$/m,
		'the purge keeps one post-deploy pass; the scheduler does not fire a new job on deploy',
	);
});

test('no sweep is left starting its own interval timer', () => {
	// The regression this whole change prevents: a stray setInterval means that
	// sweep is back to running on every worker thread on every node, in addition to
	// the leader-coordinated occurrence.
	const intervals = jobsSource.match(/setInterval\(/g) ?? [];
	assert.equal(intervals.length, 1, `expected exactly one setInterval (the processing loop), found ${intervals.length}`);
});

test('config.yaml declares the secrets the component cannot run without', () => {
	// With the dev fallbacks deleted, an undeclared secret surfaces as a
	// MissingSecretError on the first request that needs it. Declaring it makes the
	// component fail at LOAD with a named reason instead.
	const envBlock = /\nenv:\n([\s\S]*?)(?=\n[a-zA-Z]|$)/.exec(config)?.[1] ?? '';
	for (const name of ['SHOPIFY_API_SECRET', 'SIGHTLINE_TOKEN_KEY', 'SIGHTLINE_OPS_TOKEN']) {
		assert.match(envBlock, new RegExp(`^\\s*${name}:.*required:\\s*true`, 'm'), `config.yaml env: must declare ${name} as required`);
	}
	// The client_id is public (it is served in AppHome's meta tag), so declaring it
	// as a required secret would say something false about it.
	assert.doesNotMatch(envBlock, /SHOPIFY_API_KEY/, 'SHOPIFY_API_KEY is a public identifier, not a secret');
});
