// Component boot side effects, in order. resources.ts imports this first so the log
// sink and raw-body handler are in place before anything logs or parses a request.
import { contentTypes } from 'harper';
import '../../jobs.ts'; // starts nothing on import: every sweep is a config.yaml scheduler job
import { log } from '../observability/observe.ts';
import { installHarperLogSink } from '../observability/harperLogSink.ts';

// Routes logs into Harper's logger so they are reachable via `read_log`.
const logSinkInstalled = installHarperLogSink();
log('info', 'boot.logsink', { sink: logSinkInstalled ? 'harper' : 'console' });

// Preserve the raw body so the webhook HMAC can be verified before parsing (Harper
// otherwise consumes the bytes); the webhook parses it itself after verifying (ADR-001).
contentTypes.set('application/json', {
	serialize: (data) => Buffer.from(JSON.stringify(data)),
	deserialize: (raw) => raw,
	q: 1,
});
