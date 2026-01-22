(async () => {
	try {
		const fs = require('fs');
		const path = require('path');
		const mysql = require('../src/db/mysql');
		const { state } = require('../src/config/state');
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		const [runs] = await pool.query('SELECT * FROM migration_runs ORDER BY run_id DESC LIMIT 10');
		const [tables] = await pool.query('SELECT * FROM migration_table_runs WHERE run_id IN (SELECT run_id FROM migration_runs ORDER BY run_id DESC LIMIT 10) ORDER BY run_id DESC, id');
		const outPath = path.join(process.cwd(), 'logs', 'query_runs-output.json');
		try { fs.mkdirSync(path.dirname(outPath), { recursive: true }); } catch (e) { }
		fs.writeFileSync(outPath, JSON.stringify({ runs, tables }, null, 2));
		console.log('Wrote', outPath);
		await pool.end();
	} catch (e) {
		console.error('Error', e && e.stack ? e.stack : e);
		process.exit(1);
	}
})();
