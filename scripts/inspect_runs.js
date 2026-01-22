const fs = require('fs');
const path = require('path');
const mysql = require('../src/db/mysql');
const { state } = require('../src/config/state');

(async () => {
	try {
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		const [runs] = await pool.query('SELECT * FROM migration_runs ORDER BY run_id DESC LIMIT 10');
		console.log('\n=== migration_runs (latest 10) ===\n');
		console.log(JSON.stringify(runs, null, 2));

		let tables = [];
		if (runs.length > 0) {
			const runId = runs[0].run_id;
			const [tableRows] = await pool.query('SELECT * FROM migration_table_runs WHERE run_id = ? ORDER BY id', [runId]);
			tables = tableRows;
			console.log(`\n=== migration_table_runs for run_id=${runId} ===\n`);
			console.log(JSON.stringify(tables, null, 2));
		} else {
			console.log('No runs found in migration_runs.');
		}

		const outputPath = path.join(__dirname, '..', 'logs', 'inspect_runs-output.json');
		fs.mkdirSync(path.dirname(outputPath), { recursive: true });
		fs.writeFileSync(outputPath, JSON.stringify({ runs, tables }, null, 2));
		console.log(`\nWrote ${outputPath}`);

		await pool.end();
	} catch (err) {
		console.error('Error querying DB:', err.stack || err);
		process.exit(1);
	}
})();
