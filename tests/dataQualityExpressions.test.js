const test = require('node:test');
const assert = require('node:assert/strict');
const { generatedExpressionFromDDL, makeEvaluator } = require('../src/migrate/dataQuality/targetExpressions');
const { readTargetMetadata } = require('../src/migrate/dataQuality/service');

test('reads generated SQL preserving literal quotes, backslashes and parentheses', () => {
	for (const expression of ["nullif(upper(trim(`partnr`)),_utf8mb4'')", "concat(`partnr`, 'a)(', 'O\\'Brien', 'C:\\\\parts')", "concat(`partnr`, 'O''Brien')"]) {
		const ddl = 'CREATE TABLE `stock` (\n  `key` varchar(80) GENERATED ALWAYS AS (' + expression + ') STORED,\n  PRIMARY KEY (`id`)\n)';
		assert.equal(generatedExpressionFromDDL(ddl, 'key'), expression);
	}
	assert.throws(() => generatedExpressionFromDDL('CREATE TABLE t ()', 'key'), /Cannot read/);
});

test('metadata replaces escaped generated SQL with SHOW CREATE SQL', async () => {
	const calls = [];
	const pool = { query: async sql => {
		calls.push(sql);
		if (sql.includes('information_schema.COLUMNS')) return [[{ TABLE_NAME: 'stock', COLUMN_NAME: 'partnr_unique_key', DATA_TYPE: 'varchar', COLUMN_TYPE: 'varchar(50)', GENERATION_EXPRESSION: "nullif(`partnr`,_utf8mb4\\'\\')" }]];
		if (sql.startsWith('SELECT @@')) return [[{ sql_mode: '' }]];
		if (sql.startsWith('SHOW CREATE')) return [[{ 'Create Table': "CREATE TABLE `stock` (\n  `partnr_unique_key` varchar(50) GENERATED ALWAYS AS (nullif(`partnr`,_utf8mb4'')) VIRTUAL\n)" }]];
		return [[]];
	} };
	const meta = await readTargetMetadata(pool);
	assert.equal(meta.get('stock').columns[0].expression, "nullif(`partnr`,_utf8mb4'')");
	assert.equal(calls.filter(sql => sql.startsWith('SHOW')).length, 1);
});

test('SQL setup failures stop once instead of marking every row as bad data', async () => {
	let calls = 0;
	const evaluate = makeEvaluator({ query: async () => { calls++; throw Object.assign(Error('Invalid SQL'), { code: 'ER_PARSE_ERROR' }); } }, {
		name: 'stock', columns: [{ name: 'partnr', type: 'varchar' }, { name: 'key', generated: true, expression: 'bad SQL' }]
	});
	const records = [1, 2].map(() => ({ mapped: { partnr: 'valid' }, reasons: [] }));
	await assert.rejects(evaluate(records), /checker\/schema issue/);
	assert.equal(calls, 1);
	assert.equal(records.some(row => row.reasons.length), false);
});
