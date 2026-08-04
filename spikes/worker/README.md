# Spike B — Durable Worker Recovery & Single-Active Leadership

Throwaway evidence that Harper 5.2.0 gives durable background processing that
resumes after a restart and never double-processes under concurrent/clustered
workers. Not the production scaffold.

## Durable model

- `inbox { id (pk), payload, receivedAt }` — accepted deliveries.
- `result { id (pk = inbox id), processedBy, processedAt }` — one row per
  processed delivery.

**Processing** delivery `D` = a single-winner `insert` of `{ id: D }` into
`result`. Because the primary-key insert is atomic (Spike A finding), exactly
one worker wins per delivery — processing is **exactly-once regardless of worker
or node count**. **Unprocessed** = inbox ids with no `result` row; a restarted
worker's startup scan reprocesses them. An optional `worker_lease` gives
single-active *scheduling* efficiency, but correctness never depends on it.

## Running the live proofs

Creds come from env; nothing secret is committed. Uses a throwaway `spikeb`
database and drops its tables on cleanup.

```bash
export HARPER_OPS_URL='https://<host>:9925/' HARPER_USER=... HARPER_PASS=...
export NODE_TLS_REJECT_UNAUTHORIZED=0   # dev instance

node live/seed.mjs                      # seed N accepted deliveries
CRASH_AFTER=20 node live/worker.mjs || true   # crash mid-run
node live/worker.mjs                    # restart: resume remaining
node live/verify.mjs                    # assert exactly-once, then drop tables

node live/concurrent.mjs                # K=4 workers, exactly-once across all
node live/lease.mjs                     # single-active lease + TTL takeover
```

## Offline logic

`node --test 'test/*.test.ts'` — pure `processInbox` / `lease` logic.
