const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createStore, ROOT, scopeKey } = require('../src/migrate/dataQuality/store');
const { latestReport, inputFingerprint, matchesLegacyReport } = require('../src/migrate/dataQuality/history');
const { loadGroups, renderGroups } = require('../src/migrate/dataQuality/groups');
const { saveDecision, readDecisions, decisionKeys } = require('../src/migrate/dataQuality/decisions');
const { saveCorrections, readCorrections, applyCorrections, fingerprint } = require('../src/migrate/dataQuality/corrections');
const { prepareLineIdRepairs } = require('../src/migrate/dataQuality/lineIdRepairs');

async function fixture(t) {
	const scope = { schemaName: 'decisions-test-' + randomUUID() };
	const dir = path.join(ROOT, scopeKey(scope));
	t.after(() => { assert.ok(path.resolve(dir).startsWith(path.resolve(ROOT) + path.sep)); return fs.rm(dir, { recursive: true, force: true }); });
	return { scope, store: await createStore(scope) };
}

test('latest results survive new requests, stay plan and tenant scoped, and ignore incomplete scans', async t => {
	const { scope, store } = await fixture(t);
	await store.save({ id: store.id, planId: 9, status: 'blocked', createdAt: '2026-10-31T08:00:00Z' });
	const next = await createStore(scope);
	await next.save({ id: next.id, planId: 9, status: 'running', createdAt: '2026-10-31T09:00:00Z' });
	assert.equal((await latestReport(scope, 9)).id, store.id);
	assert.equal(await latestReport(scope, 10), null);
	assert.equal(await latestReport({ schemaName: scope.schemaName + '-other' }, 9), null);
	const plan = { tables: { STAFF: { cleanBefore: false }, STOCK: {} }, tableOrder: ['STAFF', 'STOCK'] };
	const original = inputFingerprint(plan, {}, { database: 'one.fdb' }, {});
	assert.equal(original, inputFingerprint({ ...plan, tables: { STOCK: {}, STAFF: { cleanBefore: false } } }, {}, { database: 'one.fdb' }, {}));
	assert.notEqual(original, inputFingerprint({ ...plan, tableOrder: ['STOCK', 'STAFF'] }, {}, { database: 'one.fdb' }, {}));
	assert.notEqual(original, inputFingerprint(plan, {}, { database: 'two.fdb' }, {}));
	assert.notEqual(original, inputFingerprint(plan, {}, { database: 'one.fdb' }, { decision: true }));
});

test('legacy report recovery requires identical selection, config, mapping and source', () => {
	const context = { plan: { tables: [{ table: 'STAFF' }], config: {} }, mapping: { tables: { STAFF: { targetTable: 'STAFF', columns: { ID: { target: 'id' } } } } }, source: { host: 'local', database: 'old.fdb' } };
	const report = { source: context.source, plan: { tables: require('../src/migrate/planNormalize').normalizePlanSteps(context.plan, context.mapping), config: {} }, mapping: { STAFF: { target: 'staff', columns: context.mapping.tables.STAFF.columns } } };
	assert.equal(matchesLegacyReport(report, context), true);
	assert.equal(matchesLegacyReport({ ...report, source: { ...context.source, database: 'other.fdb' } }, context), false);
	assert.equal(matchesLegacyReport({ ...report, planId: 2 }, context), false);
});

test('REDO history groups include linked credit notes and shared corrections preview exact affected counts', async t => {
	const { store } = await fixture(t);
	const rows = [
		{ table: 'invoices', ordinal: 0, action: 'quarantine', source: { nr: 12291 }, mapped: { invoice_nr: 12291 }, reasons: [{ code: 'REDO_INVOICE', column: 'status', message: 'Legacy REDO invoice' }] },
		{ table: 'credit_notes', ordinal: 0, action: 'review', source: { inv_nr: 12291 }, mapped: { invoice_nr: 12291 }, reasons: [{ code: 'MISSING_PARENT', column: 'invoice_nr', message: 'No accepted invoices parent (invoice_nr); its source record was rejected' }] },
		...[1, 2].map(ordinal => ({ table: 'jobs', sourceTable: 'JOBS', ordinal, action: 'review', source: { id: ordinal, status: '<invalid>' }, reasons: [{ code: 'INVALID_VALUE', column: 'status', message: 'Bad status' }] }))
	];
	await fs.writeFile(path.join(store.dir, 'quarantine.ndjson'), rows.map(row => JSON.stringify(row)).join('\n'));
	const report = { id: store.id, mapping: { JOBS: { columns: { STATUS: { target: 'status' } } } } };
	const data = await loadGroups(store.dir, report);
	const redo = data.groups.find(group => group.code === 'REDO_INVOICE');
	assert.equal(redo.roots.size, 1); assert.equal(redo.affected.size, 2);
	assert.equal(data.groups.some(group => group.table === 'credit_notes'), false);
	const shared = data.groups.find(group => group.code === 'INVALID_VALUE');
	assert.equal(shared.roots.size, 2); assert.equal(shared.field, 'status');
	const html = renderGroups(report, data, shared.id, { action: 'correct', value: '<correct>' });
	assert.match(html, /2 matching source records/);
	assert.match(html, /&lt;correct&gt;/);
	assert.doesNotMatch(html, /<correct>|<invalid>/);
	assert.match(html, /Save this decision/);
	// The group page saves options directly; there is no separate preview click.
	const page = renderGroups(report, data, shared.id, null);
	assert.ok(page.includes(`/groups/apply"><input type="hidden" name="group" value="${shared.id}"><input type="hidden" name="action" value="exclude">`));
	assert.ok(!page.includes('/groups/preview'));
});

