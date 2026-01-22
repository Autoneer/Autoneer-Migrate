require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { state } = require('../src/config/state');
const runner = require('../src/migrate/runner');

(async () => {
	try {
		const output = [];
		const log = (...args) => {
			const line = args.map((val) => (typeof val === 'string' ? val : JSON.stringify(val))).join(' ');
			output.push(line);
			console.log(...args);
		};
		const mask = (value) => (typeof value === 'string' && value.length ? '***' : '');

		log('[Test] Starting dry migration run (will request stop after 3s)...');
		log('[Test] Effective config (masked):', {
			firebird: {
				host: state.firebird.host,
				port: state.firebird.port,
				database: state.firebird.database,
				user: state.firebird.user,
				password: mask(state.firebird.password)
			},
			mysql: {
				host: state.mysql.host,
				port: state.mysql.port,
				user: state.mysql.user,
				password: mask(state.mysql.password)
			},
			schemaName: state.schemaName
		});
		const plan = [
			{ include: true, table: 'spares_used', mode: 'INSERT', keyStrategy: 'preserve', dedupeKeys: [], onDuplicate: 'SKIP' }
		];
		const mapping = { tables: { SPARES_USED: { target: 'spares_used', columns: {} } } };
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
		const timeoutMs = 15000;
		const timeout = new Promise((_, reject) =>
			setTimeout(() => reject(new Error(`startMigration timed out after ${timeoutMs}ms`)), timeoutMs)
		);
		const result = await Promise.race([startPromise, timeout]);

		const runId = result.runId || result;
		log('[Test] runId=', runId);

		const emitter = runner.getEmitter(runId);
		if (emitter) {
			emitter.on('event', (ev) => {
				log('[EMITTER]', JSON.stringify(ev).slice(0, 200));
			});
		}

		// Wait 3s then request abort
		await new Promise((r) => setTimeout(r, 3000));
		log('[Test] Requesting abort for run', runId);
		runner.requestAbort(runId, 'Test abort from script');

		// Wait up to 10s for final state events
		await new Promise((r) => setTimeout(r, 10000));

		// Try to read run log file if exists
		const logPath = path.join(__dirname, '..', 'logs', 'migrate', `${runId}.log`);
		if (fs.existsSync(logPath)) {
			log('[Test] Log tail:');
			const tail = fs.readFileSync(logPath, 'utf8').split('\n').slice(-40).join('\n');
			log(tail);
		} else {
			log('[Test] No log file found at', logPath);
		}

		const outputPath = path.join(__dirname, '..', 'logs', 'dry_run_and_stop-output.txt');
		fs.mkdirSync(path.dirname(outputPath), { recursive: true });
		fs.writeFileSync(outputPath, output.join('\n'));
		log('[Test] Output written to', outputPath);

		log('[Test] Done');
		process.exit(0);
	} catch (err) {
		try {
			const outputPath = path.join(__dirname, '..', 'logs', 'dry_run_and_stop-output.txt');
			fs.mkdirSync(path.dirname(outputPath), { recursive: true });
			fs.writeFileSync(outputPath, `[Test] Error ${err.stack || err}`);
		} catch (writeErr) {
			console.error('[Test] Failed to write output file', writeErr.stack || writeErr);
		}
		console.error('[Test] Error', err.stack || err);
		process.exit(1);
	}
})();
