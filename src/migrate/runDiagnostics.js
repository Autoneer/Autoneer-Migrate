// Shared diagnostics for live runs, saved results, and exports.
function parseJson(value, fallback = {}) {
	if (value && typeof value === 'object') return value;
	try { return JSON.parse(value) || fallback; } catch { return fallback; }
}

function explainError(message, hint) {
	const raw = String(message || 'Unknown error');
	const duplicate = raw.match(/Duplicate entry '(.+)' for key '([^']+)'/i);
	if (duplicate) {
		const [, value, constraint] = duplicate;
		if (constraint.toLowerCase().endsWith('uq_invoices_active_job')) {
			return {
				code: 'INVOICE_ACTIVE_JOB_CONFLICT', constraint, value, column: 'job_number',
				reason: value === '0'
					? 'Legacy invoices with job number 0 are being treated as active invoices for the same job. The target allows only one active invoice per job.'
					: `More than one invoice is being treated as active for job ${value}. The target allows only one active invoice per job.`,
				action: (value === '0'
					? 'If job number 0 means no job, exclude that sentinel from the target job_number_active key while retaining the unique rule for real jobs. '
					: 'Check that legacy SPLITNR values populate is_split_invoice. For non-split conflicts, review which invoice remains active and how the others should be classified. ')
					+ 'Preserve invoice numbers and job links; do not bypass this by skipping duplicates, re-keying invoices, or marking every imported invoice historical.'
			};
		}
		return { code: 'DUPLICATE_KEY', constraint, value,
			reason: `The value ${value} already exists for the unique key ${constraint}.`,
			action: 'Compare the source record with the existing target record. Reconcile partially imported records before retrying; preserve original invoice identities.' };
	}
	if (/cannot be null|doesn't have a default value/i.test(raw)) {
		return { code: 'REQUIRED_VALUE', reason: 'A required target field has no value.', action: 'Review the column mapping and source data. Supply a valid value or default for the required field.' };
	}
	if (/foreign key constraint fails/i.test(raw)) {
		return { code: 'MISSING_REFERENCE', reason: 'A record refers to a related record that is missing from the target.', action: 'Check the referenced record and migrate its parent table first, then retry.' };
	}
	if (/user name and password are not defined|access denied/i.test(raw)) {
		return { code: 'CONNECTION_AUTH', reason: 'The database rejected the login credentials.', action: 'Check the connection settings and test the database login before retrying.' };
	}
	return { code: 'MIGRATION_ERROR', reason: raw, action: hint || 'Review the technical detail, mapping, and target schema before retrying.' };
}

function normalizeRowError(error) {
	const table = error.table_name || error.table || null;
	const data = parseJson(error.row_json);
	const message = error.error_message || error.message || error.error || 'Unknown error';
	const detail = explainError(message, error.hint);
	// Older logs incorrectly used the first mapped field (ACC) as the invoice PK.
	const invoiceKey = Object.keys(data).find(key => ['inv_nr', 'invoice_nr'].includes(key.toLowerCase()));
	const row = String(table).toLowerCase() === 'invoices' && invoiceKey
		? data[invoiceKey] : (error.source_pk ?? error.row_offset ?? null);
	return { table, message, timestamp: error.created_at || error.timestamp || null,
		row, rowOffset: error.row_offset ?? null, sourceTable: error.source_table || table,
		column: error.field_name || detail.column || null, value: error.value ?? detail.value ?? null,
		stack: error.stack || null,
		...detail };
}

function groupErrors(errors) {
	const groups = new Map();
	for (const error of errors) {
		const key = JSON.stringify([error.table, error.message]);
		if (!groups.has(key)) groups.set(key, { ...error, count: 0, sampleRows: [] });
		const group = groups.get(key);
		group.count += 1;
		if (error.row != null && group.sampleRows.length < 5) group.sampleRows.push(error.row);
	}
	return [...groups.values()].sort((a, b) => b.count - a.count);
}

function buildRunSummary(run, tables = [], plannedTables = [], rawErrors = []) {
	const snapshot = parseJson(run.table_summary_json);
	const names = [...new Set([...plannedTables, ...Object.keys(snapshot), ...tables.map(t => t.table_name)]
		.filter(Boolean).map(name => String(name).toLowerCase()))];
	const ended = run.ended_at || run.completed_at || run.finished_at;
	const duration = (start, end) => start && end ? Math.max(0, new Date(end) - new Date(start)) : null;
	const tableDetails = names.map(name => {
		const saved = Object.entries(snapshot).find(([key]) => key.toLowerCase() === name)?.[1] || {};
		const record = tables.find(t => String(t.table_name).toLowerCase() === name);
		const t = { ...saved, ...record };
		return { name, status: t.status || 'NOT_RUN', rowsMigrated: Number(t.rows_migrated || 0),
			rowsInserted: Number(t.rows_inserted || 0), rowsUpdated: Number(t.rows_updated || 0), rowsError: Number(t.rows_error || 0),
			rowsSkipped: Number(t.rows_skipped_duplicates || 0), errorCount: Number(t.rows_error || 0),
			duration: t.duration_ms || duration(t.started_at, t.finished_at), errorMessage: t.error_message || null };
	});
	const errors = rawErrors.map(normalizeRowError);
	const errorGroups = groupErrors(errors);
	// Preflight and table-level failures need a cause even when there are no row errors.
	for (const table of tableDetails.filter(t => t.errorMessage && !errors.some(e => String(e.table).toLowerCase() === t.name))) {
		errorGroups.push({ table: table.name, message: table.errorMessage, ...explainError(table.errorMessage), count: 1, sampleRows: [] });
	}
	if (!errorGroups.length && run.error_message) {
		errorGroups.push({ table: null, message: run.error_message, ...explainError(run.error_message), count: 1, sampleRows: [] });
	}
	const status = value => String(value || '').toUpperCase();
	const successCount = tableDetails.filter(t => ['SUCCESS', 'COMPLETED'].includes(status(t.status))).length;
	const failedCount = tableDetails.filter(t => ['FAILED', 'ERROR'].includes(status(t.status))).length;
	const notRunCount = tableDetails.filter(t => ['NOT_RUN', 'PENDING', 'QUEUED'].includes(status(t.status))).length;
	const rowErrorCount = Math.max(errors.length, Number(run.error_count || 0), tableDetails.reduce((sum, t) => sum + t.errorCount, 0));
	const totalRows = tableDetails.reduce((sum, t) => sum + t.rowsMigrated, 0);
	return { runId: run.run_id || run.id, status: run.status, dryRun: run.dry_run,
		startedAt: run.started_at, completedAt: ended, duration: duration(run.started_at, ended), durationMs: duration(run.started_at, ended),
		tableCount: names.length, totalTables: names.length, successCount, tablesMigrated: successCount,
		failedCount, notRunCount, rowErrorCount, errorCount: rowErrorCount || errorGroups.length,
		totalRows, rowsMigrated: totalRows, tableDetails, errorGroups,
		tables: { total: names.length, completed: successCount, failed: failedCount, pending: notRunCount },
		rows: { migrated: totalRows, errors: rowErrorCount,
			inserted: tableDetails.reduce((sum, t) => sum + t.rowsInserted, 0),
			updated: tableDetails.reduce((sum, t) => sum + t.rowsUpdated, 0),
			skipped: tableDetails.reduce((sum, t) => sum + t.rowsSkipped, 0) },
		errors: errorGroups.map(e => ({ tableName: e.table, message: e.message })) };
}

module.exports = { explainError, normalizeRowError, groupErrors, buildRunSummary };
