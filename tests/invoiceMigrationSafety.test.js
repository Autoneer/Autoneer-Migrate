const test = require("node:test");
const assert = require("node:assert/strict");

const {
	buildInvoiceSourcePolicy,
	buildSourceInvoiceIdentityMap,
	combineSourceWhere,
	filterValidInvoiceKeys,
	getMappingDefault,
	hasMappingDefault,
	reconcileInvoiceIdentities,
	resolveOnDuplicatePolicy
} = require("../src/migrate/invoiceMigrationSafety");
const { buildPlan } = require("../src/migrate/migrationPlan");
const Plan = require("../src/migrate/models/Plan");

const invoiceColumns = {
	INV_NR: { targetColumn: "INVOICE_NR", defaultValue: "" },
	JOB_CARD_NR: { target: "job_number" },
	CID: { target: "cid" }
};

test("invoice source policy excludes null, zero, and negative legacy invoice numbers", () => {
	const policy = buildInvoiceSourcePolicy("invoices", invoiceColumns);
	assert.equal(policy.sourceColumn, "INV_NR");
	assert.equal(policy.clause, '"INV_NR" IS NOT NULL AND "INV_NR" > 0');
	assert.deepEqual(filterValidInvoiceKeys([null, "", 0, -1, 1, "2"]), [1, "2"]);

	const combined = combineSourceWhere('"INVOICE_DATE" >= ?', ["2024-01-01"], policy);
	assert.equal(
		combined.clause,
		'("INVOICE_DATE" >= ?) AND ("INV_NR" IS NOT NULL AND "INV_NR" > 0)'
	);
	assert.deepEqual(combined.params, ["2024-01-01"]);
});

test("invoice number collisions are always errors", () => {
	assert.equal(resolveOnDuplicatePolicy("invoices", "SKIP"), "ERROR");
	assert.equal(resolveOnDuplicatePolicy("INVOICES", undefined), "ERROR");
	assert.equal(resolveOnDuplicatePolicy("customers", "SKIP"), "SKIP");
});

test("new migration plans preserve invoice IDs and reject collisions", () => {
	const generated = buildPlan({
		firebirdTables: ["INVOICES"],
		mysqlTables: ["invoices"],
		mapping: {}
	}).find((step) => step.table === "invoices");
	assert.deepEqual(
		{
			mode: generated.mode,
			keyStrategy: generated.keyStrategy,
			onDuplicate: generated.onDuplicate
		},
		{ mode: "INSERT", keyStrategy: "preserve", onDuplicate: "ERROR" }
	);

	const plan = new Plan("mapping", "Legacy");
	plan.addTable("invoices", {
		mode: "UPSERT",
		keyStrategy: "rekey",
		onDuplicate: "SKIP"
	});
	assert.deepEqual(
		{
			mode: plan.tables.INVOICES.mode,
			keyStrategy: plan.tables.INVOICES.keyStrategy,
			onDuplicate: plan.tables.INVOICES.onDuplicate
		},
		{ mode: "INSERT", keyStrategy: "preserve", onDuplicate: "ERROR" }
	);
});

test("mapping defaults support both saved-profile and runtime property names", () => {
	assert.equal(hasMappingDefault({ defaultValue: "" }), true);
	assert.equal(getMappingDefault({ defaultValue: "" }), "");
	assert.equal(getMappingDefault({ defaultValue: "profile", default: "runtime" }), "runtime");
	assert.equal(hasMappingDefault({}), false);
});

test("invoice identity reconciliation catches missing and mis-owned target headers", () => {
	const source = buildSourceInvoiceIdentityMap([
		{ inv_nr: 4664, job_card_nr: 5001, cid: 2276 },
		{ inv_nr: 5249, job_card_nr: 5551, cid: 101 }
	], invoiceColumns);

	assert.deepEqual(
		reconcileInvoiceIdentities(source, [
			{ invoice_nr: 4664, job_number: 3229, cid: 2276 }
		]),
		[
			"invoice 4664 belongs to source job 5001 but target job 3229",
			"invoice 5249 is missing from the target"
		]
	);

	assert.deepEqual(
		reconcileInvoiceIdentities(source, [
			{ invoice_nr: 4664, job_number: 5001, cid: 2276 },
			{ invoice_nr: 5249, job_number: 5551, cid: 101 }
		]),
		[]
	);
});

test("duplicate source invoice numbers fail before target cleanup", () => {
	assert.throws(
		() => buildSourceInvoiceIdentityMap([
			{ inv_nr: 4664, job_card_nr: 5001, cid: 2276 },
			{ inv_nr: 4664, job_card_nr: 3229, cid: 2276 }
		], invoiceColumns),
		/source invoice number 4664 occurs more than once/
	);
});
