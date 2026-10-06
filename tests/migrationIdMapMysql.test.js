const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureMigrationIdMapSchema } = require('../src/db/migrationIdMapSchema');
const tracker = require('../src/migrate/idMapTracker');

// Opt in with MIGRATION_MYSQL_TEST=1. Only connection-local TEMPORARY tables
// are written; permanent application tables are never altered by this test.
test('MySQL upgrades legacy ID maps, preserves records, and supports repeat writes', {
	skip: process.env.MIGRATION_MYSQL_TEST !== '1'
}, async () => {
	require('dotenv').config();
	const { state } = require('../src/config/state');
	const connection = await require('mysql2/promise').createConnection({ ...state.mysql, database: 'harrys' });
	try {
		await connection.query(`CREATE TEMPORARY TABLE migration_id_map (
			id bigint auto_increment primary key, run_id varchar(36) not null,
			table_name varchar(100) not null, source_id varchar(100) not null, target_id varchar(100) not null
		)`);
		await connection.query("INSERT INTO migration_id_map (run_id, table_name, source_id, target_id) VALUES ('1', 'STOCK', 'old', '42')");
		// Temporary tables are absent from information_schema. Read equivalent
		// metadata with SHOW, while executing all upgrade DDL on the real engine.
		const pool = { query: async (sql, params) => {
			if (sql.includes('information_schema.columns')) {
				const [rows] = await connection.query('SHOW COLUMNS FROM migration_id_map');
				return [rows.map(row => ({ name: row.Field }))];
			}
			if (sql.includes('information_schema.statistics')) {
				const [rows] = await connection.query('SHOW INDEX FROM migration_id_map');
				return [rows.map(row => ({ name: row.Key_name, nonUnique: row.Non_unique, seq: row.Seq_in_index, columnName: row.Column_name, prefixLength: row.Sub_part }))];
			}
			return connection.query(sql, params);
		} };
		await ensureMigrationIdMapSchema(pool);
		await ensureMigrationIdMapSchema(pool);
		const [[old]] = await connection.query("SELECT * FROM migration_id_map WHERE source_pk = 'old'");
		assert.equal(old.target_pk, '42');
		assert.equal(old.operation, null);
		assert.equal(old.created_at, null);
		assert.equal(await tracker.recordBatch(pool, { runId: 1, tableName: 'invoices', mappings: [
			{ sourcePk: 6968, targetPk: 6968 }, { sourcePk: 5887, targetPk: 5887 }
		] }), 2);
		await tracker.recordIdMapping(pool, { runId: 1, tableName: 'INVOICES', sourcePk: 6968, targetPk: 6968, operation: 'SKIP' });
		assert.equal(await tracker.getIdMapCount(pool, 1, 'invoices'), 2);
		assert.equal(await tracker.lookupTargetPk(pool, { runId: 1, parentTable: 'invoices', sourcePk: 6968 }), '6968');
		assert.deepEqual(await tracker.getOperationStats(pool, 1, 'invoices'), { INSERT: 1, SKIP: 1, UPDATE: 0 });
	} finally {
		await connection.end();
	}
});

test('proposed job-zero key accepts unrelated sales and split invoices while rejecting duplicate active real jobs', {
	skip: process.env.MIGRATION_MYSQL_TEST !== '1'
}, async () => {
	require('dotenv').config();
	const { state } = require('../src/config/state');
	const connection = await require('mysql2/promise').createConnection({ ...state.mysql, database: 'harrys' });
	try {
		await connection.query(`CREATE TEMPORARY TABLE invoices (
			invoice_nr int primary key, job_number int, is_split_invoice tinyint default 0,
			voided_at datetime null, credit_for_invoice_nr int null,
			job_number_active int GENERATED ALWAYS AS (
				CASE WHEN COALESCE(is_split_invoice, 0) = 0 AND voided_at IS NULL
				AND credit_for_invoice_nr IS NULL THEN job_number ELSE NULL END
			) STORED, UNIQUE KEY uq_invoices_active_job (job_number_active)
		)`);
		await connection.query('INSERT INTO invoices (invoice_nr, job_number) VALUES (1, 0)');
		await assert.rejects(connection.query('INSERT INTO invoices (invoice_nr, job_number) VALUES (2, 0)'), { code: 'ER_DUP_ENTRY' });
		const sql = require('node:fs').readFileSync(require('node:path').join(__dirname, '../docs/harrys-invoice-job-zero.sql'), 'utf8')
			.replace('`harrys`.`invoices`', '`invoices`');
		await connection.query(sql);
		await connection.query('INSERT INTO invoices (invoice_nr, job_number) VALUES (2, 0), (3, 32502)');
		await assert.rejects(connection.query('INSERT INTO invoices (invoice_nr, job_number) VALUES (4, 32502)'), { code: 'ER_DUP_ENTRY' });
		await connection.query('INSERT INTO invoices (invoice_nr, job_number, is_split_invoice) VALUES (5, 5617, 1), (6, 5617, 1)');
		const [rows] = await connection.query('SELECT invoice_nr, job_number, job_number_active FROM invoices ORDER BY invoice_nr');
		assert.deepEqual(rows.map(row => row.job_number_active), [null, null, 32502, null, null]);
		assert.deepEqual(rows.map(row => row.job_number), [0, 0, 32502, 5617, 5617]);
	} finally {
		await connection.end();
	}
});
