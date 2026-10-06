const count = value => Math.max(0, Number(value) || 0);

function normalizeTableStatus(value) {
	const status = String(value || '').toUpperCase();
	if (['SUCCESS', 'COMPLETED'].includes(status)) return 'completed';
	if (status === 'RUNNING') return 'running';
	if (status === 'FAILED') return 'failed';
	if (['CANCELLED', 'STOPPED', 'SKIPPED'].includes(status)) return 'skipped';
	return 'pending';
}

function normalizeTables(tables, now = Date.now()) {
	return (tables || []).map(table => {
		const status = normalizeTableStatus(table.status || table.state);
		const rowsMigrated = count(table.migrated ?? table.rowsMigrated ?? table.rows_migrated);
		const skippedDuplicates = count(table.skippedDuplicates ?? table.rowsSkipped ?? table.rows_skipped_duplicates);
		const errors = count(table.errors ?? table.rowsError ?? table.rows_error);
		const total = table.total ?? table.totalRows ?? table.rows_source;
		const totalRows = total == null ? null : count(total);
		// A row has been processed whether it was written, skipped, or rejected.
		// Live counters also advance during a slow per-row batch fallback.
		const rowsProcessed = Math.max(count(table.processed ?? table.rowsProcessed ?? table.last_offset), rowsMigrated + skippedDuplicates + errors);
		const progress = totalRows > 0 ? Math.min(100, Math.floor(rowsProcessed / totalRows * 100)) : status === 'completed' ? 100 : 0;
		const started = new Date(table.startedAt || table.started_at || NaN).getTime();
		const finished = new Date(table.finishedAt || table.finished_at || NaN).getTime();
		const measuredDuration = Number.isFinite(started) && (status === 'running' || Number.isFinite(finished))
			? Math.max(0, (status === 'running' ? now : finished) - started) : 0;
		return {
			table: table.name || table.table || table.table_name || '',
			status,
			phase: table.phase || (status === 'running' ? 'migrating' : status),
			rowsProcessed, rowsMigrated, totalRows, progress,
			duration: Math.max(count(table.durationMs ?? table.duration_ms ?? table.duration), measuredDuration),
			inserted: count(table.inserted ?? table.rowsInserted ?? table.rows_inserted),
			updated: count(table.updated ?? table.rowsUpdated ?? table.rows_updated),
			skippedDuplicates, errors,
			lastError: table.lastError ?? table.error_message ?? null
		};
	});
}

function buildRunProgress(run, tableStates, now = Date.now()) {
	const tables = normalizeTables(tableStates, now);
	const tablesCompleted = tables.filter(table => table.status === 'completed').length;
	const tablesFailed = tables.filter(table => table.status === 'failed').length;
	const active = tables.find(table => table.status === 'running');
	const fraction = tables.reduce((sum, table) => sum + (table.status === 'completed' ? 1 : table.progress / 100), 0);
	const percent = tables.length ? Math.floor(fraction / tables.length * 100) : 0;
	return {
		success: true,
		runId: run.runId ?? run.run_id ?? run.id,
		status: run.status,
		progress: percent,
		percent,
		estimatedSecondsRemaining: null,
		currentTable: active?.table || null,
		tables,
		tablesCompleted,
		tablesTotal: tables.length,
		tablesFailed
	};
}

module.exports = { normalizeTableStatus, normalizeTables, buildRunProgress };
