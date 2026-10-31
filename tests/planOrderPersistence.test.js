const test = require('node:test');
const assert = require('node:assert/strict');
const Plan = require('../src/migrate/models/Plan');
const { normalizePlanTables } = require('../src/migrate/utils/tableNameCanonical');
const { normalizePlanSteps } = require('../src/migrate/planNormalize');

test('saved explicit order survives database JSON object key reordering', () => {
	const input = [{ table: 'CUSTOMERS', cleanBefore: false }, { table: 'JOB_INFORMATION', batchSize: 222 }, { table: 'INVOICES' }, { table: 'STAFF', cleanBefore: false, mode: 'UPSERT', keyStrategy: 'rekey' }];
	const normalized = normalizePlanTables(input, {});
	const plan = Plan.fromJSON({ tables: normalized.tablesObject, tableOrder: normalized.tablesList });
	const stored = plan.toJSON();
	stored.tables = Object.fromEntries(Object.entries(stored.tables).sort(([a], [b]) => a.length - b.length || a.localeCompare(b)));
	assert.notDeepEqual(Object.keys(stored.tables), input.map(item => item.table));
	const loaded = Plan.fromJSON(JSON.parse(JSON.stringify(stored)));
	assert.deepEqual(loaded.getIncludedTables(), input.map(item => item.table));
	const scanSteps = normalizePlanSteps(loaded.toJSON(), {});
	assert.deepEqual(scanSteps.map(item => item.table), input.map(item => item.table));
	assert.equal(scanSteps[1].batchSize, 222);
	assert.equal(scanSteps[3].cleanBefore, false);
	assert.equal(scanSteps[3].mode, 'UPSERT');
	assert.equal(scanSteps[3].keyStrategy, 'rekey');
});

test('array configurations retain explicit false flags and source aliases normalize in order', () => {
	const normalized = normalizePlanTables([{ table: 'WORKDONE', cleanBefore: false, include: false, dedupeKeys: ['wdid'] }, { table: 'CUSTOMER', cleanBefore: true }], { tables: { WORKDONE: { target: 'work_done' }, CUSTOMER: { target: 'customers' } } });
	assert.deepEqual(normalized.tablesList, ['WORK_DONE', 'CUSTOMERS']);
	assert.equal(normalized.tablesObject.WORK_DONE.include, false);
	assert.equal(normalized.tablesObject.WORK_DONE.cleanBefore, false);
	assert.equal(normalized.tablesObject.CUSTOMERS.cleanBefore, true);
});

test('legacy plans remain compatible and removed order entries do not reappear', () => {
	const plan = Plan.fromJSON({ tables: { STOCK: {}, STAFF: {} }, tableOrder: ['STAFF', 'missing', 'staff'] });
	assert.deepEqual(plan.getIncludedTables(), ['STAFF', 'STOCK']);
	assert.deepEqual(Plan.fromJSON({ tables: { STOCK: {}, STAFF: {} } }).getIncludedTables(), ['STOCK', 'STAFF']);
	assert.deepEqual(Plan.fromJSON({ tables: [{ table: 'INVOICES' }, { table: 'STOCK' }] }).getIncludedTables(), ['INVOICES', 'STOCK']);
});
