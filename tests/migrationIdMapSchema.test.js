const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureMigrationIdMapSchema } = require('../src/db/migrationIdMapSchema');
const { buildPreservedMappings } = require('../src/migrate/idMapTracker');

function fixture({ legacy = true, duplicates = false, both = false } = {}) {
	const calls = [];
	const names = ['id', 'run_id', 'table_name', ...(legacy ? ['source_id', 'target_id'] : ['source_pk', 'target_pk', 'operation', 'created_at'])];
	if (both) names.push('source_pk', 'target_pk');
	const indexes = legacy ? [] : ['run_id', 'table_name', 'source_pk'].map((columnName, seq) =>
		({ name: 'uk_run_table_source', nonUnique: 0, seq: seq + 1, columnName, prefixLength: null }));
	return { calls, query: async sql => {
		calls.push(sql);
		if (sql.includes('information_schema.columns')) return [names.map(name => ({ name }))];
		if (sql.includes('information_schema.statistics')) return [indexes];
		if (sql.includes('having count(*)')) return [duplicates ? [{ count: 2 }] : []];
		if (sql.startsWith('ALTER TABLE')) return [{}];
		throw Error(`Unexpected query: ${sql}`);
	} };
}

test('legacy ID map is upgraded without deleting mappings or adding blocking legacy fields', async () => {
	const pool = fixture();
	await ensureMigrationIdMapSchema(pool);
	const alters = pool.calls.filter(sql => sql.startsWith('ALTER TABLE'));
	assert.equal(alters.length, 1);
	assert.match(alters[0], /CHANGE COLUMN source_id source_pk varchar\(255\) NOT NULL/);
	assert.match(alters[0], /CHANGE COLUMN target_id target_pk varchar\(255\) NOT NULL/);
	assert.match(alters[0], /ADD COLUMN operation enum\('INSERT','SKIP','UPDATE'\) NULL/);
	assert.match(alters[0], /ADD COLUMN created_at datetime NULL/);
	assert.match(alters[0], /ADD UNIQUE KEY uk_run_table_source \(run_id, table_name, source_pk\)/);
	assert.ok(pool.calls.every(sql => !/delete |drop |truncate /i.test(sql)));
});

test('current ID map schema needs no mutation', async () => {
	const pool = fixture({ legacy: false });
	await ensureMigrationIdMapSchema(pool);
	assert.equal(pool.calls.filter(sql => sql.startsWith('ALTER TABLE')).length, 0);
});

test('ambiguous columns and duplicate mappings stop the upgrade before any mutation', async () => {
	for (const options of [{ both: true }, { duplicates: true }]) {
		const pool = fixture(options);
		await assert.rejects(ensureMigrationIdMapSchema(pool), /reconcile/);
		assert.ok(pool.calls.every(sql => !sql.startsWith('ALTER TABLE')));
	}
});

test('preserved ID mappings use real sparse target IDs in source order', () => {
	const rows = [6968, 5887, 6514].map(id => ({ sourceId: id, mappedRow: { INVOICE_NR: id } }));
	assert.deepEqual(buildPreservedMappings(rows, ['invoice_nr'], 3), rows.map(row =>
		({ sourcePk: row.sourceId, targetPk: row.sourceId, operation: 'INSERT' })));
	assert.deepEqual(buildPreservedMappings(rows, ['invoice_nr'], 2), [], 'an ignored row cannot be identified by its position');
	assert.deepEqual(buildPreservedMappings(rows, ['invoice_nr', 'job_number'], 3), []);
});
