const assert = require("assert");
const { applyMigrationMarker } = require("../src/migrate/migrationMarkers");

assert.strictEqual(
	applyMigrationMarker("job_information", "jnotes", "Existing job note"),
	"THIS IS A MIGRATED JOB\nExisting job note"
);
assert.strictEqual(
	applyMigrationMarker("invoices", "comments", "Existing invoice comment"),
	"MIGRATED INVOICE\nExisting invoice comment"
);
assert.strictEqual(
	applyMigrationMarker("job_information", "jnotes", null),
	"THIS IS A MIGRATED JOB"
);
assert.strictEqual(
	applyMigrationMarker("other_table", "comments", "Unchanged"),
	"Unchanged"
);
assert.strictEqual(
	applyMigrationMarker("invoices", "comments", "MIGRATED INVOICE\nAlready marked"),
	"MIGRATED INVOICE\nAlready marked"
);
assert.strictEqual(
	applyMigrationMarker("job_information", "jnotes", "x".repeat(500)).length,
	400
);

console.log("migrationMarkers tests passed");
