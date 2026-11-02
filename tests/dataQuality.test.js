const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { auditTables, validateValue } = require('../src/migrate/dataQuality/engine');
const { createStore, readRecords, openBatchReader, auditPath } = require('../src/migrate/dataQuality/store');
const { inDateScope } = require('../src/migrate/dataQuality/service');
const { makeEvaluator } = require('../src/migrate/dataQuality/targetExpressions');
const { applyCorrections, fingerprint } = require('../src/migrate/dataQuality/corrections');

const integer = (name, extras = {}) => ({ name, type: 'int', nullable: true, defaultValue: null, ...extras });
const text = (name, extras = {}) => ({ name, type: 'varchar', nullable: true, defaultValue: null, length: 70, ...extras });
function table(name, columns, rows, extras = {}) {
	const pks = columns.filter(col => col.primary).map(col => col.name);
	return { name, sourceTable: name.toUpperCase(), columns, sourceColumns: columns.map(col => col.name.toUpperCase()),
		mapping: Object.fromEntries(columns.map(col => [col.name.toUpperCase(), { target: col.name }])),
		step: { mode: 'INSERT', keyStrategy: 'preserve', cleanBefore: false, dedupeKeys: [] },
		indexes: pks.length ? [{ name: 'PRIMARY', columns: pks }] : [], relations: [],
		rows: async function* () { yield* rows; }, ...extras };
}
async function audit(t, tables, targets = {}, lookupKeys = {}, options = {}) {
	const base = path.resolve(__dirname, '../data/quality-audits');
	await fs.promises.mkdir(base, { recursive: true });
	const root = await fs.promises.mkdtemp(path.join(base, 'test-'));
	t.after(() => { assert.ok(path.resolve(root).startsWith(base + path.sep)); return fs.promises.rm(root, { recursive: true, force: true }); });
	const store = await createStore({ schemaName: 'fixture' }, root);
	const report = { id: store.id, tables: [] };
	const progress = [];
	await options.beforeAudit?.(tables, store, report);
	const result = await auditTables({ tables, store, report, ...options, onProgress: event => progress.push(event), loadTargetRows: async function* (name) { yield* targets[name] || []; }, loadLookupKeys: async function* (name) { yield* lookupKeys[name] || []; } });
	const evidence = (await fs.promises.readFile(path.join(store.dir, 'quarantine.ndjson'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
	return { ...result, evidence, store, progress };
}
const collect = async iterator => { const rows = []; for await (const row of iterator) rows.push(row); return rows; };

test('selective technical-ID repair preserves referenced IDs, line values and original evidence', async t => {
	const { wrapLineIdRepairs } = require('../src/migrate/dataQuality/lineIdRepairs');
	const lines = table('work_done', [integer('wdid', { primary: true, autoIncrement: true }), integer('job_number'), integer('amount')], [
		{ wdid: 2, job_number: 1, amount: 10 }, { wdid: 2, job_number: 1, amount: 20 },
		{ wdid: 3, job_number: 1, amount: 30 }, { wdid: 3, job_number: 1, amount: 40 },
		{ wdid: null, job_number: 1, amount: 50 }, { wdid: 4, job_number: 1, amount: 60 }
	]);
	lines.mapping.WDID.defaultValue = '0';
	const result = await audit(t, [lines], {}, {}, { beforeAudit: (_tables, store, report) => {
		report.automaticRepairs = []; wrapLineIdRepairs(lines, new Set(['3', '99']), store, report, () => {});
	} });
	const accepted = await collect(readRecords(lines.acceptedFile));
	assert.deepEqual(accepted.map(row => row.amount), [10, 20, 50, 60]);
	assert.deepEqual(accepted.map(row => row.wdid), ['100', '101', '102', 4]);
	assert.equal(result.report.totals.review, 2, 'referenced ambiguous IDs stay blocked');
	assert.equal(result.report.automaticRepairs[0].count, 3);
	assert.equal(result.evidence[0].source.wdid, 3);
});

test('saved group exclusion cascades through dependent records but keeps existing destination parents usable', async t => {
	const parent = table('jobs', [integer('id', { primary: true }), text('name', { nullable: false })], [{ id: 1, name: null }, { id: 2, name: null }]);
	const child = table('lines', [integer('id', { primary: true }), integer('job_id')], [{ id: 10, job_id: 1 }, { id: 20, job_id: 2 }], { relations: [{ columns: ['job_id'], parent: 'jobs', parentColumns: ['id'] }] });
	const excludedRecords = new Set([1, 2].map(id => 'jobs:' + fingerprint({ id, name: null })));
	const result = await audit(t, [parent, child], { jobs: [{ id: 2, name: 'retain me' }] }, {}, { excludedRecords });
	assert.equal(result.report.status, 'ready');
	assert.deepEqual(await collect(readRecords(child.acceptedFile)), [{ id: 20, job_id: 2 }]);
	assert.ok(result.evidence.find(row => row.table === 'lines').reasons.some(reason => reason.code === 'EXCLUDED_WITH_PARENT'));
	assert.deepEqual(result.evidence.find(row => row.table === 'lines').reasons.find(reason => reason.code === 'MISSING_PARENT').parentOrdinals, [0]);
});

test('all selected tables are scanned, including unfamiliar tables and bad rows beyond the first batch', async t => {
	const rows = Array.from({ length: 1205 }, (_, i) => ({ id: i + 1, name: i === 1204 ? null : 'valid' }));
	const result = await audit(t, [
		table('custom_assets', [integer('id', { primary: true, nullable: false }), text('name', { nullable: false })], rows),
		table('another_table', [integer('id', { primary: true })], [{ id: 1 }])
	]);
	assert.equal(result.report.status, 'blocked');
	assert.deepEqual(result.report.totals, { scanned: 1206, accepted: 1205, quarantined: 0, review: 1, errors: 0 });
	assert.equal(result.evidence[0].source.id, 1205);
	const starts = result.progress.filter(event => event.phase === 'validating_definition');
	assert.deepEqual(starts.map(event => [event.table, event.tableIndex, event.tableCount, event.scanned]), [['custom_assets', 1, 2, 0], ['another_table', 2, 2, 0]]);
	assert.ok(result.progress.some(event => event.table === 'custom_assets' && event.scanned === 200));
});

test('missing business identities are quarantined with the complete original row and no fabricated invoice number', async t => {
	const invoices = table('invoices', [integer('invoice_nr', { primary: true }), text('comments')], [
		{ invoice_nr: null, comments: 'original row' }, { invoice_nr: 1001, comments: 'valid' }
	]);
	invoices.mapping.INVOICE_NR.default = 9999;
	const result = await audit(t, [invoices]);
	assert.equal(result.report.status, 'ready');
	assert.equal(result.report.totals.quarantined, 1);
	assert.equal(result.evidence[0].source.invoice_nr, null);
	assert.equal(result.evidence[0].source.comments, 'original row');
	assert.deepEqual(await collect(readRecords(invoices.acceptedFile)), [{ invoice_nr: 1001, comments: 'valid' }]);
});

test('blank stock with value requires review; empty stock is quarantined', async t => {
	const result = await audit(t, [table('stock', [integer('stock_id', { primary: true }), text('partnr'), integer('quantity')], [
		{ stock_id: 1, partnr: '  ', quantity: 0 }, { stock_id: 2, partnr: null, quantity: 3 }, { stock_id: 3, partnr: 'ABC', quantity: 2 }
	])]);
	assert.equal(result.report.totals.quarantined, 1);
	assert.equal(result.report.totals.review, 1);
	assert.equal(result.report.totals.accepted, 1);
});

test('open-job parts and labour keep NULL invoice numbers while orphan jobs are blocked', async t => {
	const jobs = table('job_information', [integer('job_number', { primary: true })], [{ job_number: 1 }]);
	const parts = table('spares_used', [integer('id', { primary: true }), integer('job_number'), integer('invoice_nr')], [
		{ id: 1, job_number: 1, invoice_nr: null }, { id: 2, job_number: 99, invoice_nr: null }
	], { relations: [{ columns: ['job_number'], parent: 'job_information', parentColumns: ['job_number'] }, { columns: ['invoice_nr'], parent: 'invoices', parentColumns: ['invoice_nr'], optionalZero: true }] });
	const result = await audit(t, [jobs, parts]);
	assert.equal(parts.summary.accepted, 1);
	assert.equal(parts.summary.review, 1);
	assert.equal((await collect(readRecords(parts.acceptedFile)))[0].invoice_nr, null);
	assert.equal(result.evidence[0].reasons[0].code, 'MISSING_PARENT');
});

test('general-invoice parts and labour on job 0 migrate by their invoice number; lines with neither are still flagged', async t => {
	const invoices = table('invoices', [integer('invoice_nr', { primary: true }), integer('job_number')], [{ invoice_nr: 26497, job_number: 0 }]);
	const relations = [{ columns: ['job_number'], parent: 'job_information', parentColumns: ['job_number'], optionalZero: true }, { columns: ['invoice_nr'], parent: 'invoices', parentColumns: ['invoice_nr'], optionalZero: true }];
	const parts = table('spares_used', [integer('spares_id', { primary: true }), integer('job_number'), integer('invoice_nr'), integer('quantity')], [
		{ spares_id: 1, job_number: 0, invoice_nr: 26497, quantity: 1 }, { spares_id: 2, job_number: 0, invoice_nr: 0, quantity: 1 }, { spares_id: 3, job_number: 0, invoice_nr: 404, quantity: 1 }
	], { relations });
	const labour = table('work_done', [integer('wdid', { primary: true }), integer('job_number'), integer('invoice_nr')], [
		{ wdid: 1, job_number: 0, invoice_nr: 26497 }, { wdid: 2, job_number: 0, invoice_nr: null }
	], { relations });
	const result = await audit(t, [table('job_information', [integer('job_number', { primary: true })], []), invoices, parts, labour]);
	assert.deepEqual((await collect(readRecords(parts.acceptedFile))).map(row => row.spares_id), [1]);
	assert.deepEqual((await collect(readRecords(labour.acceptedFile))).map(row => row.wdid), [1]);
	const reasons = (name, id) => result.evidence.find(row => row.table === name && (row.source.spares_id ?? row.source.wdid) === id).reasons.map(reason => reason.code);
	assert.ok(reasons('spares_used', 2).includes('MISSING_IDENTITY'));
	assert.ok(reasons('spares_used', 3).includes('MISSING_PARENT'), 'the invoice number must still name a migrated invoice');
	assert.ok(reasons('work_done', 2).includes('MISSING_IDENTITY'));
});

test('a rejected parent blocks its descendants and referenced stock is not silently removed', async t => {
	const stock = table('stock', [integer('stock_id', { primary: true }), text('partnr')], [{ stock_id: 7, partnr: null }]);
	const lines = table('custom_lines', [integer('id', { primary: true }), integer('stock_id')], [{ id: 8, stock_id: 7 }], { relations: [{ columns: ['stock_id'], parent: 'stock', parentColumns: ['stock_id'] }] });
	const child = table('custom_details', [integer('id', { primary: true }), integer('line_id')], [{ id: 9, line_id: 8 }], { relations: [{ columns: ['line_id'], parent: 'custom_lines', parentColumns: ['id'] }] });
	const result = await audit(t, [child, lines, stock]);
	assert.equal(result.report.totals.review, 3);
	assert.equal(result.report.totals.accepted, 0);
	assert.ok(result.evidence.find(row => row.table === 'stock').reasons.some(reason => reason.code === 'REFERENCED_STOCK'));
});

test('unselected parents are read from the target; scheduled target cleaning invalidates those parents', async t => {
	const relation = { columns: ['parent_id'], parent: 'parents', parentColumns: ['id'], parentMetadata: [integer('id')] };
	const child = () => table('children', [integer('id', { primary: true }), integer('parent_id')], [{ id: 2, parent_id: 10 }], { relations: [relation] });
	const first = await audit(t, [child()], { parents: [{ id: 10 }] });
	assert.equal(first.report.status, 'ready');
	const parents = table('parents', [integer('id', { primary: true })], [], { step: { mode: 'INSERT', keyStrategy: 'preserve', cleanBefore: true } });
	const second = await audit(t, [child(), parents], { parents: [{ id: 10 }] });
	assert.equal(second.report.status, 'blocked');
});

test('stock rejected for another value is not labelled as missing its part number', async t => {
	const stock = table('stock', [integer('stock_id', { primary: true }), text('partnr'), text('description', { length: 2 })], [{ stock_id: 7, partnr: 'VALID', description: 'too long' }]);
	const lines = table('custom_lines', [integer('id', { primary: true }), integer('stock_id')], [{ id: 8, stock_id: 7 }], { relations: [{ columns: ['stock_id'], parent: 'stock', parentColumns: ['stock_id'] }] });
	const result = await audit(t, [stock, lines]);
	assert.equal(result.report.status, 'blocked');
	const reasons = result.evidence.find(row => row.table === 'stock').reasons;
	assert.ok(reasons.some(reason => reason.code === 'INVALID_VALUE'));
	assert.ok(!reasons.some(reason => reason.code === 'REFERENCED_STOCK'));
});

test('duplicates across batch boundaries block both records, including case-insensitive unique text keys', async t => {
	const rows = Array.from({ length: 205 }, (_, i) => ({ id: i + 1, code: `C${i}` }));
	rows[204].code = 'c0';
	const result = await audit(t, [table('custom_codes', [integer('id', { primary: true }), text('code', { collation: 'utf8mb4_unicode_ci' })], rows,
		{ indexes: [{ name: 'unique_code', columns: ['code'] }] })]);
	assert.equal(result.report.totals.review, 2);
	assert.deepEqual(result.evidence.map(row => row.source.id), [1, 205]);
});

test('identical copies with the same primary key are excluded while their child keeps its accepted parent', async t => {
	const parents = table('parents', [integer('id', { primary: true }), text('name')], [{ id: 1, name: 'same' }, { id: 1, name: 'same' }]);
	const child = table('children', [integer('id', { primary: true }), integer('parent_id')], [{ id: 1, parent_id: 1 }], { relations: [{ columns: ['parent_id'], parent: 'parents', parentColumns: ['id'] }] });
	const result = await audit(t, [parents, child]);
	assert.equal(result.report.status, 'ready');
	assert.equal(result.report.totals.accepted, 2);
	assert.equal(result.report.totals.quarantined, 1);
	assert.equal(result.evidence[0].reasons[0].code, 'IDENTICAL_DUPLICATE');
});

test('saved corrections are validated and reach accepted snapshots without modifying original records', async t => {
	const original = { invoice_nr: null, amount: 50 };
	const corrected = applyCorrections({ ['invoices:' + fingerprint(original)]: { fields: { invoice_nr: '1200' } } }, 'invoices', original);
	const invoices = table('invoices', [integer('invoice_nr', { primary: true }), integer('amount')], [corrected]);
	const result = await audit(t, [invoices]);
	assert.equal(result.report.status, 'ready');
	assert.equal((await collect(readRecords(invoices.acceptedFile)))[0].invoice_nr, '1200');
	assert.equal(original.invoice_nr, null);
});

test('a correction that remains invalid retains original evidence and stays blocked', async t => {
	const original = { invoice_nr: null, amount: 50 };
	const corrected = applyCorrections({ ['invoices:' + fingerprint(original)]: { fields: { invoice_nr: 'not-a-number' } } }, 'invoices', original);
	const result = await audit(t, [table('invoices', [integer('invoice_nr', { primary: true }), integer('amount')], [corrected])]);
	assert.equal(result.report.status, 'blocked');
	assert.equal(result.evidence[0].source.invoice_nr, null);
	assert.equal(result.evidence[0].mapped.invoice_nr, 'not-a-number');
});

test('explicit bulk exclusion quarantines unresolved rows and their dependants, preserving evidence', async t => {
	const parent = table('parents', [integer('id', { primary: true }), text('name', { nullable: false })], [{ id: 1, name: null }]);
	const child = table('children', [integer('id', { primary: true }), integer('parent_id')], [{ id: 1, parent_id: 1 }], { relations: [{ columns: ['parent_id'], parent: 'parents', parentColumns: ['id'] }] });
	const result = await audit(t, [parent, child], {}, {}, { excludeUnresolved: true });
	assert.equal(result.report.status, 'ready');
	assert.equal(result.report.totals.review, 0);
	assert.equal(result.report.totals.quarantined, 2);
	assert.equal(result.evidence.length, 2);
	assert.ok(result.evidence.every(row => row.reasons.some(reason => reason.code === 'EXCLUDED_BY_POLICY')));
});

test('bulk exclusion cannot bypass invalid mapping definitions', async t => {
	const item = table('custom', [integer('id', { primary: true }), text('required', { nullable: false })], [], { mapping: { ID: { target: 'id' } } });
	const result = await audit(t, [item], {}, {}, { excludeUnresolved: true });
	assert.equal(result.report.status, 'blocked');
	assert.ok(result.report.totals.errors > 0);
});

test('target key collisions block before import; cleanBefore ignores target keys', async t => {
	const make = cleanBefore => table('custom_codes', [integer('id', { primary: true })], [{ id: 1 }], { step: { mode: 'INSERT', keyStrategy: 'preserve', cleanBefore } });
	assert.equal((await audit(t, [make(false)], { custom_codes: [{ id: 1 }] })).report.status, 'blocked');
	assert.equal((await audit(t, [make(true)], { custom_codes: [{ id: 1 }] })).report.status, 'ready');
});

test('omitted columns and explicit mapping defaults match the import payload', async t => {
	const item = table('custom_rows', [integer('id', { primary: true }), integer('required', { nullable: false }), text('ignored', { nullable: false, defaultValue: 'db-default' })], [{ id: 1, required: null, ignored: null }]);
	item.mapping.REQUIRED.defaultValue = 12;
	item.mapping.IGNORED.omit = true;
	const result = await audit(t, [item]);
	assert.equal(result.report.status, 'ready');
	const broken = table('custom_rows', [integer('id', { primary: true }), integer('required', { nullable: false, defaultValue: 5 })], [{ id: 1, required: null }]);
	assert.equal((await audit(t, [broken])).report.status, 'blocked', 'explicit NULL must not silently use a database default');
});

test('invalid transform output, numeric overflow, precision loss, impossible dates and long text require review', () => {
	assert.match(validateValue('abc', integer('n')), /numeric/);
	assert.match(validateValue('2147483648', integer('n')), /range/);
	assert.match(validateValue('123.456', { name: 'n', type: 'decimal', precision: 5, scale: 2 }), /fractional/);
	assert.match(validateValue('2024-02-31', { type: 'date' }), /date/);
	assert.match(validateValue('2024-01-01 30:00:00', { type: 'datetime' }), /timestamp/);
	assert.match(validateValue('1234', text('x', { length: 3 })), /length/);
	assert.equal(validateValue('2024-02-29', { type: 'date' }), null);
	assert.equal(validateValue('', text('optional', { nullable: false, defaultValue: '' })), null);
	assert.match(validateValue(' ', text('required', { nullable: false })), /blank/);
});

test('snapshot batching preserves dates and binary evidence and never returns quarantined rows', async t => {
	const date = new Date('2025-01-01T00:00:00Z'), blob = Buffer.from([0, 1, 255]);
	const item = table('custom_rows', [integer('id', { primary: true }), { name: 'date', type: 'datetime', nullable: true }, { name: 'blob', type: 'blob', nullable: true }], [{ id: 1, date, blob }, { id: 2, date, blob }]);
	await audit(t, [item]);
	const reader = await openBatchReader(item.acceptedFile, 1);
	try { assert.deepEqual(await reader.next(10), [{ id: 2, date, blob }]); assert.deepEqual(await reader.next(1), []); }
	finally { await reader.close(); }
});

test('date scopes include linked historical rows and preserve all master data', () => {
	const filter = { startDate: '2025-01-01', sourceColumn: 'DATE', linkPlans: [{ clause: '"JOB_NR" IN (?, ?)', params: ['10', '20'] }] };
	assert.equal(inDateScope({ date: '2024-01-01', job_nr: 10 }, filter), true);
	assert.equal(inDateScope({ date: '2025-02-01', job_nr: 30 }, filter), true);
	assert.equal(inDateScope({ date: '2024-01-01', job_nr: 30 }, filter), false);
	assert.equal(inDateScope({}, null), true);
});

test('audit storage cannot traverse paths and is isolated by tenant and host', () => {
	assert.throws(() => auditPath('../outside', { schemaName: 'fixture' }));
	const id = '00000000-0000-0000-0000-000000000000';
	assert.notEqual(auditPath(id, { schemaName: 'one' }), auditPath(id, { schemaName: 'two' }));
	assert.notEqual(auditPath(id, { schemaName: 'one', mysqlConfig: { host: 'a' } }), auditPath(id, { schemaName: 'one', mysqlConfig: { host: 'b' } }));
	assert.equal(auditPath(id, { schemaName: 'one', mysqlConfig: { host: 'a', port: 3306 } }), auditPath(id, { schemaName: 'one', mysqlConfig: { host: 'a', port: '3306' } }));
});

test('generated values and CHECKs are evaluated in parameterized SELECT batches without target writes', async () => {
	const calls = [];
	const evaluate = makeEvaluator({ query: async (sql, params) => {
		calls.push({ sql, params });
		return [[{ __dq_row: 0, doubled: 6, __dq_check_0: 1 }, { __dq_row: 1, doubled: -4, __dq_check_0: 0 }]];
	} }, { name: 'custom', columns: [integer('value'), integer('doubled', { generated: true, expression: '`value` * 2' })], checks: [{ name: 'positive', expression: '`value` > 0' }] });
	const rows = [{ mapped: { value: 3 }, reasons: [] }, { mapped: { value: -2 }, reasons: [] }];
	await evaluate(rows);
	assert.ok(calls[0].sql.startsWith('SELECT'));
	assert.deepEqual(calls[0].params, [3, -2]);
	assert.equal(rows[0].mapped.doubled, 6);
	assert.equal(rows[1].reasons[0].code, 'CHECK_CONSTRAINT');
});

test('target cleaning is blocked if existing children would lose their parent, without excluding additional source rows', async t => {
	const parent = table('parents', [integer('id', { primary: true })], [{ id: 1 }], {
		step: { mode: 'INSERT', keyStrategy: 'preserve', cleanBefore: true },
		existingChildren: [{ child: 'unselected_children', columns: ['parent_id'], parentColumns: ['id'] }]
	});
	const result = await audit(t, [parent], { unselected_children: [{ parent_id: 99 }] });
	assert.equal(result.report.status, 'blocked');
	assert.match(parent.summary.errors[0], /Truncate first would break 1 existing unselected_children/);
	assert.equal(parent.summary.accepted, 1);
});

test('a missing invoice identity with monetary value needs review', async t => {
	const result = await audit(t, [table('invoices', [integer('invoice_nr', { primary: true }), integer('inv_totalinclvat')], [{ invoice_nr: null, inv_totalinclvat: 1500 }])]);
	assert.equal(result.report.totals.review, 1);
	assert.equal(result.report.totals.quarantined, 0);
});

test('defaulting a failed numeric transform does not hide populated corrupt source data', async t => {
	const item = table('custom_numbers', [integer('id', { primary: true }), integer('number')], [{ id: 1, number: 'corrupt' }]);
	item.mapping.NUMBER = { target: 'number', transform: 'toNumber', default: 0 };
	const result = await audit(t, [item]);
	assert.equal(result.report.status, 'blocked');
	assert.ok(result.evidence[0].reasons.some(reason => reason.code === 'LOSSY_TRANSFORM'));
});

test('repeated zero invoice identities and REDO copies are quarantined without blocking valid invoices', async t => {
	const result = await audit(t, [table('invoices', [integer('invoice_nr', { primary: true }), text('status')], [
		{ invoice_nr: 0 }, { invoice_nr: 0 }, { invoice_nr: 1, status: 'REDO' }, { invoice_nr: 1, status: 'VALID' }
	])]);
	assert.equal(result.report.status, 'ready');
	assert.equal(result.report.totals.quarantined, 3);
	assert.equal(result.report.totals.accepted, 1);
});

test('existing invoice identities are retained for retry only when customer and job agree', async t => {
	const make = () => table('invoices', [integer('invoice_nr', { primary: true }), integer('job_number'), integer('cid')], [{ invoice_nr: 100, job_number: 0, cid: 12 }]);
	assert.equal((await audit(t, [make()], { invoices: [{ invoice_nr: 100, job_number: 0, cid: 12 }] })).report.status, 'ready');
	assert.equal((await audit(t, [make()], { invoices: [{ invoice_nr: 100, job_number: 99, cid: 12 }] })).report.status, 'blocked');
});

test('date filtering compares the local Firebird calendar date at midnight', () => {
	assert.equal(inDateScope({ date: new Date(2025, 0, 1, 0, 0, 0) }, { startDate: '2025-01-01', sourceColumn: 'date', linkPlans: [] }), true);
});

test('a retry lookup needs a verified previous ID mapping, not a coincidentally matching target ID', async t => {
	const make = () => table('children', [integer('id', { primary: true }), integer('parent_id')], [{ id: 1, parent_id: 7 }], {
		relations: [{ columns: ['parent_id'], parent: 'parents', parentColumns: ['id'], parentMetadata: [integer('id')], lookup: true }]
	});
	assert.equal((await audit(t, [make()], { parents: [{ id: 7 }] })).report.status, 'blocked');
	assert.equal((await audit(t, [make()], { parents: [{ id: 100 }] }, { parents: [{ id: 7 }] })).report.status, 'ready');
});

test('a declared foreign key blocks a child scheduled ahead of its new parent', async t => {
	const parent = table('parents', [integer('id', { primary: true })], [{ id: 7 }]);
	const child = table('children', [integer('id', { primary: true }), integer('parent_id')], [{ id: 1, parent_id: 7 }], {
		relations: [{ columns: ['parent_id'], parent: 'parents', parentColumns: ['id'], kind: 'foreign key' }]
	});
	const result = await audit(t, [child, parent]);
	assert.equal(result.report.status, 'blocked');
	assert.ok(result.evidence[0].reasons.some(reason => reason.code === 'PARENT_ORDER'));
});

test('an omitted generated primary key is allowed while explicit missing preserved keys are reviewed', async t => {
	const make = omit => {
		const item = table('generated_ids', [integer('id', { primary: true, nullable: false, autoIncrement: true }), text('name')], [{ id: null, name: 'valid' }]);
		item.mapping.ID.omit = omit;
		item.evaluate = makeEvaluator({ query() { throw Error('Unexpected expression query'); } }, item);
		return item;
	};
	assert.equal((await audit(t, [make(true)])).report.status, 'ready');
	assert.equal((await audit(t, [make(false)])).report.status, 'blocked');
});

test('a missing snapshot produces a handled read failure', async () => {
	const reader = await openBatchReader(path.join(__dirname, 'nonexistent-quality-snapshot'));
	try { await assert.rejects(reader.next(1), { code: 'ENOENT' }); }
	finally { await reader.close(); }
});
