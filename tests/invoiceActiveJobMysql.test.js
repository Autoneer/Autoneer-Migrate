const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureInvoiceActiveJobSchema } = require('../src/db/invoiceActiveJobSchema');

// These opt-in checks write connection-local temporary tables only.
for (const storage of ['STORED', 'VIRTUAL']) {
	test(`MySQL ${storage} key permits general invoices and retains real-job uniqueness`, {
		skip: process.env.MIGRATION_MYSQL_TEST !== '1'
	}, async () => {
		require('dotenv').config();
		const { state } = require('../src/config/state');
		const connection = await require('mysql2/promise').createConnection({ ...state.mysql, database: state.schemaName });
		try {
			await connection.query(`CREATE TEMPORARY TABLE invoices (
				invoice_nr int PRIMARY KEY, job_number int, cid int DEFAULT 42,
				is_split_invoice tinyint DEFAULT 0, is_historical_import tinyint DEFAULT 0,
				voided_at datetime NULL, credit_for_invoice_nr int NULL,
				job_number_active int GENERATED ALWAYS AS (
					CASE WHEN COALESCE(is_split_invoice, 0) = 0 AND voided_at IS NULL
					AND credit_for_invoice_nr IS NULL THEN job_number ELSE NULL END
				) ${storage}, UNIQUE KEY uq_invoices_active_job (job_number_active)
			)`);
			await connection.query('INSERT INTO invoices (invoice_nr, job_number) VALUES (23421, 0), (1, 32502)');
			await assert.rejects(connection.query('INSERT INTO invoices (invoice_nr, job_number) VALUES (13158, 0)'), { code: 'ER_DUP_ENTRY' });
			const [before] = await connection.query('SELECT invoice_nr, job_number, cid, is_historical_import FROM invoices ORDER BY invoice_nr');
			// Temporary tables are absent from information_schema. Read their actual
			// engine metadata with SHOW and execute the production ALTER unchanged.
			const pool = { query: async sql => {
				if (sql.includes('information_schema.columns')) {
					const [[ddl]] = await connection.query('SHOW CREATE TABLE invoices');
					const expression = Object.values(ddl)[1].match(/`job_number_active`[^\n]*?GENERATED ALWAYS AS \((.+)\) (?:STORED|VIRTUAL)/)[1];
					const [columns] = await connection.query('SHOW FULL COLUMNS FROM invoices');
					const col = columns.find(row => row.Field === 'job_number_active');
					return [[{ columnType: col.Type, isNullable: col.Null, extra: col.Extra, expression, comment: col.Comment }]];
				}
				if (sql.includes('information_schema.statistics')) {
					const [index] = await connection.query('SHOW INDEX FROM invoices');
					return [index.filter(row => row.Key_name === 'uq_invoices_active_job').map(row => ({ nonUnique: row.Non_unique, columnName: row.Column_name, prefixLength: row.Sub_part }))];
				}
				return connection.query(sql);
			} };
			assert.equal((await ensureInvoiceActiveJobSchema(pool, { dryRun: true })).status, 'pending');
			assert.equal((await ensureInvoiceActiveJobSchema(pool)).status, 'updated');
			assert.equal((await ensureInvoiceActiveJobSchema(pool)).status, 'unchanged');
			const [after] = await connection.query('SELECT invoice_nr, job_number, cid, is_historical_import FROM invoices ORDER BY invoice_nr');
			assert.deepEqual(after, before);
			await connection.query('INSERT INTO invoices (invoice_nr, job_number) VALUES (13158, 0), (25915, 0), (24597, 0), (18196, 0), (2, NULL), (3, NULL)');
			await assert.rejects(connection.query('INSERT INTO invoices (invoice_nr, job_number) VALUES (4, 32502)'), { code: 'ER_DUP_ENTRY' });
			await assert.rejects(connection.query('INSERT INTO invoices (invoice_nr, job_number, is_historical_import) VALUES (4, 32502, 1)'), { code: 'ER_DUP_ENTRY' });
			await assert.rejects(connection.query('INSERT INTO invoices (invoice_nr, job_number) VALUES (23421, 0)'), { code: 'ER_DUP_ENTRY' });
			await connection.query(`INSERT INTO invoices (invoice_nr, job_number, is_split_invoice) VALUES (5, 32502, 1), (6, 32502, 1)`);
			await connection.query("INSERT INTO invoices (invoice_nr, job_number, voided_at) VALUES (7, 32502, '2026-10-06')");
			await connection.query('INSERT INTO invoices (invoice_nr, job_number, credit_for_invoice_nr) VALUES (8, 32502, 1)');
			const [[counts]] = await connection.query('SELECT COUNT(*) AS count, SUM(job_number_active IS NOT NULL) AS active_keys FROM invoices');
			assert.equal(counts.count, 12);
			assert.equal(Number(counts.active_keys), 1);
			const [general] = await connection.query('SELECT * FROM invoices WHERE job_number = 0');
			assert.equal(general.length, 5);
			assert.ok(general.every(row => row.job_number_active === null && row.is_historical_import === 0 && row.cid === 42));
		} finally {
			await connection.end();
		}
	});
}
