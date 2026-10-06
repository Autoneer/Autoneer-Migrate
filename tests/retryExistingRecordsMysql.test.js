const test = require('node:test');
const assert = require('node:assert/strict');
const { findExistingRetryRows } = require('../src/migrate/retryExistingRecords');

test('MySQL retry leaves matching invoices untouched, inserts missing headers, and retains active-job uniqueness', {
	skip: process.env.MIGRATION_MYSQL_TEST !== '1'
}, async () => {
	require('dotenv').config();
	const { state } = require('../src/config/state');
	const conn = await require('mysql2/promise').createConnection({ ...state.mysql, database: state.schemaName });
	try {
		await conn.query(`CREATE TEMPORARY TABLE invoices (
			invoice_nr int PRIMARY KEY, job_number int, cid int, comments varchar(100),
			is_historical_import tinyint DEFAULT 0, is_split_invoice tinyint DEFAULT 0,
			voided_at datetime NULL, credit_for_invoice_nr int NULL,
			job_number_active int GENERATED ALWAYS AS (
				CASE WHEN job_number <> 0 AND is_split_invoice = 0 AND voided_at IS NULL
				AND credit_for_invoice_nr IS NULL THEN job_number ELSE NULL END
			) STORED, UNIQUE KEY uq_invoices_active_job (job_number_active)
		)`);
		await conn.query("INSERT INTO invoices (invoice_nr, job_number, cid, comments) VALUES (23421, 0, 42, 'original'), (1, 500, 42, 'real job')");
		const source = [
			{ invoice_nr: 23421, job_number: 0, cid: 42, comments: 'source comment' },
			{ invoice_nr: 13158, job_number: 0, cid: 42, comments: 'general sale' },
			{ invoice_nr: 2, job_number: 500, cid: 42, comments: 'conflict' }
		];
		const args = { conn, pool: conn, previousRunId: 4, tableName: 'invoices', primaryKeys: ['invoice_nr'], keyStrategy: 'preserve',
			targetColumns: ['invoice_nr', 'job_number', 'cid'], rows: source.map(invoice => ({ mappedRow: invoice, sourceId: invoice.invoice_nr })),
			invoiceIdentities: new Map(source.map(invoice => [String(invoice.invoice_nr), { invoiceNr: String(invoice.invoice_nr), jobNumber: String(invoice.job_number), cid: String(invoice.cid) }])) };
		const matches = await findExistingRetryRows(args);
		assert.deepEqual([...matches], [[0, { targetPk: 23421, issue: null }]]);
		await conn.query('INSERT INTO invoices (invoice_nr, job_number, cid, comments) VALUES (?, ?, ?, ?)', Object.values(source[1]));
		await assert.rejects(conn.query('INSERT INTO invoices (invoice_nr, job_number, cid, comments) VALUES (?, ?, ?, ?)', Object.values(source[2])), { code: 'ER_DUP_ENTRY' });
		const [[original]] = await conn.query('SELECT * FROM invoices WHERE invoice_nr = 23421');
		assert.equal(original.comments, 'original');
		assert.equal(original.is_historical_import, 0);
		assert.equal(original.job_number, 0);
		const next = await findExistingRetryRows(args);
		assert.deepEqual([...next.keys()], [0, 1]);
		assert.equal(next.get(1).issue, null);
	} finally {
		await conn.end();
	}
});
