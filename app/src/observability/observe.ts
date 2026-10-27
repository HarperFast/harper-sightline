// Observability primitives (#22): PII-safe structured logging with correlation
// IDs, and an in-process metrics registry. There is no external metrics
// dependency — the registry is a plain in-memory tally that a periodic job emits
// as `ops.snapshot` log lines (jobs.ts). The staging log pipeline turns those
// lines into dashboards/alerts (wired under #25). Metrics carry NO
// merchant-identifying labels (plan §13): a metric is a bare name, never keyed
// by shop.

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

// Where a formatted log line goes. Defaults to console (matching the app's
// existing output); swappable so tests can capture lines and a deployment can
// route to Harper's logger.
export type LogSink = (level: LogLevel, line: string) => void;

const consoleSink: LogSink = (level, line) => {
	if (level === 'error') console.error(line);
	else if (level === 'warn') console.warn(line);
	else if (level === 'info') console.info(line);
	// trace/debug both map to console.debug — trace is the app's default level.
	else console.debug(line);
};

let sink: LogSink = consoleSink;

// Swap the log sink (tests, or a Harper-logger adapter). Passing null restores
// the default console sink.
export function setLogSink(next: LogSink | null): void {
	sink = next ?? consoleSink;
}

// ── Redaction ───────────────────────────────────────────────────────────────
// The security guarantee (plan §12/§13): a log line contains no token, HMAC,
// raw payload, secret, or customer PII. Enforced by key name (case-insensitive
// substring) so a careless caller cannot leak a sensitive value under a
// well-known key, plus a length cap so an unexpected key can't smuggle a whole
// raw payload into the log.
// Sensitive key detection is word-based, not substring-based. Substring matching
// is wrong in both directions: word-boundary regex misses camelCase/underscore
// variants (`firstName`, `authHeader`), while a bare substring over-matches
// structural fields (`authorization` matching `reauthorization`, our own
// ops-health count). Instead the key is tokenized into words (camelCase +
// delimiters) and any word matching a sensitive term redacts the value.
const SENSITIVE_WORDS = new Set([
	'token',
	'secret',
	'hmac',
	'authorization',
	'auth',
	'password',
	'payload',
	'cookie',
	'credential',
	'credentials',
	'email',
	'phone',
	'address',
	'customer',
	'name',
	'firstname',
	'lastname',
	'fullname',
]);

function keyWords(key: string): string[] {
	return key
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2') // split camelCase
		.split(/[^a-zA-Z0-9]+/) // split on _, -, ., etc.
		.map((word) => word.toLowerCase())
		.filter(Boolean);
}

export function isSensitiveKey(key: string): boolean {
	return keyWords(key).some((word) => SENSITIVE_WORDS.has(word));
}

export const REDACTED = '[redacted]';
const MAX_STRING = 256;

function cap(value: string): string {
	return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
}

function redactValue(value: unknown): unknown {
	if (typeof value === 'string') return cap(value);
	// Error instances have non-enumerable message/stack, so recursing would log
	// `{}` and lose the diagnostic. Flatten to a capped `Name: message` string.
	if (value instanceof Error) return cap(`${value.name}: ${value.message}`);
	if (Array.isArray(value)) return value.map(redactValue);
	if (value && typeof value === 'object') return redactFields(value as Record<string, unknown>);
	return value; // number | boolean | null | undefined
}

// Return a copy of `fields` with sensitive keys masked and long strings capped.
// Pure and exported so the guarantee is directly unit-tested.
export function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(fields)) {
		out[key] = isSensitiveKey(key) ? REDACTED : redactValue(value);
	}
	return out;
}

// ── Correlation IDs ───────────────────────────────────────────────────────────
// A per-process monotonic counter — enough to correlate the lines of one unit of
// work (a webhook delivery, a reconcile pass) within a process's logs. Not
// globally unique and intentionally not derived from time/randomness.
let cidSeq = 0;
export function correlationId(prefix = 'cid'): string {
	cidSeq = (cidSeq + 1) % 1_000_000_000;
	return `${prefix}-${cidSeq.toString(36)}`;
}

// ── Logging ─────────────────────────────────────────────────────────────────
// One structured line per call: `[sightline] {"level","event",...safe fields}`.
// Top-level handlers should log an error once; downstream code returns/throws and
// lets the handler log (no redundant error logging — engineering guidelines).
export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
	// Envelope (level/event) is spread LAST so a same-named field cannot clobber
	// the structural keys that alerts/log-parsing key off of.
	const record = { ...redactFields(fields), level, event };
	sink(level, `[sightline] ${JSON.stringify(record)}`);
}

// ── Metrics registry ──────────────────────────────────────────────────────────
export interface LatencySummary {
	count: number;
	sumMs: number;
	maxMs: number;
}
export interface MetricsSnapshot {
	counters: Record<string, number>;
	latencies: Record<string, LatencySummary>;
}