test('group corrections and exclusions are fingerprint-bound, tenant scoped, atomic and reversible', async t => {
	const { scope } = await fixture(t);
	const rows = [{ table: 'jobs', source: { id: 1, value: 'bad' } }, { table: 'jobs', source: { id: 2, value: 'bad' } }];
	await saveCorrections(scope, rows.map(row => ({ ...row, field: 'value', value: 'fixed' })));
	const corrections = await readCorrections(scope);
	assert.equal(Object.keys(corrections).length, 2);
	assert.equal(applyCorrections(corrections, 'jobs', rows[0].source).value, 'fixed');
	assert.equal(applyCorrections(corrections, 'jobs', { ...rows[0].source, value: 'changed' }).value, 'changed');
	await saveDecision(scope, 'group', rows, 'Leave group out');
	const excluded = decisionKeys(await readDecisions(scope));
	assert.equal(excluded.has('jobs:' + fingerprint(rows[0].source)), true);
	assert.equal(excluded.has('jobs:' + fingerprint({ ...rows[0].source, value: 'changed' })), false);
	assert.deepEqual(await readDecisions({ schemaName: scope.schemaName + '-other' }), {});
	await saveDecision(scope, 'group', [], '', true);
	assert.deepEqual(await readDecisions(scope), {});
});

test('selective ID repair never wraps append destinations or unknown reference shapes', async () => {
	for (const mode of ['nonempty', 'unknown-relation', 'transform-reference', 'safe']) {
		const rows = async function* () {};
		const table = { name: 'work_done', columns: [{ name: 'wdid', primary: true, autoIncrement: true }], mapping: { WDID: { target: 'wdid' } }, rows, step: { mode: 'INSERT', keyStrategy: 'preserve' } };
		const child = { name: 'timer', mapping: { LINE: { target: 'line' } } };
		const metadata = new Map([['timer', { columns: [{ name: 'line' }], relations: [{ parent: 'work_done', columns: ['line'], parentColumns: mode === 'unknown-relation' ? ['other'] : ['wdid'] }] }]]);
		await prepareLineIdRepairs([table, child], metadata, { query: async sql => [mode === 'nonempty' && sql.startsWith('SELECT 1') ? [{}] : []] }, {}, { automaticRepairs: [] }, async () => mode === 'transform-reference' ? null : [], () => {});
		assert.equal(table.rows === rows, mode !== 'safe', mode);
	}
});

test('saved group exclusions are undone from their row and other saved decisions stay reachable', () => {
	const report = { id: 'audit-1', tables: [] };
	const row = { table: 'staff', ordinal: 0, action: 'review', source: { id: 1 }, reasons: [{ code: 'TARGET_KEY_CONFLICT', column: 'id', message: 'Already exists' }] };
	const group = { id: 'g1', table: 'staff', code: 'TARGET_KEY_CONFLICT', column: 'id', field: null, title: 'Existing destination records', message: 'Already exists', roots: new Set(['staff:0']), affected: new Set(['staff:0']), rows: [row], impactedTables: ['staff'] };
	const decisions = { 'audit-1:g1': { description: 'staff: excluded', records: ['x'] }, 'older-audit:g9': { description: 'stock: older decision', records: ['y'] } };
	const html = renderGroups(report, { groups: [group] }, null, null, decisions);
	assert.ok(html.includes('name="decision" value="audit-1:g1"><input type="hidden" name="from" value="list"><button class="secondary small-btn">Undo</button>'));
	assert.ok(!html.includes('Saved exclusion decisions'));
	assert.match(html, /Other saved decisions/);
	assert.match(html, /stock: older decision/);
	assert.doesNotMatch(html, /staff: excluded · /);
});
