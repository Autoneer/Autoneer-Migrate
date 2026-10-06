const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTables, buildRunProgress } = require('../src/migrate/runProgress');

test('processed rows include writes, skipped records and row failures', () => {
	const tables = normalizeTables([
		{ name: 'banks', status: 'SUCCESS', total: 0 },
		{ name: 'staff', status: 'SUCCESS', total: 38, migrated: 1, skippedDuplicates: 37 },
		{ name: 'stock', status: 'SUCCESS', total: 47977, migrated: 0, skippedDuplicates: 47977 },
		{ name: 'invoices', status: 'RUNNING', total: 55903, processed: 41020, errors: 41020 },
		{ name: 'payments', status: 'QUEUED', total: null }
	]);
	assert.deepEqual(tables.map(t => t.rowsProcessed), [0, 38, 47977, 41020, 0]);
	assert.deepEqual(tables.map(t => t.progress), [100, 100, 100, 73, 0]);
	assert.equal(tables[2].rowsMigrated, 0);
	assert.equal(tables[3].status, 'running');
	assert.equal(tables[0].totalRows, 0);
	assert.equal(tables[4].totalRows, null);
});

test('stored progress retains source totals, outcomes and finished duration', () => {
	const [table] = normalizeTables([{ table_name: 'stock', status: 'success', rows_source: 47977,
		last_offset: 47977, rows_migrated: 0, rows_skipped_duplicates: 47977,
		started_at: '2026-10-06T08:00:00Z', finished_at: '2026-10-06T08:00:18Z' }]);
	assert.equal(table.rowsProcessed, table.totalRows);
	assert.equal(table.progress, 100);
	assert.equal(table.duration, 18000);
});

test('validation keeps the table active after all rows are processed; run order and total are preserved', () => {
	const result = buildRunProgress({ runId: 3, status: 'RUNNING' }, [
		{ name: 'stock', status: 'SUCCESS', total: 10, skippedDuplicates: 10 },
		{ name: 'invoices', status: 'RUNNING', total: 5, migrated: 5, phase: 'validating', startedAt: '2026-10-06T08:00:00Z' },
		{ name: 'customers', status: 'QUEUED' }
	], Date.parse('2026-10-06T08:00:25Z'));
	assert.equal(result.currentTable, 'invoices');
	assert.equal(result.tablesCompleted, 1);
	assert.equal(result.tablesTotal, 3);
	assert.deepEqual(result.tables.map(t => t.table), ['stock', 'invoices', 'customers']);
	assert.equal(result.tables[1].phase, 'validating');
	assert.equal(result.tables[1].progress, 100);
	assert.equal(result.tables[1].duration, 25000);
});
