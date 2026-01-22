require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { state } = require('../src/config/state');
const runner = require('../src/migrate/runner');

const mask = (s) => (typeof s === 'string' && s.length ? '***' : '');

(async () => {
	const out = [];
	function log(...args) { out.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')); console.log(...args); }

	try {
		log('[VerboseTest] Effective state (masked):', JSON.stringify({
			firebird: { host: state.firebird.host, port: state.firebird.port, database: state.firebird.database, user: state.firebird.user, password: mask(state.firebird.password) },
			mysql: { host: state.mysql.host, port: state.mysql.port, user: state.mysql.user, password: mask(state.mysql.password) },
			schemaName: state.schemaName
		}, null, 2));

		const plan = [{ include: true, table: 'spares_used', mode: 'INSERT', keyStrategy: 'preserve', dedupeKeys: [], onDuplicate: 'SKIP' }];
		const mapping = { tables: { SPARES_USED: { target: 'spares_used', columns: {} } } };

		log('[VerboseTest] Starting migration (dryRun=true) with timeout 10s...');

		const startPromise = runner.startMigration({
			firebirdConfig: state.firebird,
			mysqlConfig: state.mysql,
			schemaName: state.schemaName,
			plan,
			mapping,
			dryRun: true,
			batchSize: 100,
			fkChecks: false
		});

		const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('startMigration timeout after 10000ms')), 10000));

		let result;
		try {
			result = await Promise.race([startPromise, timeout]);
			log('[VerboseTest] startMigration returned:', JSON.stringify(result));
		} catch (e) {
			log('[VerboseTest] startMigration failed or timed out:', e.stack || e.message || e);
			// If startPromise resolved later, attach to emitter if possible
		}

		const runId = (result && (result.runId || result)) || null;
		if (runId) {
			log('[VerboseTest] runId=', runId);
			const emitter = runner.getEmitter(runId);
			if (emitter) {
				emitter.on('event', ev => log('[EMITTER]', ev));
			}

			log('[VerboseTest] Waiting 3s then requesting abort');
			await new Promise(r => setTimeout(r, 3000));
			runner.requestAbort(runId, 'Verbose test abort');
			await new Promise(r => setTimeout(r, 5000));
		} else {
			log('[VerboseTest] No runId available; skipping abort request');
		}

		// Write out collected logs to file
		const outPath = path.join(process.cwd(), 'logs', 'dry_run_and_stop-verbose.txt');
		try { fs.mkdirSync(path.dirname(outPath), { recursive: true }); } catch (e) { }
		fs.writeFileSync(outPath, out.join('\n'));
		log('[VerboseTest] Wrote verbose output to', outPath);

		process.exit(0);
	} catch (err) {
		console.error('[VerboseTest] Error', err.stack || err);
		process.exit(1);
	}
})();
