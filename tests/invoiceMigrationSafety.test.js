const test = require("node:test");
const assert = require("node:assert/strict");

const {
	applyInvoiceSplitPolicy,
	buildInvoiceSplitPolicy,
	buildInvoiceSourcePolicy,
	buildSourceInvoiceSelection,
	buildSourceInvoiceIdentityMap,
	combineSourceWhere,
	filterValidInvoiceKeys,
	getMappingDefault,
	hasMappingDefault,
	reconcileInvoiceIdentities,
	resolveMappingDefault,
	resolveOnDuplicatePolicy
} = require("../src/migrate/invoiceMigrationSafety");
const { buildPlan } = require("../src/migrate/migrationPlan");
const Plan = require("../src/migrate/models/Plan");

const invoiceColumns = {
	INV_NR: { targetColumn: "INVOICE_NR", defaultValue: "" },
	JOB_CARD_NR: { target: "job_number" },
	CID: { target: "cid" }
};

test('legacy split invoice numbers also populate the modern split flag without changing invoice identity or historical status', () => {
	const policy = buildInvoiceSplitPolicy('INVOICES', { SPLITNR: { targetColumn: 'SPLITNR' } }, ['is_split_invoice']);
	for (const [splitnr, expected] of [[1, 1], [2, 1], ['2', 1], [null, 0], [0, 0], [-1, 0], ['bad', 0]]) {
		const mapped = { invoice_nr: 4903, job_number: 5617, SPLITNR: splitnr, is_historical_import: 0 };
		applyInvoiceSplitPolicy({ splitnr }, mapped, policy);
		assert.deepEqual(mapped, { invoice_nr: 4903, job_number: 5617, SPLITNR: splitnr, is_historical_import: 0, is_split_invoice: expected });
	}
	assert.equal(buildInvoiceSplitPolicy('invoices', { SPLITNR: { target: 'splitnr', omit: true } }, ['is_split_invoice']), null);
	assert.equal(buildInvoiceSplitPolicy('invoices', { SPLITNR: { target: 'splitnr' } }, []), null);
	assert.equal(buildInvoiceSplitPolicy('invoices', { SPLITNR: { target: 'splitnr' }, FLAG: { target: 'IS_SPLIT_INVOICE' } }, ['is_split_invoice']), null);
	assert.equal(buildInvoiceSplitPolicy('stock', { SPLITNR: { target: 'splitnr' } }, ['is_split_invoice']), null);
});

test("a blank default keeps uninvoiced line invoice numbers NULL instead of 0", () => {
	const blank = { targetColumn: "INVOICE_NR", defaultValue: "" };
	for (const table of ["SPARES_USED", "work_done"]) {
		assert.equal(resolveMappingDefault(blank, { targetTable: table, dataType: "int" }), null);
		assert.equal(resolveMappingDefault(blank, { targetTable: table, dataType: "INT" }), null);
		assert.equal(resolveMappingDefault({ ...blank, defaultValue: "0" }, { targetTable: table, dataType: "int" }), "0");
	}
	// Columns not yet approved, non-numeric targets, and unknown types keep the blank default.
	assert.equal(resolveMappingDefault(blank, { targetTable: "job_information", dataType: "int" }), "");
	assert.equal(resolveMappingDefault({ target: "job_number", default: "" }, { targetTable: "spares_used", dataType: "int" }), "");
	assert.equal(resolveMappingDefault(blank, { targetTable: "spares_used", dataType: "varchar" }), "");
	assert.equal(resolveMappingDefault(blank, { targetTable: "spares_used" }), "");
});

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

test("target invoice constraint collisions remain errors", () => {
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

test("duplicate source invoice numbers keep the first nonzero job in either order", () => {
	const zero = { inv_nr: 15888, job_card_nr: ' 0 ', cid: 1 };
	const real = { INV_NR: '15888', JOB_CARD_NR: 5001, CID: 2276 };
	const other = { inv_nr: 15888, job_card_nr: 3229, cid: 99 };
	for (const rows of [[zero, real, other], [real, zero, other], [real, other, zero]]) {
		const selection = buildSourceInvoiceSelection(rows, invoiceColumns);
		assert.equal(selection.identities.size, 1);
		assert.deepEqual(selection.identities.get('15888'), { invoiceNr: '15888', jobNumber: '5001', cid: '2276' });
		assert.deepEqual([...selection.selectedOffsets], [rows.indexOf(real)]);
		assert.deepEqual(reconcileInvoiceIdentities(selection.identities, [
			{ invoice_nr: 15888, job_number: 5001, cid: 2276 }
		]), []);
	}
});

test("unique job-zero invoices and one of repeated job-zero invoices are retained", () => {
	const selection = buildSourceInvoiceSelection([
		{ inv_nr: 1, job_card_nr: 0 },
		{ inv_nr: 2, job_card_nr: 0 },
		{ inv_nr: 2, job_card_nr: '0' }
	], invoiceColumns);
	assert.deepEqual([...selection.identities.keys()], ['1', '2']);
	assert.deepEqual([...selection.selectedOffsets], [0, 1]);
});

test("duplicates without a job mapping keep one and invalid invoice numbers still fail", () => {
	const columns = { INV_NR: { target: 'invoice_nr' }, JOB_CARD_NR: { target: 'job_number', omit: true } };
	const selection = buildSourceInvoiceSelection([
		{ inv_nr: 1, job_card_nr: 0 }, { inv_nr: 1, job_card_nr: 5 }
	], columns);
	assert.deepEqual([...selection.selectedOffsets], [0]);
	assert.equal(selection.identities.get('1').jobNumber, undefined);
	assert.throws(() => buildSourceInvoiceIdentityMap([{ inv_nr: 0 }], invoiceColumns), /invalid source invoice number/);
});
