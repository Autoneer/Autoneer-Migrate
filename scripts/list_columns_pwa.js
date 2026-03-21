const mysql = require('../src/db/mysql');
const { state } = require('../src/config/state');
(async () => {
	try {
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		const [rows] = await pool.query("select column_name, column_key, data_type, column_type from information_schema.columns where table_schema=database() and table_name='migration_runs'");
		console.dir(rows, { depth: null });
		const [pk] = await pool.query("select column_name from information_schema.key_column_usage where table_schema=database() and table_name='migration_runs' and constraint_name='PRIMARY'");
		console.log('Primary key columns:', pk.map(p => p.COLUMN_NAME));
		await pool.end();
	} catch (e) {
		console.error('error', e.message);
		process.exit(1);
	}
})();
