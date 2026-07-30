const test = require("node:test");
const assert = require("node:assert/strict");

const { validateColumnNullability } = require("../src/migrate/runner");

function poolReturning(columns) {
	return {
		query: async () => [columns]
	};
}

test("unmapped auto-increment primary keys satisfy NOT NULL validation", async () => {
	const result = await validateColumnNullability(
		poolReturning([{
			COLUMN_NAME: "wdid",
			IS_NULLABLE: "NO",
			COLUMN_DEFAULT: null,
			DATA_TYPE: "int",
			COLUMN_TYPE: "int",
			EXTRA: "auto_increment"
		}]),
		"work_done",
		{}
	);

	assert.deepEqual(result, { safe: true, violations: [] });
});

test("unmapped non-generated NOT NULL columns still fail validation", async () => {
	const result = await validateColumnNullability(
		poolReturning([{
			COLUMN_NAME: "status",
			IS_NULLABLE: "NO",
			COLUMN_DEFAULT: null,
			DATA_TYPE: "varchar",
			COLUMN_TYPE: "varchar(100)",
			EXTRA: ""
		}]),
		"job_information",
		{}
	);

	assert.equal(result.safe, false);
	assert.equal(result.violations[0].column, "status");
});
