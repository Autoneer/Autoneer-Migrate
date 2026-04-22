const assert = require("assert");

const Plan = require("../src/migrate/models/Plan");
const {
	buildTransactionalDateFilter,
	normalizeTransactionalDateFilterConfig,
	isTransactionalTable
} = require("../src/migrate/transactionalDateFilter");

function run() {
	const plan = new Plan("mapping-1", "Profile");
	plan.name = "Filtered transactional import";
	plan.config = {
		batchSize: 1000,
		continueOnError: true,
		validateData: true,
		transactionalDateFilter: {
			enabled: true,
			startDate: "2026-01-01"
		}
	};

	const serialized = plan.toJSON();
	const restored = Plan.fromJSON(serialized);
	assert.strictEqual(restored.name, plan.name);
	assert.deepStrictEqual(restored.config, plan.config);

	assert.strictEqual(isTransactionalTable("customers"), false);
	assert.strictEqual(isTransactionalTable("payments"), true);

	const invoicesFilter = buildTransactionalDateFilter(
		"invoices",
		{
			INV_NR: { target: "invoice_nr" },
			INVOICE_DATE: { target: "invoice_date" }
		},
		plan.config
	);
	assert.deepStrictEqual(invoicesFilter, {
		enabled: true,
		startDate: "2026-01-01",
		sourceColumn: "INVOICE_DATE",
		clause: '"INVOICE_DATE" >= ?',
		params: ["2026-01-01"]
	});

	const customersFilter = buildTransactionalDateFilter(
		"customers",
		{
			CID: { target: "cid" }
		},
		plan.config
	);
	assert.strictEqual(customersFilter, null);

	const invalidFilter = normalizeTransactionalDateFilterConfig({
		transactionalDateFilter: { enabled: true, startDate: "not-a-date" }
	});
	assert.deepStrictEqual(invalidFilter, {
		enabled: true,
		startDate: null
	});
}

run();
console.log("transactionalDateFilter.test.js passed");