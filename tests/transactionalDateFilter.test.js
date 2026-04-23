const assert = require("assert");

const Plan = require("../src/migrate/models/Plan");
const {
	buildTransactionalTableFilter,
	createEmptyKeySets,
	FIREBIRD_IN_MEMBER_LIST_LIMIT,
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
	assert.strictEqual(isTransactionalTable("work_done"), true);

	const keySets = createEmptyKeySets();
	keySets.customerJob.add("123");
	keySets.customerInvoice.add("9001");

	const invoicesFilter = buildTransactionalTableFilter(
		"invoices",
		{
			INV_NR: { target: "invoice_nr" },
			JOB_NUMBER: { target: "job_number" },
			INVOICE_DATE: { target: "invoice_date" }
		},
		plan.config,
		{
			context: {
				tableConfigsByName: new Map(),
				keySets
			}
		}
	);
	assert.strictEqual(invoicesFilter.sourceColumn, "INVOICE_DATE");
	assert.strictEqual(invoicesFilter.hasDateClause, true);
	assert.strictEqual(invoicesFilter.hasLinkClause, true);
	assert.strictEqual(invoicesFilter.hasPredicate, true);
	assert.strictEqual(invoicesFilter.clause, null);
	assert.deepStrictEqual(invoicesFilter.params, []);
	assert.strictEqual(invoicesFilter.datePlan.clause, '"INVOICE_DATE" >= ?');
	assert.deepStrictEqual(invoicesFilter.datePlan.params, ["2026-01-01"]);
	assert.ok(invoicesFilter.linkPlans.some((plan) => plan.clause === '"JOB_NUMBER" IN (?)'));
	assert.ok(invoicesFilter.linkPlans.some((plan) => plan.clause === '"INV_NR" IN (?)'));

	const workDoneFilter = buildTransactionalTableFilter(
		"work_done",
		{
			JOB_NUMBER: { target: "job_number" }
		},
		plan.config,
		{
			availableSourceColumns: ["WORKDATE", "JOB_NUMBER", "INVOICE_NR"],
			context: {
				tableConfigsByName: new Map(),
				keySets
			}
		}
	);
	assert.strictEqual(workDoneFilter.hasDateClause, true);
	assert.strictEqual(workDoneFilter.hasLinkClause, true);
	assert.strictEqual(workDoneFilter.datePlan.clause, '"WORKDATE" >= ?');
	assert.ok(workDoneFilter.linkPlans.some((plan) => plan.clause === '"JOB_NUMBER" IN (?)'));

	const largeKeySets = createEmptyKeySets();
	for (let index = 0; index < FIREBIRD_IN_MEMBER_LIST_LIMIT + 5; index += 1) {
		largeKeySets.customerJob.add(String(index + 1));
	}
	const largeFilter = buildTransactionalTableFilter(
		"work_done",
		{
			JOB_NUMBER: { target: "job_number" }
		},
		plan.config,
		{
			availableSourceColumns: ["WORKDATE", "JOB_NUMBER"],
			context: {
				tableConfigsByName: new Map(),
				keySets: largeKeySets
			}
		}
	);
	assert.strictEqual(largeFilter.clause, null);
	assert.strictEqual(largeFilter.linkPlans.length, 2);
	assert.strictEqual(largeFilter.linkPlans[0].params.length, FIREBIRD_IN_MEMBER_LIST_LIMIT);
	assert.strictEqual(largeFilter.linkPlans[1].params.length, 5);

	const customersFilter = buildTransactionalTableFilter(
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