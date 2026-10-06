const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRunSummary, normalizeRowError, explainError } = require('../src/migrate/runDiagnostics');

test('saved partial run reports planned tables, row failures, duration and correct source invoice IDs', () => {
	const message = "Duplicate entry '0' for key 'invoices.uq_invoices_active_job'";
	const errors = Array.from({ length: 364 }, (_, i) => ({ table_name: 'invoices', source_pk: '3993200',
		error_message: message, row_offset: i, row_json: JSON.stringify({ acc: 3993200, inv_nr: 6000 + i, job_number: 0 }) }));
	const tables = ['banks', 'staff', 'stock', 'accounts'].map(table_name => ({ table_name, status: 'success' }));
	tables.push({ table_name: 'invoices', status: 'failed', rows_error: 364, rows_migrated: 55539 });
	const planned = [...tables.map(t => t.table_name), ...Array.from({ length: 16 }, (_, i) => `pending_${i}`)];
	const summary = buildRunSummary({ status: 'FAILED', started_at: '2026-10-06T07:31:43Z', ended_at: '2026-10-06T07:33:33Z', error_count: 364 }, tables, planned, errors);
	assert.equal(summary.tableCount, 21);
	assert.equal(summary.successCount, 4);
	assert.equal(summary.notRunCount, 16);
	assert.equal(summary.failedCount, 1);
	assert.equal(summary.errorCount, 364);
	assert.equal(summary.duration, 110000);
	assert.equal(summary.errorGroups.length, 1);
	assert.equal(summary.errorGroups[0].count, 364);
	assert.deepEqual(summary.errorGroups[0].sampleRows, [6000, 6001, 6002, 6003, 6004]);
	assert.match(summary.errorGroups[0].reason, /job number 0/);
	assert.equal(normalizeRowError(errors[0]).rowOffset, 0);
});

test('preflight failure still has actionable results with zero attempted tables', () => {
	const summary = buildRunSummary({ status: 'FAILED', error_message: 'Access denied for user',
		table_summary_json: JSON.stringify({ invoices: { status: 'NOT_RUN' } }) });
	assert.equal(summary.tableCount, 1);
	assert.equal(summary.notRunCount, 1);
	assert.equal(summary.rowErrorCount, 0);
	assert.equal(summary.errorGroups[0].code, 'CONNECTION_AUTH');
});

test('distinct real job conflicts and primary key conflicts retain technical detail', () => {
	const job = explainError("Duplicate entry '5617' for key 'invoices.uq_invoices_active_job'");
	assert.equal(job.value, '5617');
	assert.match(job.reason, /job 5617/);
	assert.match(job.action, /Preserve invoice numbers/);
	const primary = explainError("Duplicate entry '6968' for key 'invoices.PRIMARY'");
	assert.equal(primary.code, 'DUPLICATE_KEY');
	assert.match(primary.action, /partially imported/);
});

test('numeric strings do not concatenate and snapshots tolerate case differences', () => {
	const summary = buildRunSummary({ status: 'SUCCESS', table_summary_json: { INVOICES: { status: 'NOT_RUN' } } },
		[{ table_name: 'invoices', status: 'success', rows_migrated: '12', rows_error: '0' }], ['INVOICES']);
	assert.equal(summary.tableCount, 1);
	assert.equal(summary.totalRows, 12);
	assert.equal(summary.errorCount, 0);
	assert.equal(summary.successCount, 1);
});
