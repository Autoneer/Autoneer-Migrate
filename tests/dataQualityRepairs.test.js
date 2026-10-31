const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { prepareAutomaticRepairs } = require('../src/migrate/dataQuality/automaticRepairs');
const { fingerprint, saveCorrection, readCorrections, applyCorrections, ORIGINAL_SOURCE } = require('../src/migrate/dataQuality/corrections');
const { renderReview } = require('../src/migrate/dataQuality/review');
const { groupId } = require('../src/migrate/dataQuality/groups');
const { ROOT, scopeKey, createStore } = require('../src/migrate/dataQuality/store');

function line(name = 'work_done', column = 'wdid') {
	return { name, columns: [{ name: column, primary: true, autoIncrement: true }], step: { mode: 'INSERT', keyStrategy: 'preserve', dedupeKeys: [] }, indexes: [{ name: 'PRIMARY' }], mapping: {} };
}
test('safe line IDs regenerate only for empty, unreferenced destinations and never for business keys or retries', async () => {
	for (const mode of ['safe', 'nonempty', 'referenced', 'lookup', 'retry', 'business']) {
		const table = mode === 'business' ? line('invoices', 'invoice_nr') : line();
		const tables = [table];
		if (mode === 'lookup') tables.push({ ...line('another', 'id'), mapping: { id: { lookup: { table: 'work_done' } } } });
		const metadata = new Map([['any', { relations: mode === 'referenced' ? [{ parent: 'work_done' }] : [] }]]);
		const report = {};
		await prepareAutomaticRepairs(tables, metadata, { query: async sql => { assert.match(sql, /^SELECT 1/); return [mode === 'nonempty' ? [{}] : []]; } }, mode === 'retry' ? 'prior' : null, report);
		assert.equal(table.step.keyStrategy, mode === 'safe' ? 'rekey' : 'preserve', mode);
		assert.equal(report.automaticRepairs.length, mode === 'safe' ? 1 : 0);
	}
});

test('application-managed references protect IDs even without foreign keys', async () => {
	for (const existing of [false, true]) {
		const table = line();
		const child = { ...line('work_timer', 'wtid'), mapping: { WDID: { target: 'wdid' } } };
		const metadata = new Map([['work_timer', { columns: [{ name: 'wdid' }], relations: [] }]]);
		await prepareAutomaticRepairs([table, child], metadata, { query: async () => [existing ? [{}] : []] }, null, {}, async () => !existing);
		assert.equal(table.step.keyStrategy, 'preserve');
	}
});

test('corrections match unchanged original records, retain originals, are tenant scoped and can be undone', async t => {
	const scope = { schemaName: 'correction-test-' + randomUUID() };
	const dir = path.join(ROOT, scopeKey(scope));
	t.after(() => { assert.ok(path.resolve(dir).startsWith(path.resolve(ROOT) + path.sep)); return fs.promises.rm(dir, { recursive: true, force: true }); });
	const source = { id: 1, invoice_nr: null, amount: 25 };
	await saveCorrection(scope, 'invoices', source, 'invoice_nr', '123');
	const all = await readCorrections(scope);
	const fixed = applyCorrections(all, 'invoices', source);
	assert.equal(fixed.invoice_nr, '123');
	assert.equal(fixed[ORIGINAL_SOURCE], source);
	assert.equal(source.invoice_nr, null);
	assert.equal(applyCorrections(all, 'invoices', { ...source, amount: 26 }).invoice_nr, null);
	assert.equal(applyCorrections(all, 'other', source).invoice_nr, null);
	assert.deepEqual(await readCorrections({ schemaName: 'different-' + randomUUID() }), {});
	await saveCorrection(scope, 'invoices', source, 'invoice_nr', '', true);
	assert.deepEqual(await readCorrections(scope), {});
});

test('readable review escapes source data and offers correction fields instead of JSON', async t => {
	const store = await createStore({ schemaName: 'review-test-' + randomUUID() });
	t.after(() => { assert.ok(path.resolve(store.dir).startsWith(path.resolve(ROOT) + path.sep)); return fs.promises.rm(store.dir, { recursive: true, force: true }); });
	const source = { inv_nr: null, note: '<script>bad()</script>' };
	await fs.promises.writeFile(path.join(store.dir, 'quarantine.ndjson'), JSON.stringify({ table: 'invoices', sourceTable: 'INVOICES', ordinal: 0, action: 'review', source, reasons: [{ column: 'invoice_nr', code: 'MISSING_IDENTITY', message: 'Missing number' }] }) + '\n');
	const report = { id: store.id, status: 'blocked', tables: [], mapping: { INVOICES: { columns: { INV_NR: { target: 'invoice_nr' } } } } };
	const html = await renderReview(store.dir, report, {}, { ['invoices:' + fingerprint(source)]: { fields: { inv_nr: '123' } } });
	assert.match(html, /Save correction/);
	assert.match(html, /value="123"/);
	assert.match(html, /Undo saved correction/);
	assert.doesNotMatch(html, /<script>/);
	assert.match(html, /&lt;script&gt;/);
});

test('records already in the destination link to their repair group instead of offering a key correction', async t => {
	const store = await createStore({ schemaName: 'review-conflict-' + randomUUID() });
	t.after(() => { assert.ok(path.resolve(store.dir).startsWith(path.resolve(ROOT) + path.sep)); return fs.promises.rm(store.dir, { recursive: true, force: true }); });
	await fs.promises.writeFile(path.join(store.dir, 'quarantine.ndjson'), JSON.stringify({ table: 'staff', sourceTable: 'STAFF', ordinal: 4, action: 'review', source: { staff_id: 5, name: 'STEF' }, reasons: [{ column: 'staff_id', code: 'TARGET_KEY_CONFLICT', message: 'Key already exists in target' }] }) + '\n');
	const report = { id: store.id, status: 'blocked', tables: [], mapping: { STAFF: { columns: { STAFF_ID: { target: 'staff_id' } } } } };
	const html = await renderReview(store.dir, report, {}, {});
	assert.doesNotMatch(html, /Save correction/);
	assert.ok(html.includes(`groups?group=${groupId('staff', 'TARGET_KEY_CONFLICT', 'staff_id')}`));
	assert.match(html, /Decide in Repair groups/);
});
