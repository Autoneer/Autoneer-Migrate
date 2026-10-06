const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const runnerFile = path.join(__dirname, '../src/migrate/runner.js');
const runnerRequire = createRequire(runnerFile);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// Execute the real runner with in-memory database adapters. No live DB or log files.
function harness({ commitGate, validationGate, failRows = false, partialInvoiceFailure = false, shortRead = false, continueOnError = false, legacySplits = false } = {}) {
	const records = new Map();
	const logs = [];
	const events = [];
	const writes = [];
	const idMappings = [];
	let now = Date.now();
	const source = { invoices: [{ inv_nr: 1 }, { inv_nr: 2 }], staff: [{ id: 1 }] };
	const plan = Object.keys(source).map(table => ({ table, include: true, mode: 'INSERT', keyStrategy: 'preserve', onDuplicate: 'ERROR' }));
	const mapping = { tables: { INVOICES: { target: 'invoices', columns: { INV_NR: { target: 'invoice_nr' } } }, STAFF: { target: 'staff', columns: { ID: { target: 'id' } } } } };
	if (legacySplits) {
		mapping.tables.INVOICES.columns.SPLITNR = { target: 'splitnr' };
		source.invoices[0].splitnr = 1;
		source.invoices[1].splitnr = null;
	}
	const conn = {
		beginTransaction: async () => {}, rollback: async () => {}, release() {},
		commit: async () => { if (commitGate) { commitGate.entered.resolve(); await commitGate.release.promise; } },
		query: async (sql, params) => {
			if (/^select invoice_nr/.test(sql)) {
				if (validationGate) { validationGate.entered.resolve(); await validationGate.release.promise; }
				return [[{ invoice_nr: 1 }, { invoice_nr: 2 }]];
			}
			if (/^insert /i.test(sql)) {
				writes.push({ sql, params: JSON.parse(JSON.stringify(params)) });
				now += 600; // A slow row-by-row fallback must publish before batch completion.
				if ((failRows || (partialInvoiceFailure && params[0].some(row => row[0] === 2))) && /`invoices`/.test(sql)) {
					throw Error("Duplicate entry '2' for key 'invoices.PRIMARY'");
				}
				return [{ affectedRows: params[0].length }];
			}
			if (/^select max\(invoice_nr\)|AUTO_INCREMENT/.test(sql)) return [[]];
			throw Error(`Unexpected connection query: ${sql}`);
		}
	};
	const pool = { getConnection: async () => conn, query: async (sql, params) => {
		const text = typeof sql === 'string' ? sql : sql.sql;
		if (/INSERT INTO migration_id_map/.test(text)) { idMappings.push(params); return [{ affectedRows: 1 }]; }
		if (/information_schema.COLUMNS|SELECT accnr|select 1 as ok/i.test(text)) return [[]];
		throw Error(`Unexpected pool query: ${text}`);
	}, end: async () => {} };
	const fetch = async (_db, table, _columns, offset, size) => {
		if (shortRead && table.toLowerCase() === 'staff') return [];
		return source[table.toLowerCase()].slice(offset, offset + size);
	};
	const mocks = {
		'../db/mysql': { connectToSchema: async () => pool, ensureMigrationTables: async () => {},
			listColumns: async (_, table) => (table === 'invoices'
				? ['invoice_nr', ...(legacySplits ? ['splitnr', 'is_split_invoice'] : [])] : ['id']).map(name => ({ name })),
			getPrimaryKeys: async (_, table) => [table === 'invoices' ? 'invoice_nr' : 'id'] },
		'../db/firebird': { resolveFirebirdConfig: value => value, query: async () => [],
			listTables: async () => ['INVOICES', 'STAFF'], listColumns: async (_, table) => table === 'INVOICES'
				? ['INV_NR', ...(legacySplits ? ['SPLITNR'] : [])] : ['ID'],
			attachWithRetry: async () => ({ detach() {} }),
			countRowsWithDb: async (_, table) => source[table.toLowerCase()].length,
			countRowsWithDbWhere: async (_, table) => source[table.toLowerCase()].length,
			fetchBatchWithDb: fetch, fetchBatchWithDbWhere: fetch },
		'./runStore': { getTableRun: async (_, _id, table) => records.get(table),
			startTableRun: async (_, _id, table) => { records.set(table, { status: 'running' }); return records.size; },
			updateTableProgress: async (_, _id, table, stats) => Object.assign(records.get(table), stats),
			finishTableRun: async (_, _id, table, status) => { records.get(table).status = status; },
			finishRun: async () => {}, logRowError: async () => {} },
		'./logger': { startRunLogger: () => ({}), logEvent: (_, event) => logs.push(event), closeRunLogger() {} },
		'./gl/glAccountTypes': { seedAccountTypes: async () => {}, validateAccountTypes: async () => ({ valid: true }) }
	};
	const context = vm.createContext({ module: { exports: {} }, exports: {}, console,
		require: name => mocks[name] || runnerRequire(name),
		Date: class extends Date { static now() { return now; } },
		setTimeout: () => 1, setInterval: () => 1, clearInterval() {} });
	vm.runInContext(fs.readFileSync(runnerFile, 'utf8') + '\nmodule.exports.runMigrationInternal = runMigrationInternal; module.exports.createEmitter = createEmitter;', context);
	const runner = context.module.exports;
	runner.createEmitter(1).on('event', event => events.push(JSON.parse(JSON.stringify(event))));
	return {
		records, logs, events, writes, idMappings, state: () => runner.getRunState(1),
		run: () => runner.runMigrationInternal({ runId: 1, firebirdConfig: {}, mysqlConfig: {}, schemaName: 'fixture', plan,
			planConfig: { continueOnError }, mapping, dryRun: false, batchSize: 1000, fkChecks: true })
	};
}

