const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureInvoiceActiveJobSchema } = require('../src/db/invoiceActiveJobSchema');

const originalExpression = '(case when ((coalesce(`is_split_invoice`,0) = 0) and (`voided_at` is null) and (`credit_for_invoice_nr` is null)) then `job_number` else NULL end)';
function fixture(overrides = {}, indexes) {
	const column = { columnType: 'int', isNullable: 'YES', extra: 'STORED GENERATED', expression: originalExpression, comment: '', ...overrides };
	const writes = [];
	return { column, writes, query: async sql => {
		if (sql.includes('information_schema.columns')) return [[column]];
		if (sql.includes('information_schema.statistics')) return [indexes || [{ nonUnique: 0, columnName: 'job_number_active', prefixLength: null }]];
		writes.push(sql);
		column.expression = `(case when (\`job_number\` = 0) then NULL else ${originalExpression} end)`;
		return [{}];
	} };
}

test('repair wraps the existing rule and keeps its unique index, storage, type, and comment', async () => {
	const pool = fixture({ columnType: 'bigint unsigned', extra: 'VIRTUAL GENERATED INVISIBLE', comment: "Customer's key" });
	assert.deepEqual(await ensureInvoiceActiveJobSchema(pool), { status: 'updated' });
	assert.equal(pool.writes.length, 1);
	assert.ok(pool.writes[0].includes(`CASE WHEN \`job_number\` = 0 THEN NULL ELSE (${originalExpression}) END`));
	assert.match(pool.writes[0], /bigint unsigned GENERATED ALWAYS AS/);
	assert.match(pool.writes[0], /VIRTUAL COMMENT 'Customer\\'s key' INVISIBLE/);
	assert.doesNotMatch(pool.writes[0], /DROP|UPDATE|INSERT|historical/i);
	assert.deepEqual(await ensureInvoiceActiveJobSchema(pool), { status: 'unchanged' });
	assert.equal(pool.writes.length, 1);
});

test('dry run identifies pending correction without altering the target', async () => {
	const pool = fixture();
	assert.deepEqual(await ensureInvoiceActiveJobSchema(pool, { dryRun: true }), { status: 'pending', reason: 'dry_run' });
	assert.equal(pool.writes.length, 0);
});

test('older targets without the generated column or key are left alone', async () => {
	assert.deepEqual(await ensureInvoiceActiveJobSchema({ query: async () => [[]] }), { status: 'skipped', reason: 'no_active_job_column' });
	const pool = fixture({}, []);
	assert.deepEqual(await ensureInvoiceActiveJobSchema(pool), { status: 'skipped', reason: 'no_active_job_key' });
	assert.equal(pool.writes.length, 0);
});

test('unexpected columns and indexes fail before schema mutation', async () => {
	for (const overrides of [{ extra: '' }, { expression: '' }, { isNullable: 'NO' }, { columnType: 'varchar(50)' }]) {
		const pool = fixture(overrides);
		await assert.rejects(ensureInvoiceActiveJobSchema(pool), /nullable generated integer/);
		assert.equal(pool.writes.length, 0);
	}
	for (const index of [[{ nonUnique: 1, columnName: 'job_number_active' }], [{ nonUnique: 0, columnName: 'job_number' }], [{ nonUnique: 0, columnName: 'job_number_active', prefixLength: 4 }]]) {
		const pool = fixture({}, index);
		await assert.rejects(ensureInvoiceActiveJobSchema(pool), /must be unique/);
		assert.equal(pool.writes.length, 0);
	}
});

test('ALTER failures propagate so invoice migration cannot proceed with the old key', async () => {
	const pool = fixture();
	const query = pool.query;
	pool.query = sql => sql.startsWith('ALTER') ? Promise.reject(Error('permission denied')) : query(sql);
	await assert.rejects(ensureInvoiceActiveJobSchema(pool), /permission denied/);
});
