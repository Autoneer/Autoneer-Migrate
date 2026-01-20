const assert = require("assert");
const { buildCleanTableSelection, validateCleanConfirm } = require("../src/migrate/validation");

(function testBuildCleanTableSelection() {
	const included = ["customers", "suppliers", "stock"];
	const selected = buildCleanTableSelection({
		includedTables: included,
		cleanAll: false,
		requestedTables: ["customers", "unknown"]
	});
	assert.strictEqual(selected.has("customers"), true);
	assert.strictEqual(selected.has("unknown"), false);
})();

(function testBuildCleanTableSelectionAll() {
	const included = ["customers", "suppliers"];
	const selected = buildCleanTableSelection({
		includedTables: included,
		cleanAll: true,
		requestedTables: []
	});
	assert.strictEqual(selected.size, 2);
})();

(function testValidateCleanConfirm() {
	assert.strictEqual(validateCleanConfirm("DELETE", 1), null);
	assert.ok(validateCleanConfirm("", 1));
	assert.strictEqual(validateCleanConfirm("", 0), null);
})();

console.log("Validation tests passed.");
