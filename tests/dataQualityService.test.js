const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const firebird = require('../src/db/firebird');
const Firebird = require('node-firebird');
const { createAudit } = require('../src/migrate/dataQuality/service');
const { readRecords, auditPath } = require('../src/migrate/dataQuality/store');

async function fixture(t) {
	const base = path.resolve(__dirname, '../data/quality-audits');
	await fs.promises.mkdir(base, { recursive: true });
	const root = await fs.promises.mkdtemp(path.join(base, 'service-test-'));
	t.after(() => { assert.ok(path.resolve(root).startsWith(base + path.sep)); return fs.promises.rm(root, { recursive: true, force: true }); });
	const calls = [];
	const tx = { rollback(callback) { calls.push('rollback'); callback(); } };
	const db = { transaction(isolation, callback) {
		const expected = [...Firebird.ISOLATION_REPEATABLE_READ]; expected[1] = Firebird.ISOLATION_READ_COMMITTED_READ_ONLY[1];
		assert.deepEqual(isolation, expected); calls.push('snapshot'); callback(null, tx);
	}, detach(callback) { calls.push('detach'); callback(); } };
	t.mock.method(firebird, 'attachWithRetry', async () => db);
	t.mock.method(firebird, 'listTablesWithDb', async handle => { assert.equal(handle, tx); return ['INVOICES', 'STOCK']; });
	t.mock.method(firebird, 'listColumnsWithDb', async (handle, name) => { assert.equal(handle, tx); calls.push(`columns:${name}`); return ['INV_NR']; });
	t.mock.method(firebird, 'countRowsWithDb', async (handle, name) => { assert.equal(handle, tx); calls.push(`count:${name}`); return 2; });
	t.mock.method(firebird, 'fetchBatchWithDb', async (handle, name, columns, offset, size, order) => {
		assert.equal(handle, tx); assert.equal(name, 'INVOICES'); assert.equal(order, 'RDB$DB_KEY'); assert.deepEqual(columns, []);
		calls.push(`read:${name}`); return [{ inv_nr: null, original_note: 'recover me' }, { inv_nr: 1001 }].slice(offset, offset + size);
	});
	const pool = { query: async (sql, params) => {
		assert.match(sql, /^SELECT /i, 'preflight must not mutate the target'); calls.push(sql);
		if (sql.includes('information_schema.COLUMNS')) return [[{ TABLE_NAME: 'invoices', COLUMN_NAME: 'invoice_nr', DATA_TYPE: 'int', COLUMN_TYPE: 'int', COLUMN_KEY: 'PRI', IS_NULLABLE: 'NO', EXTRA: 'auto_increment', COLUMN_DEFAULT: null }]];
		if (sql.includes('information_schema.STATISTICS')) return [[{ TABLE_NAME: 'invoices', INDEX_NAME: 'PRIMARY', COLUMN_NAME: 'invoice_nr', SUB_PART: null }]];
		if (sql.includes('information_schema.KEY_COLUMN_USAGE') || sql.includes('information_schema.TABLE_CONSTRAINTS')) return [[]];
		if (sql.includes('FROM `invoices`')) return [[]];
		throw new Error(`Unexpected SQL: ${sql}`);
	} };
	const options = { root, pool, schemaName: 'fixture', mysqlConfig: { host: 'fixture' }, firebirdConfig: { host: 'fixture', database: 'new-tenant.fdb', password: 'not-in-report' },
		plan: [{ table: 'invoices', include: true }, { table: 'stock', include: false }],
		mapping: { tables: { INVOICES: { target: 'invoices', columns: { INV_NR: { target: 'invoice_nr' } } }, STOCK: { target: 'stock', columns: {} } } } };
	return { calls, options };
}

