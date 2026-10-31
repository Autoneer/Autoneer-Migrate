const test = require('node:test');
const assert = require('node:assert/strict');
const PlanValidator = require('../src/migrate/validators/PlanValidator');

// Rows with an empty INV_NR fail, like legacy invoices that the full check leaves out.
function withValidator(t) {
	const original = PlanValidator.dryRun;
	t.after(() => { PlanValidator.dryRun = original; });
	PlanValidator.dryRun = async row => row.inv_nr == null
		? { migratable: false, issues: ['Target primary key column INVOICE_NR would receive NULL. Check the mapping from INV_NR.'], warnings: [] }
		: { migratable: true, issues: [], warnings: [] };
}

test('a bad first record with passing later samples is a warning, not a mapping error', async t => {
	withValidator(t);
	const { result, sampleRow } = await PlanValidator.dryRunSamples([{ inv_nr: null }, { inv_nr: null }, { inv_nr: 'INV1' }]);
	assert.equal(result.migratable, true);
	assert.deepEqual(result.issues, []);
	assert.equal(sampleRow.inv_nr, 'INV1');
	assert.match(result.warnings[0], /first sample row: Target primary key column INVOICE_NR would receive NULL\), but later sample rows pass/);
});

test('when every sample fails the mapping error is reported', async t => {
	withValidator(t);
	const { result } = await PlanValidator.dryRunSamples([{ inv_nr: null }, { inv_nr: null }]);
	assert.equal(result.migratable, false);
	assert.match(result.issues[0], /INVOICE_NR would receive NULL/);
});

test('a passing first sample is used as before', async t => {
	withValidator(t);
	const { result, sampleRow } = await PlanValidator.dryRunSamples([{ inv_nr: 'A' }, { inv_nr: null }]);
	assert.equal(result.migratable, true);
	assert.deepEqual(result.warnings, []);
	assert.equal(sampleRow.inv_nr, 'A');
});
