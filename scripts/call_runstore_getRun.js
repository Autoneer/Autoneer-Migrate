const mysql = require('../src/db/mysql');
const runStore = require('../src/migrate/runStore');
const state = require('../src/config/state').state;

async function run() {
	const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
	try {
		const row = await runStore.getRun(pool, process.argv[2]);
		console.log('runStore.getRun result:', row);
	} catch (e) {
		console.error('error from getRun:', e.message);
	}
	await pool.end();
}
run().catch(e => { console.error(e); process.exit(1) });
