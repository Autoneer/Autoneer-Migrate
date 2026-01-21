Logs and nodemon

- All migration run logs are written under `logs/migrate` at the repository root (e.g. `logs/migrate/<runId>.log`).
- The logger writes into `logs/migrate` (outside the `src/` tree) so runtime logging will not trigger nodemon restarts.
- `nodemon.json` now ignores `logs/**`, `*.log`, and `data/**` to prevent unnecessary restarts when logs or cache files are written.

Why this matters

- Previously some runtime artifacts could cause `nodemon` to detect file changes and restart the server during long-running migration runs. That could leave the UI in a stale state and abort progress.
- Writing logs outside `src/` and explicitly ignoring them in `nodemon.json` makes server restarts deterministic and avoids accidental restarts during a migration.

If you want to change the logs location

- Edit `src/migrate/logger.js` and `nodemon.json` together.
- Ensure the logs directory is outside `src/` or added to the `ignore` list in `nodemon.json`.
