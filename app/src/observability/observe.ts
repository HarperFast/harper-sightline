// PII-safe structured logging with correlation ids, and an in-process metrics
// registry that a periodic job emits as `ops.snapshot` log lines (jobs.ts). Metrics
// carry no merchant-identifying labels: a metric is a bare name, never keyed by shop.

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

// Where a formatted log line goes; swappable so tests can capture lines.
export type LogSink = (level: LogLevel, line: string) => void;

const consoleSink: LogSink = (level, line) => {
	if (level === 'error') console.error(line);
	else if (level === 'warn') console.warn(line);
	else if (level === 'info') console.info(line);
	// trace/debug both map to console.debug — trace is the app's default level.
	else console.debug(line);
};

let sink: LogSink = consoleSink;

export function setLogSink(next: LogSink | null): void {
	sink = next ?? consoleSink;
}

// A log line contains no token, HMAC, raw payload, secret or customer PII. Enforced
// by key name, plus a length cap so an unexpected key cannot smuggle a whole payload.
// Word-based, not substring: a bare substring over-matches structural fields
// (`authorization` in `reauthorization`, our own ops-health count), while a
// word-boundary regex misses camelCase variants (`firstName`). Keys are tokenized
// into words and any word matching a sensitive term redacts the value.
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
		.split(/[^a-zA-Z0-9]+/)
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
	return value;
}

export function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(fields)) {
		out[key] = isSensitiveKey(key) ? REDACTED : redactValue(value);
	}
	return out;
}

// Per-process monotonic counter; correlates one unit of work within a process's logs.
let cidSeq = 0;
export function correlationId(prefix = 'cid'): string {
	cidSeq = (cidSeq + 1) % 1_000_000_000;
	return `${prefix}-${cidSeq.toString(36)}`;
}

// One structured line per call. Top-level handlers log an error once; downstream
// code returns or throws.
export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
	// Envelope (level/event) is spread LAST so a same-named field cannot clobber
	// the structural keys that alerts/log-parsing key off of.
	const record = { ...redactFields(fields), level, event };
	sink(level, `[sightline] ${JSON.stringify(record)}`);
}

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
	inc(name: string, by = 1): void {
		counters.set(name, (counters.get(name) ?? 0) + by);
	},
	// count/sum/max: a mean and a worst case without an unbounded reservoir.
	observeMs(name: string, ms: number): void {
		const cur = latencies.get(name) ?? { count: 0, sumMs: 0, maxMs: 0 };
		cur.count += 1;
		cur.sumMs += ms;
		if (ms > cur.maxMs) cur.maxMs = ms;
		latencies.set(name, cur);
	},
	// Name-sorted copy; cumulative for the process lifetime.
	snapshot(): MetricsSnapshot {
		const sortedCounters = [...counters.entries()].sort((a, b) => a[0].localeCompare(b[0]));
		const sortedLatencies = [...latencies.entries()].sort((a, b) => a[0].localeCompare(b[0]));
		return {
			counters: Object.fromEntries(sortedCounters),
			latencies: Object.fromEntries(sortedLatencies.map(([k, v]) => [k, { ...v }])),
		};
	},
	reset(): void {
		counters.clear();
		latencies.clear();
	},
};

// Metric names, centralized so instrumentation and runbooks use the same strings.
export const M = {
	// Webhook ingress.
	webhookReceived: 'webhook.received',
	webhookSignatureFail: 'webhook.signature_fail',
	webhookBadRequest: 'webhook.bad_request',
	webhookUnknownShop: 'webhook.unknown_shop',
	webhookAccepted: 'webhook.accepted',
	webhookDuplicate: 'webhook.duplicate',
	webhookAckMs: 'webhook.ack_ms',
	// Durable processing / dead-letter.
	processProcessed: 'process.processed',
	processFailed: 'process.failed',
	processDeadLettered: 'process.dead_lettered',
	processError: 'process.error',
	// SKUs past MAX_EVENT_SKUS (src/ingest/normalize.ts), left out of the SKU filter.
	// Should stay zero: the cap sits at a Shopify cart's line limit.
	processSkusDropped: 'process.skus_dropped',
	// An order rebuild read fewer events than the stored projection was built from and
	// was not written (src/ingest/orderRefresh.ts). Occasional counts are concurrent
	// writers racing; a steady climb means the guard is starving writes. The guard
	// assumes a read sees every prior write: OperationalEvent replicates asynchronously,
	// so a node can skip a rebuild that carries an event another node's row lacks.
	projectionStaleSkipped: 'projection.stale_skipped',
	// Detector sweep.
	detectEvaluated: 'detect.evaluated',
	detectError: 'detect.error',
	// Reconciliation.
	reconcileShops: 'reconcile.shops',
	reconcileOrders: 'reconcile.orders',
	reconcileMs: 'reconcile.ms',
	reconcileError: 'reconcile.error',
	// Split from reconcileError: a throttle means the sweep asked for more than the
	// shop's quota. Sustained non-zero with advancing cursors means shrink the page
	// size or lengthen the interval, not look for a bug.
	reconcileThrottled: 'reconcile.throttled',
	// Retention purge. Residue and backlog are gauges from computeOpsHealth, not counters.
	purgeDeleted: 'purge.deleted',
	purgeFailure: 'purge.failure',
	purgeError: 'purge.error',
	// Inventory enrichment: items and locations resolved (including tombstones), EventSku rows backfilled.
	enrichItems: 'enrich.items',
	enrichLocations: 'enrich.locations',
	enrichIndexed: 'enrich.indexed',
	enrichError: 'enrich.error',
	// Projections backfilled with the derived `state` column (src/jobs/stateBackfill.ts).
	// `fixed` should reach zero; non-zero long after a deploy means stateless rows are
	// still being written.
	stateBackfillScanned: 'state_backfill.scanned',
	stateBackfillFixed: 'state_backfill.fixed',
	stateBackfillError: 'state_backfill.error',
	// A pass failed to settle within its stall budget and a new one started (src/jobs/tick.ts).
	tickStalled: 'tick.stalled',
	// Reads refused by the per-shop limiter, and exports by the tighter export limiter
	// (src/auth/rateLimit.ts). Non-zero in normal use means the limit is too low for real use.
	rateLimitedRequests: 'rate_limit.requests',
	rateLimitedExports: 'rate_limit.exports',
} as const;
