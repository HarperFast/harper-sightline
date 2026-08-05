import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactFields, REDACTED, log, setLogSink, correlationId, metrics, M, type LogLevel } from '../src/observe.ts';

test('redactFields masks sensitive keys (case-insensitive)', () => {
	const out = redactFields({
		accessToken: 'shpat_secret',
		Secret: 'x',
		'x-shopify-hmac-sha256': 'abc',
		Authorization: 'Bearer y',
		password: 'pw',
		payload: '{"lots":"of data"}',
		cookie: 'sid=1',
		credential: 'env',
		email: 'a@b.com',
		phone: '+15551234567',
		address: '1 Main St',
		customerId: 'gid://Customer/1',
		auth: 'z',
		name: 'Jane Doe',
	});
	for (const key of Object.keys(out)) {
		assert.equal(out[key], REDACTED, `${key} should be redacted`);
	}
});

test('redactFields masks camelCase/underscore PII and auth key variants', () => {
	const out = redactFields({ firstName: 'Jane', last_name: 'Doe', fullName: 'Jane Doe', authHeader: 'Bearer z', authToken: 'shpat_x' });
	for (const key of Object.keys(out)) assert.equal(out[key], REDACTED, `${key} should be redacted`);
});

test('redactFields flattens Error values to a Name: message string (not {})', () => {
	const out = redactFields({ err: new TypeError('kaboom') }) as { err: string };
	assert.equal(out.err, 'TypeError: kaboom');
});

test('log envelope level/event cannot be clobbered by same-named fields', () => {
	const lines: string[] = [];
	setLogSink((_level: LogLevel, line: string) => lines.push(line));
	try {
		log('info', 'ops.snapshot', { level: 'trace', event: 'spoofed', backlog: 3 });
	} finally {
		setLogSink(null);
	}
	const record = JSON.parse(lines[0].replace('[sightline] ', ''));
	assert.equal(record.level, 'info');
	assert.equal(record.event, 'ops.snapshot');
	assert.equal(record.backlog, 3);
});

test('redactFields keeps safe operational keys', () => {
	const out = redactFields({ shopId: 'demo.myshopify.com', topic: 'orders/paid', orderId: '123', count: 4, healthy: true });
	assert.deepEqual(out, { shopId: 'demo.myshopify.com', topic: 'orders/paid', orderId: '123', count: 4, healthy: true });
});

test('redactFields does not clobber structural keys that merely contain a sensitive substring', () => {
	// `reauthorization` contains "authorization"; substring matching would wrongly
	// redact the ops-health count. Word-based matching keeps it visible.
	const health = { reauthorization: { shops: 2 }, reconciliation: { staleShops: 0 }, deadLetter: { count: 0 } };
	const out = redactFields(health);
	assert.deepEqual(out, health);
});

test('redactFields recurses into nested objects and arrays', () => {
	const out = redactFields({ health: { token: 't', backlog: 3 }, items: [{ secret: 's', ok: 1 }] });
	assert.deepEqual(out, { health: { token: REDACTED, backlog: 3 }, items: [{ secret: REDACTED, ok: 1 }] });
});

test('redactFields caps long strings so a raw payload cannot leak under a safe key', () => {
	const big = 'a'.repeat(1000);
	const out = redactFields({ note: big }) as { note: string };
	assert.ok(out.note.length < big.length);
	assert.ok(out.note.endsWith('…[truncated]'));
});

test('log routes fields through redaction before the sink sees them', () => {
	const lines: string[] = [];
	setLogSink((_level: LogLevel, line: string) => lines.push(line));
	try {
		log('trace', 'webhook.accepted', { token: 'shpat_leak', topic: 'orders/paid' });
	} finally {
		setLogSink(null);
	}
	assert.equal(lines.length, 1);
	assert.ok(!lines[0].includes('shpat_leak'), 'token value must never reach the sink');
	assert.ok(lines[0].includes('orders/paid'));
	assert.ok(lines[0].includes(REDACTED));
});

test('log passes the level through to the sink', () => {
	const seen: LogLevel[] = [];
	setLogSink((level: LogLevel) => seen.push(level));
	try {
		log('warn', 'purge.residue', { residue: 5 });
		log('error', 'process.error', { message: 'boom' });
	} finally {
		setLogSink(null);
	}
	assert.deepEqual(seen, ['warn', 'error']);
});

test('correlationId is unique and prefixed', () => {
	const a = correlationId('ing');
	const b = correlationId('ing');
	assert.notEqual(a, b);
	assert.ok(a.startsWith('ing-'));
});

test('metrics counters accumulate and snapshot is sorted', () => {
	metrics.reset();
	metrics.inc(M.webhookReceived);
	metrics.inc(M.webhookReceived, 2);
	metrics.inc(M.webhookAccepted);
	const snap = metrics.snapshot();
	assert.equal(snap.counters[M.webhookReceived], 3);
	assert.equal(snap.counters[M.webhookAccepted], 1);
	const keys = Object.keys(snap.counters);
	assert.deepEqual(keys, keys.slice().sort());
});

test('metrics latency tracks count, sum, and max', () => {
	metrics.reset();
	metrics.observeMs(M.webhookAckMs, 10);
	metrics.observeMs(M.webhookAckMs, 30);
	metrics.observeMs(M.webhookAckMs, 20);
	const summary = metrics.snapshot().latencies[M.webhookAckMs];
	assert.deepEqual(summary, { count: 3, sumMs: 60, maxMs: 30 });
});

test('metrics.reset clears everything', () => {
	metrics.inc(M.processProcessed, 5);
	metrics.reset();
	const snap = metrics.snapshot();
	assert.deepEqual(snap.counters, {});
	assert.deepEqual(snap.latencies, {});
});
