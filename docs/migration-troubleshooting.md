# Migration Troubleshooting

## Root cause: “Connection lost” while rows still inserted

We confirmed that the migration runner continues processing batches even if the SSE progress stream drops. Previously, the UI treated any connectivity check failure or SSE disconnect as a fatal run error and triggered a failure modal + abort request. The runner itself did not fail, so rows kept inserting while the UI showed a failure.

### Mitigation

- Progress SSE now includes heartbeats and auto-reconnect. UI shows a non-fatal “Progress connection lost” warning and resumes when reconnected.
- Health polling never aborts a run on a single failure. It retries and only aborts after consecutive failures and a final confirmation.
- Run status is server-authoritative via the status endpoint; UI does not infer failure from stream drops.

If the runner fails (database down, schema mismatch, permissions), the run is marked FAILED and the UI shows a failure modal with the runner-provided error and guidance.
