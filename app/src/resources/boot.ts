// Component boot side effects, in the order they have to happen. resources.ts
// imports this FIRST, before any resource module, so the log sink and the raw-body
// content-type handler are in place before anything can log or parse a request.
import { contentTypes } from 'harper';
import '../../jobs.ts'; // starts the background processing loop on component load
import { log } from '../observe.ts';
import { installHarperLogSink } from '../harperLogSink.ts';

// Route logs into Harper's logger before anything else logs, so the ops.snapshot
// heartbeat and every error line are reachable via the operations API's read_log
// rather than going to stdout where nothing can query them.
const logSinkInstalled = installHarperLogSink();
log('info', 'boot.logsink', { sink: logSinkInstalled ? 'harper' : 'console' });

// Preserve the RAW request body so webhook HMAC can be verified before parsing
// (Harper otherwise parses application/json and consumes the bytes). We keep the
// raw Buffer as the deserialized value; the webhook is the only JSON-body
// consumer and parses it itself after verifying (ADR-001, plan §12).
contentTypes.set('application/json', {
	serialize: (data) => Buffer.from(JSON.stringify(data)),
	deserialize: (raw) => raw,
	q: 1,
});