test('runner inserts legacy split flags and maps preserved IDs even when insertId is zero', async () => {
	const h = harness({ legacySplits: true });
	await h.run();
	assert.equal(h.state().status, 'SUCCESS');
	const invoiceWrite = h.writes.find(write => write.sql.includes('`invoices`'));
	assert.match(invoiceWrite.sql, /`invoice_nr`, `splitnr`, `is_split_invoice`/);
	assert.deepEqual(invoiceWrite.params, [[[1, 1, 1], [2, null, 0]]]);
	assert.deepEqual(h.idMappings[0].slice(0, 5), [1, 'INVOICES', '1', '1', 'INSERT']);
	assert.deepEqual(h.idMappings[0].slice(6, 11), [1, 'INVOICES', '2', '2', 'INSERT']);
});

test('row fallback maps only successfully inserted preserved invoices', async () => {
	const h = harness({ partialInvoiceFailure: true });
	await h.run();
	assert.equal(h.state().status, 'FAILED');
	assert.equal(h.state().tables[0].inserted, 1);
	assert.equal(h.state().tables[0].errors, 1);
	assert.equal(h.idMappings.length, 1);
	assert.deepEqual(h.idMappings[0].slice(0, 5), [1, 'INVOICES', '1', '1', 'INSERT']);
});

test('next table waits for committed writes and invoice identity validation', async () => {
	const commitGate = { entered: deferred(), release: deferred() };
	const validationGate = { entered: deferred(), release: deferred() };
	const h = harness({ commitGate, validationGate });
	const finished = h.run();
	await Promise.race([commitGate.entered.promise, finished.then(() => { throw Error(JSON.stringify(h.logs.slice(-3))); })]);
	assert.equal(h.state().tables[0].status, 'RUNNING');
	assert.equal(h.state().tables[0].processed, 0, 'uncommitted rows are not counted');
	assert.equal(h.records.has('staff'), false);
	commitGate.release.resolve();
	await validationGate.entered.promise;
	assert.equal(h.state().tables[0].status, 'RUNNING');
	assert.equal(h.state().tables[0].phase, 'validating');
	assert.equal(h.state().tables[0].processed, 2);
	assert.equal(h.records.has('staff'), false);
	validationGate.release.resolve();
	await finished;
	assert.equal(h.state().status, 'SUCCESS', JSON.stringify(h.logs.slice(-3)));
	assert.equal(h.records.get('staff').status, 'success');
	for (const event of h.events.filter(e => e.event === 'runState')) {
		assert.ok(event.data.tables.filter(t => t.status === 'RUNNING').length <= 1);
	}
});

test('slow row errors advance processed counts inside a batch and prevent the next table by default', async () => {
	const h = harness({ failRows: true });
	await h.run();
	assert.equal(h.state().status, 'FAILED');
	assert.equal(h.state().tables[0].errors, 2);
	assert.equal(h.state().tables[0].processed, 2);
	assert.equal(h.records.has('staff'), false);
	assert.ok(h.events.some(e => {
		const table = e.data?.tables?.[0];
		return table?.status === 'RUNNING' && table.errors === 1 && table.processed === 1;
	}), 'must publish the first failed row before the batch ends');
});

test('continue-on-error advances only after the failed table finishes', async () => {
	const h = harness({ failRows: true, continueOnError: true });
	await h.run();
	assert.equal(h.state().status, 'COMPLETED_WITH_ERRORS');
	assert.equal(h.records.get('invoices').status, 'failed');
	assert.equal(h.records.get('staff').status, 'success');
});

test('premature end of source data cannot be marked completed', async () => {
	const h = harness({ shortRead: true });
	await h.run();
	assert.equal(h.state().status, 'FAILED');
	assert.equal(h.records.get('staff').status, 'failed');
	assert.match(h.state().tables[1].lastError.message, /processed 0 of 1 rows/);
});
