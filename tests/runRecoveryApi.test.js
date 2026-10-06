const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('../src/db/mysql');
const runStore = require('../src/migrate/runStore');
const runner = require('../src/migrate/runner');
const { state } = require('../src/config/state');
const router = require('../src/routes/api/runs');
const fs = require('node:fs');
const logger = require('../src/migrate/logger');

test('table-result log view filters before limiting and keeps detailed logs available', async t => {
	const final = { phase: 'table_finalize', tableName: 'stock', status: 'success' };
	const entries = [final, ...Array.from({ length: 300 }, (_, i) => ({ phase: 'row_error', error: `Duplicate ${i}` }))];
	t.mock.method(logger, 'getTableResultBuffer', () => null);
	t.mock.method(logger, 'getLogBuffer', () => []);
	t.mock.method(fs.promises, 'readFile', async () => entries.map(entry => JSON.stringify(entry)).join('\n'));
	const handler = router.stack.find(layer => layer.route?.path === '/runs/:runId/logs').route.stack[0].handle;
	let result;
	const response = { json: value => { result = value; }, status() { return this; } };
	await handler({ params: { runId: 'logs-fixture' }, query: { view: 'table-results', limit: 100 } }, response);
	assert.deepEqual(result.logs, [final]);
	await handler({ params: { runId: 'logs-fixture' }, query: { limit: 1000 } }, response);
	assert.equal(result.count, 301);
	assert.equal(result.logs.filter(event => event.phase === 'row_error').length, 300);
});

test('table-result view uses its own active buffer even before the first table finishes', async t => {
	t.mock.method(logger, 'getTableResultBuffer', () => []);
	t.mock.method(fs.promises, 'readFile', async () => { assert.fail('Must not load an active run log file'); });
	const handler = router.stack.find(layer => layer.route?.path === '/runs/:runId/logs').route.stack[0].handle;
	let result;
	await handler({ params: { runId: 'active-fixture' }, query: { view: 'table-results' } }, { json: value => { result = value; }, status() { return this; } });
	assert.equal(result.success, true);
	assert.equal(result.count, 0);
});

test('saved progress includes unattempted tables and counts skipped rows as processed', async t => {
	const pool = { end: async () => {} };
	t.mock.method(mysql, 'connectToSchema', async () => pool);
	t.mock.method(runStore, 'getRun', async () => ({ run_id: 'progress-fixture', status: 'FAILED',
		table_summary_json: { invoices: { status: 'NOT_RUN' }, stock: { status: 'NOT_RUN' }, payments: { status: 'NOT_RUN' } } }));
	t.mock.method(runStore, 'getRunTables', async () => [
		{ table_name: 'stock', status: 'success', rows_source: 47977, rows_migrated: 0, rows_skipped_duplicates: 47977, last_offset: 47977 },
		{ table_name: 'invoices', status: 'failed', rows_source: 55903, rows_error: 55903, last_offset: 55903 }
	]);
	t.mock.method(fs.promises, 'readFile', async () => { throw Error('No log file'); });
	const handler = router.stack.find(layer => layer.route?.path === '/runs/:runId/progress').route.stack[0].handle;
	let result;
	await handler({ params: { runId: 'progress-fixture' } }, { json: value => { result = value; }, status() { return this; } });
	assert.equal(result.tablesTotal, 3);
	assert.equal(result.tablesCompleted, 1);
	assert.equal(result.tablesFailed, 1);
	assert.deepEqual(result.tables.map(table => table.table), ['stock', 'invoices', 'payments']);
	assert.equal(result.tables[0].rowsProcessed, 47977);
	assert.equal(result.tables[0].rowsMigrated, 0);
	assert.equal(result.tables[0].progress, 100);
	assert.equal(result.tables[1].totalRows, 55903);
});

