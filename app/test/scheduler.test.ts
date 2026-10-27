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
// directly would start the purge's post-deploy timer inside the test process —
// which is precisely why every sweep's logic lives in a deps-injected module (see
// src/retention/purgeCycle.ts's note) and why no other test imports jobs.ts either.

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

test('the scheduler block declares all eight sweeps', () => {
	const jobs = declaredJobs();
	assert.equal(jobs.length, 8, `expected 8 scheduler jobs, parsed ${jobs.length}: ${jobs.map((j) => j.name).join(', ')}`);
	const names = jobs.map((j) => j.name).sort();
	assert.deepEqual(names, [
		'sightline-detect',
		'sightline-digest',
		'sightline-inventory-enrich',
		'sightline-ops-snapshot',
		'sightline-process',
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

test('every exported job handler in jobs.ts is declared in config.yaml', () => {
	const declared = new Set(declaredJobs().map((j) => j.handler.split('#')[1]));
	const exported = [...jobsSource.matchAll(/^export const (\w+) = job\(/gm)].map((m) => m[1]);
	assert.ok(exported.length > 0, 'found no `export const X = job(` handlers in jobs.ts');
	for (const name of exported) assert.ok(declared.has(name), `jobs.ts exports ${name} but config.yaml never schedules it`);
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

test('delivery processing runs on the scheduler every 10s, and nothing starts a timer of its own', () => {
	const process = declaredJobs().find((j) => j.name === 'sightline-process');
	assert.deepEqual(process, { name: 'sightline-process', schedule: '10s', handler: './jobs.ts#processDeliveriesJob' });
	// A stray setInterval puts that sweep back on every worker thread of every node,
	// in addition to the leader's occurrence.
	assert.doesNotMatch(jobsSource, /setInterval\(/, 'jobs.ts must not start interval timers; declare a scheduler job instead');
	assert.doesNotMatch(jobsSource, /startProcessingLoop/);
	assert.match(
		jobsSource,
		/^startPurgeBootPass\(\);$/m,
		'the purge keeps one post-deploy pass; the scheduler does not fire a new job on deploy',
	);
});

test('the processing time budget is shorter than the interval it runs on', () => {
	const UNIT_MS: Record<string, number> = { '': 1_000, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
	const [, amount, unit] = /^(\d+)([smhd]?)$/.exec(declaredJobs().find((j) => j.name === 'sightline-process')?.schedule ?? '') ?? [];
	const budget = /^const PROCESS_BUDGET_MS = ([\d_]+);$/m.exec(jobsSource)?.[1];
	assert.ok(amount && budget, 'could not read the sightline-process interval or PROCESS_BUDGET_MS');
	assert.ok(
		Number(budget.replaceAll('_', '')) < Number(amount) * UNIT_MS[unit],
		'PROCESS_BUDGET_MS must leave headroom inside the interval',
	);
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
