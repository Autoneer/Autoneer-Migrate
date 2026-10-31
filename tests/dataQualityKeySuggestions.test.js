const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ROOT, createStore, writeRecord } = require('../src/migrate/dataQuality/store');
const { keySuggestion, keyProblem } = require('../src/migrate/dataQuality/keySuggestions');

async function fixture(t) {
	const store = await createStore({ schemaName: 'key-suggestions-' + randomUUID() });
	t.after(() => { assert.ok(path.resolve(store.dir).startsWith(path.resolve(ROOT) + path.sep)); return fs.promises.rm(store.dir, { recursive: true, force: true }); });
	const report = { id: store.id, tables: [{ table: 'staff' }, { table: 'customers' }] };
	const accepted = await fs.promises.open(path.join(store.dir, '1.accepted'), 'wx');
	for (const cid of [1, 2, 40]) await writeRecord(accepted, { cid, name: 'C' + cid });
	await accepted.close();
	await fs.promises.writeFile(path.join(store.dir, 'quarantine.ndjson'), [
		{ table: 'customers', ordinal: 3, action: 'review', mapped: { cid: 0 }, source: { cid: 0 }, reasons: [{ code: 'INVALID_PRIMARY_KEY', column: 'cid' }] },
		{ table: 'customers', ordinal: 4, action: 'quarantine', mapped: { cid: 55 }, source: { cid: 55 }, reasons: [] }
	].map(row => JSON.stringify(row)).join('\n') + '\n');
	return { dir: store.dir, report };
}
const destination = (max, existing = []) => ({ query: async (sql, params) => sql.startsWith('SELECT MAX') ? [[{ max }]] : [[existing.includes(params[0]) ? { found: 1 } : undefined]] });

test('the suggested ID is above every ID in the scan and the destination', async t => {
	const { dir, report } = await fixture(t);
	assert.equal((await keySuggestion({ dir, report, table: 'customers', column: 'cid' })).next, 56);
	assert.equal((await keySuggestion({ dir, report, table: 'customers', column: 'cid', pool: destination(90) })).next, 91);
});

test('IDs already used by the scan, the destination or another correction are refused', async t => {
	const { dir, report } = await fixture(t);
	const problem = (value, extra = {}) => keyProblem({ dir, report, table: 'customers', column: 'cid', value, ...extra });
	assert.match(await problem('1'), /already used by another customers record/);
	assert.match(await problem('0'), /whole number above 0/);
	assert.match(await problem('abc'), /whole number above 0/);
	assert.match(await problem('60', { otherCorrections: ['60'] }), /another saved correction/);
	assert.match(await problem('70', { pool: destination(90, [70]) }), /already exists in the destination/);
	assert.equal(await problem('56', { pool: destination(55) }), null);
});

test('the group page pre-fills each invalid ID with its own free value', () => {
	const { renderGroups } = require('../src/migrate/dataQuality/groups');
	const row = ordinal => ({ table: 'customers', sourceTable: 'CUSTOMER', ordinal, action: 'review', source: { CID: 0, NAME: 'C' + ordinal }, reasons: [{ code: 'INVALID_PRIMARY_KEY', column: 'cid', message: 'Must be positive' }] });
	const rows = [row(1), row(2)];
	const group = { id: 'g1', table: 'customers', code: 'INVALID_PRIMARY_KEY', column: 'cid', field: null, title: 'Invalid internal IDs', message: 'Must be positive', roots: new Set(['customers:1', 'customers:2']), affected: new Set(['customers:1', 'customers:2']), rows, impactedTables: ['customers'] };
	// Mappings may name the destination column with targetColumn (upper case) instead of target.
	const report = { id: 'audit-1', tables: [], mapping: { CUSTOMER: { columns: { CID: { targetColumn: 'CID' } } } } };
	const html = renderGroups(report, { groups: [group] }, 'g1', null, {}, { suggestion: { column: 'cid', next: 21292, scanMax: 21291, destinationMax: 0, used: new Set([21293]) } });
	const values = [...html.matchAll(/name="value" required[^>]*value="(\d+)"/g)].map(match => match[1]);
	assert.deepEqual(values, ['21292', '21294']);
	assert.match(html, /Suggested <code>21292<\/code>/);
});
