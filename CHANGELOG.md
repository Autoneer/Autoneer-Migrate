# Changelog

## Unreleased

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
