const mysql = require('../src/db/mysql');
const runStore = require('../src/migrate/runStore');
const state = require('../src/config/state').state;

async function runTest() {
	const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
	await mysql.ensureMigrationTables(pool);

	console.log('Creating successful run...');
	const runId = await runStore.createRun(pool, { run_label: 'Test Success', source_conn_name: 'fb-test', target_schema_name: state.schemaName, schemaName: state.schemaName, dryRun: false, batchSize: 10, fkChecks: true, plan: [] });
	console.log('Run created:', runId);
	// no errors logged
	await runStore.finishRun(pool, runId, 'SUCCESS');
	const run = await runStore.getRun(pool, runId);
	console.log('Run status after finish:', run.status, 'error_count=', run.error_count);

	console.log('Creating failing run...');
	const runId2 = await runStore.createRun(pool, { run_label: 'Test Fail', source_conn_name: 'fb-test', target_schema_name: state.schemaName, schemaName: state.schemaName, dryRun: false, batchSize: 10, fkChecks: true, plan: [] });
	await runStore.logRowError(pool, { runId: runId2, tableName: 'TEST', sourceTable: 'TEST', rowOffset: 1, sourcePk: '1', errorMessage: 'Simulated error' });
	await runStore.finishRun(pool, runId2, 'FAILED');
	const run2 = await runStore.getRun(pool, runId2);
	console.log('Run2 status after finish:', run2.status, 'error_count=', run2.error_count);

	await pool.end();
}

runTest().catch((e) => { console.error(e); process.exit(1); });