test('service uses one consistent Firebird snapshot and scans selected tables only', async t => {
	const { calls, options } = await fixture(t);
	const progress = [];
	options.onProgress = event => { progress.push(event); calls.push(`progress:${event.phase}`); };
	const result = await createAudit(options);
	assert.ok(calls.indexOf('progress:counting') < calls.indexOf('count:INVOICES'));
	assert.ok(calls.indexOf('progress:reading') < calls.indexOf('read:INVOICES'));
	assert.ok(progress.some(event => event.phase === 'reading' && event.scanned === 0 && event.total === 2 && event.tableIndex === 1 && event.tableCount === 1));
	assert.ok(progress.some(event => event.phase === 'checking_relationships' && event.table === 'invoices' && event.stage === 'links'));
	assert.ok(progress.some(event => event.phase === 'saving_quarantine' && event.table === 'invoices' && event.stage === 'results'));
	assert.equal(result.report.status, 'ready');
	assert.equal(result.report.tables.length, 1);
	assert.deepEqual(result.report.totals, { scanned: 2, accepted: 1, quarantined: 1, review: 0, errors: 0 });
	assert.equal(calls.some(call => /:STOCK$/.test(call)), false);
	assert.deepEqual(calls.slice(-2), ['rollback', 'detach']);
	const rows = []; for await (const row of readRecords(result.tables.get('invoices').acceptedFile)) rows.push(row);
	assert.deepEqual(rows, [{ inv_nr: 1001 }]);
	const dir = auditPath(result.report.id, options, options.root);
	const persisted = await fs.promises.readFile(path.join(dir, 'report.json'), 'utf8');
	assert.equal(persisted.includes('not-in-report'), false);
	const evidence = JSON.parse((await fs.promises.readFile(path.join(dir, 'quarantine.ndjson'), 'utf8')).trim());
	assert.equal(evidence.source.original_note, 'recover me');
});

test('empty text defaults on nullable numeric fields become NULL in both the audited and execution mapping', async t => {
	const { options } = await fixture(t);
	options.mapping.tables.INVOICES.columns.OPTIONAL_NUMBER = { target: 'optional_number', defaultValue: '' };
	t.mock.method(firebird, 'listColumnsWithDb', async () => ['INV_NR', 'OPTIONAL_NUMBER']);
	t.mock.method(firebird, 'fetchBatchWithDb', async () => [{ inv_nr: 1001, optional_number: null }, { inv_nr: 1002, optional_number: 12 }]);
	const query = options.pool.query;
	options.pool.query = async (sql, params) => {
		const result = await query(sql, params);
		if (sql.includes('information_schema.COLUMNS')) result[0].push({ TABLE_NAME: 'invoices', COLUMN_NAME: 'optional_number', DATA_TYPE: 'int', COLUMN_TYPE: 'int', IS_NULLABLE: 'YES', COLUMN_DEFAULT: null });
		return result;
	};
	const result = await createAudit(options);
	assert.equal(result.report.status, 'ready');
	assert.equal(result.report.totals.accepted, 2);
	assert.equal(result.mapping.tables.INVOICES.columns.OPTIONAL_NUMBER.defaultValue, null);
	assert.equal(options.mapping.tables.INVOICES.columns.OPTIONAL_NUMBER.defaultValue, '', 'saved user mapping is not mutated');
	const { mapRow } = require('../src/migrate/rowMapping');
	const mapped = await mapRow({ inv_nr: 1001, optional_number: null }, result.mapping.tables.INVOICES.columns, async () => {});
	assert.equal(mapped.optional_number, null);
	assert.ok(result.report.automaticRepairs.some(item => item.column === 'optional_number'));
});

test('cancelled audit persists its status and releases the source snapshot', async t => {
	const { calls, options } = await fixture(t);
	let caught;
	try { await createAudit({ ...options, checkAbort() { if (calls.includes('read:INVOICES')) throw Object.assign(new Error('Stopped by user'), { code: 'AUDIT_CANCELLED' }); } }); } catch (err) { caught = err; }
	assert.match(caught.message, /Stopped by user/);
	const dir = auditPath(caught.auditId, options, options.root);
	const report = JSON.parse(await fs.promises.readFile(path.join(dir, 'report.json'), 'utf8'));
	assert.equal(report.status, 'cancelled');
	assert.deepEqual(calls.slice(-2), ['rollback', 'detach']);
});

test('metadata read failures fail closed and leave an inspectable report', async t => {
	const { options } = await fixture(t);
	options.pool.query = async () => { throw new Error('Metadata permission denied'); };
	let caught;
	try { await createAudit(options); } catch (err) { caught = err; }
	assert.match(caught.message, /Metadata permission denied/);
	const report = JSON.parse(await fs.promises.readFile(path.join(auditPath(caught.auditId, options, options.root), 'report.json'), 'utf8'));
	assert.equal(report.status, 'failed');
});
