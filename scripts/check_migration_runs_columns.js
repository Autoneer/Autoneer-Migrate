const mysql = require('../src/db/mysql');
const { state } = require('../src/config/state');
(async () => {
	try {
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		const [rows] = await pool.query("select column_name, data_type, column_type from information_schema.columns where table_schema=database() and table_name='migration_runs'");
		console.dir(rows, { depth: null });
		await pool.end();
	} catch (e) {
		console.error('error', e.message);
		process.exit(1);
	}
})();