const counters = new Map<string, number>();
const latencies = new Map<string, LatencySummary>();

export const metrics = {
	// Increment a counter (default +1). Negative/large steps allowed.
	inc(name: string, by = 1): void {
		counters.set(name, (counters.get(name) ?? 0) + by);
	},
	// Record a latency observation in milliseconds (count/sum/max — enough for a
	// mean and a worst-case without an unbounded reservoir).
	observeMs(name: string, ms: number): void {
		const cur = latencies.get(name) ?? { count: 0, sumMs: 0, maxMs: 0 };
		cur.count += 1;
		cur.sumMs += ms;
		if (ms > cur.maxMs) cur.maxMs = ms;
		latencies.set(name, cur);
	},
	// A stable, name-sorted copy for logging/inspection. Counters and latencies
	// are cumulative for the process lifetime.
	snapshot(): MetricsSnapshot {
		const sortedCounters = [...counters.entries()].sort((a, b) => a[0].localeCompare(b[0]));
		const sortedLatencies = [...latencies.entries()].sort((a, b) => a[0].localeCompare(b[0]));
		return {
			counters: Object.fromEntries(sortedCounters),
			latencies: Object.fromEntries(sortedLatencies.map(([k, v]) => [k, { ...v }])),
		};
	},
	// Test hook — clears all accumulated metrics.
	reset(): void {
		counters.clear();
		latencies.clear();
	},
};

// Metric names. Centralized so instrumentation and the runbooks/alerts reference
// the same strings. Grouped by the plan §13 metric list.
export const M = {
	// Webhook ingress.
	webhookReceived: 'webhook.received',
	webhookHmacFail: 'webhook.hmac_fail',
	webhookBadRequest: 'webhook.bad_request',
	webhookAccepted: 'webhook.accepted',
	webhookDuplicate: 'webhook.duplicate',
	webhookAckMs: 'webhook.ack_ms',
	// Durable processing / dead-letter.
	processProcessed: 'process.processed',
	processFailed: 'process.failed',
	processDeadLettered: 'process.dead_lettered',
	processError: 'process.error',
	// An order rebuild read fewer events than the stored projection was built from
	// and was not written (src/ingest/orderRefresh.ts). Occasional counts are
	// concurrent writers racing; a steady climb means the guard is starving writes.
	projectionStaleSkipped: 'projection.stale_skipped',
	// Detector sweep.
	detectEvaluated: 'detect.evaluated',
	detectError: 'detect.error',
	// Reconciliation.
	reconcileShops: 'reconcile.shops',
	reconcileOrders: 'reconcile.orders',
	reconcileMs: 'reconcile.ms',
	reconcileError: 'reconcile.error',
	// Shopify rate-limited the sweep. Split out of reconcileError because it means
	// something different operationally: a fault vs. asking for more than the
	// shop's quota grants. A sustained non-zero count here (with reconcile cursors
	// still advancing) is the signal to shrink the page size or lengthen the
	// interval, not to go looking for a bug.
	reconcileThrottled: 'reconcile.throttled',
	// Retention purge. (Residue/backlog are point-in-time gauges, reported by the
	// ops.snapshot from computeOpsHealth — not cumulative counters.)
	purgeDeleted: 'purge.deleted',
	purgeFailure: 'purge.failure',
	purgeError: 'purge.error',
	// Inventory enrichment (#13 follow-up). Items/locations resolved (including
	// tombstones) and EventSku rows backfilled per tick, plus a failure counter —
	// without these, ops.snapshot was blind to this loop entirely.
	enrichItems: 'enrich.items',
	enrichLocations: 'enrich.locations',
	enrichIndexed: 'enrich.indexed',
	enrichError: 'enrich.error',
	// One-time backfill of the derived `state` column on projections written before
	// it existed (src/jobs/stateBackfill.ts). `fixed` must fall to zero and stay there
	// once the sweep converges; a non-zero `fixed` long after a deploy means new
	// stateless rows are being written from somewhere, which would be a defect.
	stateBackfillScanned: 'state_backfill.scanned',
	stateBackfillFixed: 'state_backfill.fixed',
	stateBackfillError: 'state_backfill.error',
	// A background loop's previous pass failed to settle within its stall budget
	// and a new pass was started anyway (src/jobs/tick.ts). Non-zero means a loop hung.
	tickStalled: 'tick.stalled',
	// A read was refused by the per-shop request limiter, and an export by the
	// tighter export limiter (src/auth/rateLimit.ts). Counted separately because
	// they mean different things: the first is a caller asking far more often than a
	// merchant can click, the second is repeated full-ledger exports. Either being
	// non-zero in normal operation means the limit is wrong for real use — the
	// limits are set to sit far above it — so this is the signal to raise them, not
	// to leave a merchant throttled.
	rateLimitedRequests: 'rate_limit.requests',
	rateLimitedExports: 'rate_limit.exports',
} as const;
