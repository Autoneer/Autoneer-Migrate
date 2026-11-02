# Changelog

## Unreleased

- feat(cleanup): add the post-migration Clean Up page (`/tools/cleanup`, left nav). Its WIP Cleanup card previews the jobs the Pulse card counts as Ready for Collection (buckets, by year, by month), releases the settled ones completed on or before a cut-off in batches (by bucket and completion year) after a confirm modal, writes a `JOB / RELEASED` row per job to the PWA job timeline dated on the completion date and marked as a migration clean-up, logs each batch in `migrate_job_releases` and can undo the last batch (timeline rows removed too); the GL WIP control is shown for reference
- feat(gl-backfill): each numbered GL Backfill (and Clean Up) card shows a small spinner in its header, in place of the green check, while it works out whether it is done, on page load and on every re-check
- feat(gl-backfill): the GL Backfill page opens with every card collapsed to its heading (the header check or spinner still shows); "Expand all" opens them
- fix(wizard): restore mapping step when reusing a plan so mapping is editable
- fix(dry-run): reload mapping profile before dry-run and persist to wizard state
- fix(runs): normalize runId lookups to avoid 404 in run monitor
- fix(executor): clamp per-table and global `batchSize` (1..10000) in runner and TableExecutor
- fix(validation): implement `validateCleanConfirm` to match tests
- test(mapping): add in-memory mapping persistence tests (scripts/test_mapping_persistence.js)
- fix(api): standardize JSON error responses for `/api` routes

## Notes

- Branch: `fix/wizard-run-stability`
- Tests: run `npm run test:all` to execute validation and mapping persistence tests.
- Manual verification required for full end-to-end flows (requires configured Firebird/MySQL databases). See README for local setup instructions.
