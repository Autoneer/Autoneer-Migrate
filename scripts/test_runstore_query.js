const mysql = require('../src/db/mysql');
const state = require('../src/config/state').state;

async function run() {
	const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
	const runId = process.argv[2];
	try {
		const [rows] = await pool.query('select * from migration_runs where run_id = ? OR id = ?', [runId, runId]);
		console.log('rows:', rows);
	} catch (e) {
		console.error('query error:', e.message);
	}
	await pool.end();
}
run().catch(e => { console.error(e); process.exit(1) });
