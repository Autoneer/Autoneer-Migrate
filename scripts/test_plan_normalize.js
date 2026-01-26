const assert = require('assert');

function normalizeTableEntry(t) {
	if (typeof t === 'string') return t.toUpperCase();
	if (t && typeof t === 'object') {
		if (t.value) return String(t.value).toUpperCase();
		if (t.targetTable) return String(t.targetTable).toUpperCase();
		if (t.table) return String(t.table).toUpperCase();
		return JSON.stringify(t).toUpperCase();
	}
	return String(t || '').toUpperCase();
}

(function testNormalizeMixedEntries() {
	const input = [
		'work_done',
		{ value: 'invoices' },
		{ targetTable: 'spares_used' },
		{ table: 'jobs' },
		{ some: 'object' }
	];

	const normalized = input.map(normalizeTableEntry);

	assert.strictEqual(normalized[0], 'WORK_DONE');
	assert.strictEqual(normalized[1], 'INVOICES');
	assert.strictEqual(normalized[2], 'SPARES_USED');
	assert.strictEqual(normalized[3], 'JOBS');
	assert.ok(normalized[4].includes('SOME'));

	console.log('Plan normalization test passed');
})();
