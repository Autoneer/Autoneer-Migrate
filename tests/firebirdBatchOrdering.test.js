const test = require('node:test');
const assert = require('node:assert/strict');
const firebird = require('../src/db/firebird');

const adapters = [
	['fetchBatchWithDb', false], ['fetchBatchWithDbWhere', true],
	['fetchBatch', false], ['fetchBatchWhere', true]
];

for (const [method, filtered] of adapters) {
	test(`${method} emits the Firebird DB_KEY token without quoting it as a column`, async () => {
		const calls = [];
		const db = { query(sql, params, callback) {
			calls.push({ sql, params });
			if (sql.includes('order by "RDB$DB_KEY"')) {
				return callback(new Error('Dynamic SQL Error, Column unknown, RDB$DB_KEY'));
			}
			callback(null, [{ inv_nr: 15888 }]);
		} };
		const args = [db, 'INVOICES', ['INV_NR', 'JOB_CARD_NR'], 20, 1000, 'RDB$DB_KEY'];
		if (filtered) args.push('"INV_NR" IN (?)', [15888]);
		const rows = await firebird[method](...args);
		assert.deepEqual(rows, [{ inv_nr: 15888 }]);
		assert.deepEqual(calls, [{
			sql: `select first 1000 skip 20 "INV_NR", "JOB_CARD_NR" from "INVOICES"${filtered ? ' where "INV_NR" IN (?)' : ''} order by RDB$DB_KEY`,
			params: filtered ? [15888] : []
		}]);
	});
}

test('ordinary ordering identifiers remain quoted and SQL fragments cannot become expressions', async () => {
	const queries = [];
	const db = { query(sql, _params, callback) { queries.push(sql); callback(null, []); } };
	for (const orderBy of ['INV_NR', 'odd"name', 'RDB$DB_KEY DESC', null, 'rdb$db_key']) {
		await firebird.fetchBatchWithDbWhere(db, 'INVOICES', ['INV_NR'], 0, 1, orderBy);
	}
	assert.deepEqual(queries.map(sql => sql.split('from "INVOICES"')[1]), [
		' order by "INV_NR"', ' order by "odd""name"', ' order by "RDB$DB_KEY DESC"', '', ' order by RDB$DB_KEY'
	]);
});
