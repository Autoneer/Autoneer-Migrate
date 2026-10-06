const test = require('node:test');
const assert = require('node:assert/strict');
const { findExistingRetryRows } = require('../src/migrate/retryExistingRecords');

const row = (mappedRow, sourceId, dedupeValues = []) => ({ mappedRow, sourceId, dedupeValues });
const noQueries = { query: async () => { throw Error('Unexpected query'); } };

test('invoice retry distinguishes matching headers, wrong owners, and missing invoices sharing real jobs', async () => {
	const existing = [
		{ invoice_nr: 23421, job_number: 0, cid: 42 },
		{ invoice_nr: 13158, job_number: 99, cid: 42 },
		{ invoice_nr: 18196, job_number: 1, cid: 99 }
	];
	const source = [
		{ invoice_nr: 23421, job_number: 0, cid: 42 },
		{ invoice_nr: 13158, job_number: 0, cid: 42 },
		{ invoice_nr: 18196, job_number: 1, cid: 42 },
		{ invoice_nr: 25915, job_number: 99, cid: 42 }
	];
	const matches = await findExistingRetryRows({
		conn: { query: async (sql, params) => {
			assert.match(sql, /WHERE `invoice_nr` IN/);
			assert.deepEqual(params, source.map(invoice => invoice.invoice_nr));
			return [existing];
		} }, pool: noQueries, previousRunId: 4, tableName: 'invoices', primaryKeys: ['invoice_nr'], keyStrategy: 'preserve',
		rows: source.map(invoice => row(invoice, invoice.invoice_nr)), targetColumns: ['invoice_nr', 'job_number', 'cid'],
		invoiceIdentities: new Map(source.map(invoice => [String(invoice.invoice_nr), { invoiceNr: String(invoice.invoice_nr), jobNumber: String(invoice.job_number), cid: String(invoice.cid) }]))
	});
	assert.deepEqual(matches.get(0), { targetPk: 23421, issue: null });
	assert.match(matches.get(1).issue, /source job 0.*target job 99/);
	assert.match(matches.get(2).issue, /source customer 42.*target customer 99/);
	assert.equal(matches.has(3), false);
});

test('preserved composite keys match full identities and support case-insensitive column names', async () => {
	const matches = await findExistingRetryRows({
		conn: { query: async (sql, params) => {
			assert.match(sql, /WHERE \(`job_number`,`lnr`\) IN/);
			assert.deepEqual(params, [1, '002', 1, 3]);
			return [[{ JOB_NUMBER: '1', LNR: 2 }]];
		} }, pool: noQueries, tableName: 'workdone', primaryKeys: ['job_number', 'lnr'], keyStrategy: 'preserve',
		rows: [row({ job_number: 1, lnr: '002' }), row({ job_number: 1, lnr: 3 })]
	});
	assert.deepEqual(matches.get(0), { targetPk: undefined, issue: null });
	assert.equal(matches.has(1), false);
});

test('re-keyed retry uses previous mappings and verifies that mapped target records still exist', async () => {
	const matches = await findExistingRetryRows({
		pool: { query: async (sql, params) => {
			assert.match(sql, /SELECT source_pk, target_pk FROM migration_id_map/);
			assert.deepEqual(params, [4, 'STOCK', '11', '12', '13']);
			return [[{ source_pk: '11', target_pk: '500' }, { source_pk: '12', target_pk: '501' }]];
		} }, conn: { query: async (sql, params) => {
			assert.match(sql, /WHERE `id` IN/);
			assert.deepEqual(params, ['500', '501']);
			return [[{ id: 500 }]];
		} }, previousRunId: 4, tableName: 'stock', primaryKeys: ['id'], keyStrategy: 'rekey',
		rows: [row({ id: 11 }, 11), row({ id: 12 }, 12), row({ id: 13 }, 13)]
	});
	assert.deepEqual([...matches], [[0, { targetPk: 500, issue: null }]]);
});

test('re-keyed records without old mappings can match configured natural keys', async () => {
	const matches = await findExistingRetryRows({ pool: { query: async () => [[]] },
		conn: { query: async (sql, params) => {
			assert.match(sql, /WHERE `code` IN/);
			assert.deepEqual(params, ['part-a', 'part-b']);
			return [[{ id: 500, code: 'part-a' }]];
		} }, previousRunId: 4, tableName: 'stock', primaryKeys: ['id'], keyStrategy: 'rekey', dedupeKeys: ['code'],
		rows: [row({ id: 11, code: 'part-a' }, 11, ['part-a']), row({ id: 12, code: 'part-b' }, 12, ['part-b'])]
	});
	assert.deepEqual([...matches], [[0, { targetPk: 500, issue: null }]]);
});

test('retry ignores unidentified rows and propagates lookup failures instead of skipping blindly', async () => {
	const args = { conn: noQueries, pool: noQueries, tableName: 'stock', primaryKeys: ['id'], keyStrategy: 'preserve', rows: [row({ id: null })] };
	assert.equal((await findExistingRetryRows(args)).size, 0);
	await assert.rejects(findExistingRetryRows({ ...args, rows: [row({ id: 1 })] }), /Unexpected query/);
});

test('large retry batches page target lookups without changing row positions', async () => {
	const pages = [];
	const matches = await findExistingRetryRows({ conn: { query: async (_, params) => { pages.push(params); return [params.map(id => ({ id }))]; } },
		pool: noQueries, tableName: 'stock', primaryKeys: ['id'], keyStrategy: 'preserve', rows: Array.from({ length: 1201 }, (_, i) => row({ id: i + 1 }, i + 1)) });
	assert.deepEqual(pages.map(page => page.length), [500, 500, 201]);
	assert.equal(matches.size, 1201);
	assert.equal(matches.get(1200).targetPk, 1201);
});
