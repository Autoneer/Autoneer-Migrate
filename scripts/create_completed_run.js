const mysql = require('../src/db/mysql');
const state = require('../src/config/state').state;
const http = require('http');
const { v4: uuidv4 } = require('uuid');

async function run() {
	const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
	await mysql.ensureMigrationTables(pool);

	const runUuid = uuidv4();
	console.log('Creating legacy test run id=', runUuid);

	// Insert into legacy-style migration_runs (uses `id` column)
	await pool.query(
		`insert into migration_runs (id, status, created_at, started_at, finished_at, dry_run, batch_size, fk_checks, schema_name, plan_json, mapping_profile_id, error_message)
      values (?, 'SUCCESS', now(), now(), now(), 0, 1000, 1, ?, ?, null, null)`,
		[runUuid, state.schemaName, JSON.stringify([])]
	);

	// Insert a completed table run with 1000 rows migrated (use runUuid as run_id)
	console.log('Inserting table run with 1000 rows for run=', runUuid);
	await pool.query(
		`insert into migration_table_runs (run_id, table_name, mode, key_strategy, status, started_at, finished_at, rows_source, rows_migrated, rows_skipped, rows_error, rows_skipped_duplicates)
      values (?, ?, ?, ?, 'COMPLETED', now(), now(), ?, ?, 0, 0, 0)`,
		[runUuid, 'TEST_TABLE', 'INSERT', 'preserve', 1000, 1000]
	);

	await pool.end();

	// Wait briefly, then GET the run via API (using UUID)
	await new Promise(r => setTimeout(r, 1000));

	const url = `http://localhost:3000/api/runs/${runUuid}`;
	console.log('Fetching', url);
	http.get(url, (res) => {
		let data = '';
		res.on('data', (chunk) => data += chunk);
		res.on('end', () => {
			try {
				const json = JSON.parse(data);
				console.log('API response:');
				console.log(JSON.stringify(json, null, 2));
			} catch (e) {
				console.error('Failed to parse response', e, data);
			}
			process.exit(0);
		});
	}).on('error', (err) => {
		console.error('HTTP error:', err);
		process.exit(1);
	});
}

run().catch(e => { console.error(e); process.exit(1); });
