const mysql = require('../src/db/mysql');
const { state } = require('../src/config/state');
(async () => {
	try {
		const pool = await mysql.connectToSchema(state.mysql, 'pwa_service');
		console.log('Connected to pwa_service');
		try {
			await pool.query("ALTER TABLE migration_runs DROP PRIMARY KEY");
			console.log('Dropped primary key on migration_runs');
		} catch (e) {
			console.log('Drop PK skipped:', e.message);
		}
		try {
			await pool.query("ALTER TABLE migration_runs ADD COLUMN run_id INT NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST");
			console.log('Added run_id INT AUTO_INCREMENT PRIMARY KEY');
		} catch (e) {
			console.log('Add run_id skipped or failed:', e.message);
		}
		try {
			await pool.query("ALTER TABLE migration_runs ADD COLUMN plan_id INT NULL");
			console.log('Added plan_id column');
		} catch (e) {
			console.log('Add plan_id skipped or failed:', e.message);
		}
		await pool.end();
		console.log('Alter operations complete');
	} catch (e) {
		console.error('Alter failed', e.message);
		process.exit(1);
	}
})();
