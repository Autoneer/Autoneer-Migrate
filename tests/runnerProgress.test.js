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
function harness({ retryOfRunId, invoiceRace = false, realJobConflict = false, existingInvoices = [], existingStaff = [], cleanBefore = false, invoiceSchemaGate, invoiceSchemaError, commitGate, validationGate, cleanupGate, cleanupError, staffCleanupGate, staffCleanupError, invoiceRows, invoiceBatchSize, filteredInvoiceKeys, nullInvoice = false, dryRun = false, failRows = false, partialInvoiceFailure = false, shortRead = false, continueOnError = false, legacySplits = false } = {}) {
	const records = new Map();
	const logs = [];
	const events = [];
	const writes = [];
	const idMappings = [];
	const rowErrors = [];
	const firebirdQueries = [];
	const targetCleanups = [];
	const mysqlSchemas = [];
	const sourceReads = [];
	const sourceFetches = [];
	const targetInvoices = existingInvoices.map(row => ({ ...row }));
	const targetStaff = existingStaff.map(row => ({ ...row }));
	let now = Date.now();
	const source = { invoices: [{ inv_nr: 1 }, { inv_nr: 2 }], staff: [{ id: 1 }] };
	if (invoiceRows) source.invoices = invoiceRows;
	if (nullInvoice) source.invoices.push({ inv_nr: null });
	const plan = Object.keys(source).map(table => ({ table, include: true, mode: 'INSERT', keyStrategy: 'preserve', onDuplicate: 'ERROR', cleanBefore }));
	const mapping = { tables: { INVOICES: { target: 'invoices', columns: { INV_NR: { target: 'invoice_nr' } } }, STAFF: { target: 'staff', columns: { ID: { target: 'id' } } } } };
	if (invoiceRows) {
		mapping.tables.INVOICES.columns.JOB_CARD_NR = { target: 'job_number' };
		mapping.tables.INVOICES.columns.CID = { target: 'cid' };
	}
	if (invoiceBatchSize) plan[0].batchSize = invoiceBatchSize;
	if (legacySplits) {
		mapping.tables.INVOICES.columns.SPLITNR = { target: 'splitnr' };
		source.invoices[0].splitnr = 1;
		source.invoices[1].splitnr = null;
	}
	const conn = {
		beginTransaction: async () => {}, rollback: async () => {}, release() {},
		commit: async () => { if (commitGate) { commitGate.entered.resolve(); await commitGate.release.promise; } },
		query: async (sql, params) => {
			if (/^SELECT `invoice_nr`/i.test(sql)) return [targetInvoices.filter(row => params.map(Number).includes(Number(row.invoice_nr)))];
			if (/^SELECT `id`/i.test(sql)) return [targetStaff.filter(row => params.map(Number).includes(Number(row.id)))];
			if (/^select invoice_nr/.test(sql)) {
				if (validationGate) { validationGate.entered.resolve(); await validationGate.release.promise; }
				return [targetInvoices];
			}
			if (/^insert /i.test(sql)) {
				writes.push({ sql, params: JSON.parse(JSON.stringify(params)) });
				now += 600; // A slow row-by-row fallback must publish before batch completion.
				if (/`invoices`/.test(sql)) {
					if (invoiceRace) {
						invoiceRace = false;
						targetInvoices.push({ invoice_nr: params[0][0][0] });
					}
					if (params[0].some(row => targetInvoices.some(invoice => Number(invoice.invoice_nr) === Number(row[0])))) {
						throw Object.assign(Error("Duplicate entry '1' for key 'invoices.PRIMARY'"), { code: 'ER_DUP_ENTRY', errno: 1062 });
					}
					if (realJobConflict && params[0].some(row => targetInvoices.some(invoice => invoice.job_number === row[1]))) {
						throw Object.assign(Error("Duplicate entry '500' for key 'invoices.uq_invoices_active_job'"), { code: 'ER_DUP_ENTRY', errno: 1062 });
					}
				}
				if ((failRows || (partialInvoiceFailure && params[0].some(row => row[0] === 2))) && /`invoices`/.test(sql)) {
					throw Error("Duplicate entry '2' for key 'invoices.PRIMARY'");
				}
				if (/`invoices`/.test(sql)) {
					const columns = [...sql.matchAll(/`([^`]+)`/g)].slice(1).map(match => match[1]);
					for (const row of params[0]) targetInvoices.push(Object.fromEntries(columns.map((col, index) => [col, row[index]])));
				}
				return [{ affectedRows: params[0].length }];
			}
			if (/^select max\(invoice_nr\)|AUTO_INCREMENT/.test(sql)) return [[]];
			throw Error(`Unexpected connection query: ${sql}`);
		}
	};
	const pool = { getConnection: async () => conn, query: async (sql, params) => {
		const text = typeof sql === 'string' ? sql : sql.sql;
		if (text === "delete from staff where staff_group <> 'MASTER'") {
			targetCleanups.push(text);
			if (staffCleanupGate) { staffCleanupGate.entered.resolve(); await staffCleanupGate.release.promise; }
			if (staffCleanupError) throw Error(staffCleanupError);
			return [{ affectedRows: 3 }];
		}
		if (/INSERT INTO migration_id_map/.test(text)) { idMappings.push(params); return [{ affectedRows: 1 }]; }
		if (/information_schema.COLUMNS|SELECT accnr|select 1 as ok/i.test(text)) return [[]];
		throw Error(`Unexpected pool query: ${text}`);
	}, end: async () => {} };
	const fetch = async (_db, table, _columns, offset, size, orderBy, clause, params) => {
		sourceReads.push(table);
		sourceFetches.push({ table, offset, size, orderBy, clause, params });
		if (shortRead && table.toLowerCase() === 'staff') return [];
		const rows = table.toLowerCase() === 'invoices' && clause?.includes(' IN (')
			? source.invoices.filter(row => params.map(Number).includes(Number(row.inv_nr)))
			: source[table.toLowerCase()];
		return rows.slice(offset, offset + size);
	};
	const mocks = {
		'../db/mysql': { connectToSchema: async (_, schema) => { mysqlSchemas.push(schema); return pool; }, ensureMigrationTables: async () => {},
			listColumns: async (_, table) => (table === 'invoices'
				? ['invoice_nr', ...(invoiceRows ? ['job_number', 'cid'] : []), ...(legacySplits ? ['splitnr', 'is_split_invoice'] : [])] : ['id']).map(name => ({ name })),
			getPrimaryKeys: async (_, table) => [table === 'invoices' ? 'invoice_nr' : 'id'] },
		'../db/firebird': { resolveFirebirdConfig: value => value, query: async (config, sql) => {
			firebirdQueries.push({ config, sql });
			if (sql === 'delete from invoices where inv_nr is null') {
				if (cleanupGate) { cleanupGate.entered.resolve(); await cleanupGate.release.promise; }
				if (cleanupError) throw Error(cleanupError);
				source.invoices = source.invoices.filter(row => row.inv_nr !== null);
			}
			return [];
		},
			listTables: async () => ['INVOICES', 'STAFF'], listColumns: async (_, table) => table === 'INVOICES'
				? ['INV_NR', ...(invoiceRows ? ['JOB_CARD_NR', 'CID'] : []), ...(legacySplits ? ['SPLITNR'] : [])] : ['ID'],
			attachWithRetry: async () => ({ detach() {} }),
			countRowsWithDb: async (_, table) => { sourceReads.push(table); return source[table.toLowerCase()].length; },
			countRowsWithDbWhere: async (_, table) => { sourceReads.push(table); return source[table.toLowerCase()].length; },
			fetchBatchWithDb: fetch, fetchBatchWithDbWhere: fetch },
		'./runStore': { getTableRun: async (_, _id, table) => records.get(table),
			startTableRun: async (_, _id, table) => { records.set(table, { status: 'running' }); return records.size; },
			updateTableProgress: async (_, _id, table, stats) => Object.assign(records.get(table), stats),
			finishTableRun: async (_, _id, table, status) => { records.get(table).status = status; },
			finishRun: async () => {}, logRowError: async (_, row) => { rowErrors.push(row); } },
		'./logger': { startRunLogger: () => ({}), logEvent: (_, event) => logs.push(event), closeRunLogger() {} },
		'./gl/glAccountTypes': { seedAccountTypes: async () => {}, validateAccountTypes: async () => ({ valid: true }) }
	};
	if (filteredInvoiceKeys) {
		mocks['./transactionalDateFilter'] = {
			...runnerRequire('./transactionalDateFilter'),
			buildTransactionalTableFilter: table => table === 'invoices' ? { hasLinkClause: true } : null,
			collectMatchingKeyValuesWithDb: async () => filteredInvoiceKeys
		};
	}
	if (invoiceSchemaGate || invoiceSchemaError) {
		mocks['../db/invoiceActiveJobSchema'] = { ensureInvoiceActiveJobSchema: async () => {
			if (invoiceSchemaGate) { invoiceSchemaGate.entered.resolve(); await invoiceSchemaGate.release.promise; }
			if (invoiceSchemaError) throw Error(invoiceSchemaError);
			return { status: 'updated' };
		} };
	}
	const context = vm.createContext({ module: { exports: {} }, exports: {}, console,
		require: name => mocks[name] || runnerRequire(name),
		Date: class extends Date { static now() { return now; } },
		setTimeout: () => 1, setInterval: () => 1, clearInterval() {} });
	vm.runInContext(fs.readFileSync(runnerFile, 'utf8') + '\nmodule.exports.runMigrationInternal = runMigrationInternal; module.exports.createEmitter = createEmitter;', context);
	const runner = context.module.exports;
	runner.createEmitter(1).on('event', event => events.push(JSON.parse(JSON.stringify(event))));
	return {
		records, logs, events, writes, idMappings, rowErrors, firebirdQueries, targetCleanups, mysqlSchemas, sourceReads, sourceFetches, targetInvoices, state: () => runner.getRunState(1),
		run: () => runner.runMigrationInternal({ retryOfRunId, runId: 1, firebirdConfig: {}, mysqlConfig: {}, schemaName: 'fixture', plan,
			planConfig: { continueOnError }, mapping, dryRun, batchSize: 1000, fkChecks: true })
	};
}

test('retry skips already migrated invoices and other primary keys, logs them, and preserves target data', async () => {
	const original = { invoice_nr: 23421, job_number: 0, cid: 42, comments: 'existing', is_historical_import: 0 };
	const h = harness({ retryOfRunId: 4, cleanBefore: true, existingInvoices: [original], existingStaff: [{ id: 1 }], invoiceRows: [
		{ inv_nr: 23421, job_card_nr: 0, cid: 42 }, { inv_nr: 13158, job_card_nr: 0, cid: 42 }
	] });
	await h.run();
	assert.equal(h.state().status, 'SUCCESS', JSON.stringify(h.logs.slice(-3)));
	assert.deepEqual(h.targetInvoices[0], original);
	assert.deepEqual(h.targetInvoices[1], { invoice_nr: 13158, job_number: 0, cid: 42 });
	assert.equal(h.state().tables[0].skippedDuplicates, 1);
	assert.equal(h.state().tables[0].inserted, 1);
	assert.equal(h.state().tables[0].errors, 0);
	assert.equal(h.records.get('invoices').rows_skipped_duplicates, 1);
	assert.equal(h.state().tables[1].skippedDuplicates, 1);
	assert.equal(h.writes.filter(write => /`invoices`/.test(write.sql)).length, 1);
	assert.equal(h.writes.filter(write => /`staff`/.test(write.sql)).length, 0);
	assert.equal(h.targetCleanups.length, 0);
	const skipped = h.logs.filter(log => log.action === 'row_skipped' && log.reason === 'already_migrated');
	assert.deepEqual(skipped.map(log => log.sourcePk), [23421, 1]);
	assert.ok(h.idMappings.some(params => params[2] === '23421' && params[3] === '23421' && params[4] === 'SKIP'));
});

test('normal start skips the reported existing invoices without a retry flag', async () => {
	const existingInvoices = [
		{ invoice_nr: 23225, job_number: 21782, cid: 14848, comments: 'original', is_historical_import: 0 },
		{ invoice_nr: 16658, job_number: 14767, cid: 9, is_historical_import: 0 },
		{ invoice_nr: 9825, job_number: 7969, cid: 14, is_historical_import: 0 }
	];
	for (const dryRun of [false, true]) {
		const h = harness({ dryRun, existingInvoices, invoiceRows: existingInvoices.map(row => ({ inv_nr: row.invoice_nr, job_card_nr: row.job_number, cid: row.cid })) });
		await h.run();
		assert.equal(h.state().status, 'SUCCESS', JSON.stringify(h.logs.slice(-3)));
		assert.equal(h.state().tables[0].processed, 3);
		assert.equal(h.state().tables[0].skippedDuplicates, 3);
		assert.equal(h.state().tables[0].errors, 0);
		assert.equal(h.state().tables[0].inserted, 0);
		assert.equal(h.writes.filter(write => /`invoices`/.test(write.sql)).length, 0);
		assert.deepEqual(h.targetInvoices, existingInvoices);
		assert.deepEqual(h.logs.filter(log => log.reason === 'already_migrated').map(log => log.sourcePk), [23225, 16658, 9825]);
		if (dryRun) assert.equal(h.idMappings.length, 0);
	}
});

test('normal start checks invoice owners and still rejects a different active invoice for a real job', async () => {
	const h = harness({ realJobConflict: true, existingInvoices: [{ invoice_nr: 1, job_number: 500, cid: 42 }],
		invoiceRows: [{ inv_nr: 1, job_card_nr: 999, cid: 42 }, { inv_nr: 2, job_card_nr: 500, cid: 42 }] });
	await h.run();
	assert.equal(h.state().status, 'FAILED');
	assert.equal(h.state().tables[0].skippedDuplicates, 0);
	assert.equal(h.state().tables[0].errors, 2);
	assert.match(h.rowErrors[0].errorMessage, /Existing invoice identity conflict/);
	assert.match(h.rowErrors[1].errorMessage, /uq_invoices_active_job/);
	assert.equal(h.targetInvoices.length, 1);
});

test('retry of a completely imported invoice table counts every invoice as skipped', async () => {
	const h = harness({ retryOfRunId: 4, existingInvoices: [{ invoice_nr: 1 }, { invoice_nr: 2 }] });
	await h.run();
	assert.equal(h.state().status, 'SUCCESS', JSON.stringify(h.logs.slice(-3)));
	assert.equal(h.state().tables[0].processed, 2);
	assert.equal(h.state().tables[0].skippedDuplicates, 2);
	assert.equal(h.state().tables[0].inserted, 0);
	assert.equal(h.writes.filter(write => /`invoices`/.test(write.sql)).length, 0);
});

test('retry preserves identity conflicts as row errors and still inserts other invoices', async () => {
	const h = harness({ retryOfRunId: 4, existingInvoices: [{ invoice_nr: 1, job_number: 500, cid: 42 }], invoiceRows: [
		{ inv_nr: 1, job_card_nr: 999, cid: 42 }, { inv_nr: 2, job_card_nr: 0, cid: 42 }
	] });
	await h.run();
	assert.equal(h.state().status, 'FAILED');
	assert.equal(h.state().tables[0].skippedDuplicates, 0);
	assert.equal(h.state().tables[0].errors, 1);
	assert.equal(h.state().tables[0].inserted, 1);
	assert.match(h.rowErrors[0].errorMessage, /Existing invoice identity conflict.*source job 999.*target job 500/);
	assert.equal(h.rowErrors[0].sourcePk, 1);
	assert.equal(h.rowErrors[0].rowOffset, 0);
});

test('retry row fallback keeps original error offsets after skipping existing headers', async () => {
	const h = harness({ retryOfRunId: 4, partialInvoiceFailure: true, existingInvoices: [{ invoice_nr: 1 }] });
	await h.run();
	assert.equal(h.state().tables[0].skippedDuplicates, 1);
	assert.equal(h.state().tables[0].errors, 1);
	assert.equal(h.rowErrors[0].sourcePk, 2);
	assert.equal(h.rowErrors[0].rowOffset, 1);
});

test('retry handles an invoice inserted after its existence check as skipped during row fallback', async () => {
	const h = harness({ retryOfRunId: 4, invoiceRace: true });
	await h.run();
	assert.equal(h.state().status, 'SUCCESS', JSON.stringify(h.logs.slice(-3)));
	assert.equal(h.state().tables[0].skippedDuplicates, 1);
	assert.equal(h.state().tables[0].inserted, 1);
	assert.equal(h.state().tables[0].errors, 0);
	assert.deepEqual(h.targetInvoices, [{ invoice_nr: 1 }, { invoice_nr: 2 }]);
});

test('retry rejects a different invoice sharing an existing active real job', async () => {
	const h = harness({ retryOfRunId: 4, realJobConflict: true, existingInvoices: [{ invoice_nr: 1, job_number: 500, cid: 42 }],
		invoiceRows: [{ inv_nr: 2, job_card_nr: 500, cid: 42 }] });
	await h.run();
	assert.equal(h.state().status, 'FAILED');
	assert.equal(h.state().tables[0].skippedDuplicates, 0);
	assert.equal(h.state().tables[0].errors, 1);
	assert.match(h.rowErrors[0].errorMessage, /uq_invoices_active_job/);
	assert.equal(h.targetInvoices.length, 1);
});

test('dry-run retry reports existing headers as skipped without writes or ID mappings', async () => {
	const h = harness({ retryOfRunId: 4, dryRun: true, existingInvoices: [{ invoice_nr: 1 }] });
	await h.run();
	assert.equal(h.state().status, 'SUCCESS', JSON.stringify(h.logs.slice(-3)));
	assert.equal(h.state().tables[0].skippedDuplicates, 1);
	assert.equal(h.state().tables[0].migrated, 1);
	assert.equal(h.writes.length, 0);
	assert.equal(h.idMappings.length, 0);
});

test('invoice key correction finishes before source cleanup, reads, or invoice inserts', async () => {
	const invoiceSchemaGate = { entered: deferred(), release: deferred() };
	const h = harness({ invoiceSchemaGate });
	const finished = h.run();
	await Promise.race([invoiceSchemaGate.entered.promise, finished.then(() => { throw Error(JSON.stringify(h.logs.slice(-3))); })]);
	assert.equal(h.firebirdQueries.some(query => query.sql.startsWith('delete ')), false);
	assert.equal(h.sourceReads.length, 0);
	assert.equal(h.writes.length, 0);
	invoiceSchemaGate.release.resolve();
	await finished;
	assert.equal(h.state().status, 'SUCCESS');
	assert.ok(h.logs.some(log => log.action === 'invoice_active_job_schema' && log.status === 'updated' && log.schema === 'fixture'));
});

test('invoice key correction failure stops migration even with continue-on-error', async () => {
	const h = harness({ invoiceSchemaError: 'permission denied', continueOnError: true });
	await h.run();
	assert.equal(h.state().status, 'FAILED');
	assert.equal(h.sourceReads.length, 0);
	assert.equal(h.writes.length, 0);
	assert.equal(h.targetCleanups.length, 0);
	assert.equal(h.firebirdQueries.some(query => query.sql.startsWith('delete ')), false);
	assert.match(h.state().lastError.message, /Invoice active-job schema correction failed: permission denied/);
});

test('preflight waits for Firebird invoice cleanup before counting or copying source rows', async () => {
	const cleanupGate = { entered: deferred(), release: deferred() };
	const h = harness({ cleanupGate, nullInvoice: true });
	const finished = h.run();
	await Promise.race([cleanupGate.entered.promise, finished.then(() => { throw Error(JSON.stringify(h.logs.slice(-3))); })]);
	assert.equal(h.sourceReads.length, 0);
	assert.equal(h.writes.length, 0);
	cleanupGate.release.resolve();
	await finished;
	assert.equal(h.state().status, 'SUCCESS', JSON.stringify(h.logs.slice(-3)));
	assert.equal(h.state().tables[0].processed, 2);
	const cleanupQueries = h.firebirdQueries.filter(query => query.sql.startsWith('delete '));
	assert.deepEqual(cleanupQueries.map(query => query.sql), [
		'delete from invoices where inv_nr is null',
		"delete from invoices where status = 'REDO'",
		'delete from spares_used where job_nr is null',
		'delete from workdone where job_nr is null',
		'delete from payments where inv_nr is null',
		'delete from invtotal where invoicenr is null',
		'delete from paymentssupp where invoicenr is null'
	]);
	assert.ok(h.logs.some(log => log.action === 'firebird_invoice_cleanup' && log.status === 'passed'));
});

test('Firebird cleanup failure stops migration before reading or writing table data', async () => {
	const h = harness({ cleanupError: 'permission denied', continueOnError: true });
	await h.run();
	assert.equal(h.state().status, 'FAILED');
	assert.equal(h.sourceReads.length, 0);
	assert.equal(h.writes.length, 0);
	assert.match(h.state().lastError.message, /Firebird pre-migration invoice cleanup failed: permission denied/);
	assert.ok(h.logs.some(log => log.action === 'firebird_invoice_cleanup' && log.status === 'failed'));
});

test('preflight waits for staff cleanup in the selected MySQL schema before copying data', async () => {
	const staffCleanupGate = { entered: deferred(), release: deferred() };
	const h = harness({ staffCleanupGate });
	const finished = h.run();
	await Promise.race([staffCleanupGate.entered.promise, finished.then(() => { throw Error(JSON.stringify(h.logs.slice(-3))); })]);
	assert.deepEqual(h.mysqlSchemas, ['fixture']);
	assert.deepEqual(h.targetCleanups, ["delete from staff where staff_group <> 'MASTER'"]);
	assert.equal(h.sourceReads.length, 0);
	assert.equal(h.writes.length, 0);
	staffCleanupGate.release.resolve();
	await finished;
	assert.equal(h.state().status, 'SUCCESS', JSON.stringify(h.logs.slice(-3)));
	assert.ok(h.logs.some(log => log.action === 'mysql_staff_cleanup' && log.status === 'passed' && log.deletedRows === 3));
});

test('MySQL staff cleanup failure stops migration before table data is copied', async () => {
	const h = harness({ staffCleanupError: 'foreign key constraint fails', continueOnError: true });
	await h.run();
	assert.equal(h.state().status, 'FAILED');
	assert.equal(h.sourceReads.length, 0);
	assert.equal(h.writes.length, 0);
	assert.match(h.state().lastError.message, /MySQL pre-migration staff cleanup failed: foreign key constraint fails/);
	assert.ok(h.logs.some(log => log.action === 'mysql_staff_cleanup' && log.status === 'failed'));
});

test('dry runs skip Firebird and MySQL cleanup deletions', async () => {
	const h = harness({ dryRun: true });
	await h.run();
	assert.equal(h.state().status, 'SUCCESS', JSON.stringify(h.logs.slice(-3)));
	assert.equal(h.firebirdQueries.some(query => query.sql.startsWith('delete ')), false);
	assert.equal(h.targetCleanups.length, 0);
	assert.ok(h.logs.some(log => log.action === 'firebird_invoice_cleanup' && log.reason === 'dry_run'));
	assert.ok(h.logs.some(log => log.action === 'mysql_staff_cleanup' && log.reason === 'dry_run'));
});

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

test('duplicate source invoices prefer a nonzero job across batches and count every skipped row', async () => {
	for (const invoiceBatchSize of [1, 1000]) {
		const h = harness({ invoiceBatchSize, invoiceRows: [
			{ inv_nr: 15888, job_card_nr: 0, cid: 1 },
			{ inv_nr: 2, job_card_nr: 0, cid: 2 },
			{ inv_nr: 15888, job_card_nr: 5001, cid: 3 },
			{ inv_nr: 15888, job_card_nr: 7001, cid: 4 },
			{ inv_nr: 2, job_card_nr: 0, cid: 99 }
		] });
		await h.run();
		assert.equal(h.state().status, 'SUCCESS', JSON.stringify(h.logs.slice(-3)));
		assert.deepEqual(h.targetInvoices, [
			{ invoice_nr: 2, job_number: 0, cid: 2 },
			{ invoice_nr: 15888, job_number: 5001, cid: 3 }
		]);
		const table = h.state().tables[0];
		assert.equal(table.total, 5);
		assert.equal(table.processed, 5);
		assert.equal(table.inserted, 2);
		assert.equal(table.skippedDuplicates, 3);
		assert.equal(table.errors, 0);
		assert.equal(h.records.get('invoices').last_offset, 5);
		assert.equal(h.records.get('invoices').rows_skipped_duplicates, 3);
		assert.equal(h.idMappings.filter(params => params[1] === 'INVOICES').length, invoiceBatchSize === 1 ? 2 : 1);
		assert.ok(h.sourceFetches.filter(fetch => fetch.table === 'INVOICES').every(fetch => fetch.orderBy === 'RDB$DB_KEY'));
	}
});

test('dry-run duplicate selection matches the real import without writing invoices', async () => {
	const h = harness({ dryRun: true, invoiceBatchSize: 1, invoiceRows: [
		{ inv_nr: 1, job_card_nr: 0, cid: 1 },
		{ inv_nr: 1, job_card_nr: 7, cid: 2 }
	] });
	await h.run();
	assert.equal(h.state().status, 'SUCCESS', JSON.stringify(h.logs.slice(-3)));
	assert.equal(h.state().tables[0].processed, 2);
	assert.equal(h.state().tables[0].migrated, 1);
	assert.equal(h.state().tables[0].skippedDuplicates, 1);
	assert.equal(h.writes.length, 0);
});

test('filtered invoice keys import one header per number and use raw row offsets', async () => {
	const h = harness({ filteredInvoiceKeys: [1], invoiceBatchSize: 1, invoiceRows: [
		{ inv_nr: 1, job_card_nr: 0, cid: 1 },
		{ inv_nr: 2, job_card_nr: 5, cid: 2 },
		{ inv_nr: 1, job_card_nr: 7, cid: 3 },
		{ inv_nr: 1, job_card_nr: 0, cid: 4 }
	] });
	await h.run();
	assert.equal(h.state().status, 'SUCCESS', JSON.stringify(h.logs.slice(-3)));
	assert.deepEqual(h.targetInvoices, [{ invoice_nr: 1, job_number: 7, cid: 3 }]);
	assert.equal(h.state().tables[0].total, 3);
	assert.equal(h.state().tables[0].processed, 3);
	assert.equal(h.state().tables[0].skippedDuplicates, 2);
});

test('preflight finds preferred duplicates beyond its page boundary', async () => {
	for (const filteredInvoiceKeys of [undefined, [1]]) {
		const h = harness({ filteredInvoiceKeys, invoiceBatchSize: 1000,
			invoiceRows: [...Array.from({ length: 1000 }, () => ({ inv_nr: 1, job_card_nr: 0, cid: 1 })),
				{ inv_nr: 1, job_card_nr: 99, cid: 2 }] });
		await h.run();
		assert.equal(h.state().status, 'SUCCESS', JSON.stringify(h.logs.slice(-3)));
		assert.deepEqual(h.targetInvoices, [{ invoice_nr: 1, job_number: 99, cid: 2 }]);
		assert.equal(h.state().tables[0].total, 1001);
		assert.equal(h.state().tables[0].processed, 1001);
		assert.equal(h.state().tables[0].skippedDuplicates, 1000);
	}
});

test('linked invoice selection preserves offsets across multiple IN-list partitions', async () => {
	const filteredInvoiceKeys = Array.from({ length: 1001 }, (_, index) => index + 1);
	const h = harness({ filteredInvoiceKeys, invoiceBatchSize: 700, invoiceRows: [
		{ inv_nr: 1001, job_card_nr: 0, cid: 99 },
		...filteredInvoiceKeys.map(inv_nr => ({ inv_nr, job_card_nr: inv_nr + 10, cid: 1 }))
	] });
	await h.run();
	assert.equal(h.state().status, 'SUCCESS', JSON.stringify(h.logs.slice(-3)));
	assert.equal(h.targetInvoices.length, 1001);
	assert.deepEqual(h.targetInvoices.find(row => row.invoice_nr === 1001), { invoice_nr: 1001, job_number: 1011, cid: 1 });
	assert.equal(h.state().tables[0].total, 1002);
	assert.equal(h.state().tables[0].processed, 1002);
	assert.equal(h.state().tables[0].skippedDuplicates, 1);
});
