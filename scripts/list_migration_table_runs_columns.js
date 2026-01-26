const mysql = require('../src/db/mysql');
const state = require('../src/config/state').state;

async function run() {
	const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
	const [rows] = await pool.query("select column_name from information_schema.columns where table_schema = database() and table_name = 'migration_table_runs'");
	console.log(rows.map(r => r.COLUMN_NAME || r.column_name));
	await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
