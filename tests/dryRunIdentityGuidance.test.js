const test = require('node:test');
const assert = require('node:assert/strict');
const PlanValidator = require('../src/migrate/validators/PlanValidator');

const mapping = { getFieldMaps: () => new Map([['INVOICENR', { targetColumn: 'INVOICE_NR' }]]) };
const schema = { getColumn: () => ({ nullable: false, isPrimaryKey: true, defaultValue: null }) };

test('a missing sample invoice number stays an error and directs the user to the full audit', async () => {
	const result = await PlanValidator.dryRun({ INVOICENR: null }, mapping, 'INVOICES', 'INVOICES', schema);
	assert.equal(result.migratable, false);
	assert.equal(result.issues.length, 1);
	assert.match(result.issues[0], /mapping from INVOICENR/);
	assert.match(result.issues[0], /Check All Selected Tables/);
	assert.match(result.issues[0], /one sample row/);
	assert.doesNotMatch(result.issues[0], /Provide a mapping default or mark as omitted/);
});

test('a populated sample invoice number still passes the sample check', async () => {
	const result = await PlanValidator.dryRun({ INVOICENR: 1234 }, mapping, 'INVOICES', 'INVOICES', schema);
	assert.equal(result.migratable, true);
	assert.deepEqual(result.issues, []);
});