test('saved results use log selection only when the run timestamp matches', async t => {
	const pool = { end: async () => {} };
	const run = { run_id: 1, status: 'FAILED', started_at: '2026-10-06T07:31:43Z', table_summary_json: {} };
	t.mock.method(mysql, 'connectToSchema', async () => pool);
	t.mock.method(mysql, 'ensureMigrationTables', async () => {});
	t.mock.method(runStore, 'getRun', async () => run);
	t.mock.method(runStore, 'getRunTables', async () => [{ table_name: 'invoices', status: 'failed' }]);
	t.mock.method(runStore, 'getRowErrors', async () => []);
	let timestamp = '2026-10-05T07:31:43Z';
	t.mock.method(fs.promises, 'readFile', async () => JSON.stringify({ phase: 'run_start', timestamp, tables: [{ table: 'invoices' }, { table: 'payments' }] }));
	const handler = router.stack.find(layer => layer.route?.path === '/runs/:runId/summary').route.stack[0].handle;
	let result;
	const response = { json: value => { result = value; }, status() { return this; } };
	await handler({ params: { runId: 1 } }, response);
	assert.equal(result.summary.tableCount, 1);
	timestamp = '2026-10-06T07:31:43.100Z';
	await handler({ params: { runId: 1 } }, response);
	assert.equal(result.summary.tableCount, 2);
	assert.equal(result.summary.notRunCount, 1);
});

test('detailed errors retain history-view compatibility without duplicating stored errors', async () => {
	const result = await runStore.getRowErrors({ query: async () => [[{
		error_message: "Duplicate entry '0' for key 'invoices.uq_invoices_active_job'",
		table_name: 'invoices', source_pk: '3993200', row_json: '{"inv_nr":6968}'
	}]] }, 1);
	assert.equal(result.length, 1);
	assert.match(result[0].message, /Duplicate entry/);
	assert.equal(result[0].source_pk, 6968);
});

test('retry starts failed and unattempted tables, keeps plan settings, and resolves saved profile', async t => {
	const originalPlan = state.plan;
	const originalMapping = state.mapping;
	t.after(() => { state.plan = originalPlan; state.mapping = originalMapping; });
	const names = ['stock', 'invoices', 'payments', 'customers'];
	const config = { batchSize: 500, continueOnError: true, transactionalDateFilter: { enabled: true, startDate: '2020-01-01' } };
	const pool = { end: async () => {}, query: async () => { throw Error('Unexpected database write'); } };
	t.mock.method(mysql, 'connectToSchema', async () => pool);
	t.mock.method(mysql, 'ensureMigrationTables', async () => {});
	t.mock.method(runStore, 'getRun', async () => ({ run_id: 'test-recovery', plan_id: 2, status: 'FAILED',
		table_summary_json: Object.fromEntries(names.map(name => [name, { status: 'NOT_RUN' }])) }));
	t.mock.method(runStore, 'getRunTables', async () => [
		{ table_name: 'stock', status: 'success' }, { table_name: 'invoices', status: 'failed' }
	]);
	t.mock.method(runStore, 'getPlan', async () => ({ plan_id: 2, mapping_json: { mappingProfileId: 9, tables: names, config } }));
	t.mock.method(runStore, 'getMappingProfile', async (_, id) => {
		assert.equal(id, 9);
		return { id: 9, mapping_json: { tables: Object.fromEntries(names.map(name => [name, { target: name, columns: {} }])) } };
	});
	let started;
	t.mock.method(runner, 'startMigration', async args => { started = args; return { runId: 2 }; });
	const handler = router.stack.find(layer => layer.route?.path === '/runs/:runId/retry').route.stack[0].handle;
	let result, status = 200;
	const response = { json: data => { result = data; }, status(code) { status = code; return this; } };
	await handler({ params: { runId: 'test-recovery' }, body: {} }, response);
	assert.equal(status, 200, result?.error);
	assert.deepEqual(started.plan.map(step => step.table), ['invoices', 'payments', 'customers']);
	assert.deepEqual(started.planConfig, config);
	assert.equal(started.mapping.profileId, 9);
	assert.deepEqual(result.retriedTables, ['invoices', 'payments', 'customers']);
	// An explicit selection must remain scoped to retryable tables.
	await handler({ params: { runId: 'test-recovery' }, body: { tables: ['STOCK'] } }, response);
	assert.equal(status, 400);
});
