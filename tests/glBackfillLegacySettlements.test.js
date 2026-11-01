const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

// Legacy imports keep non-cash settlements (INTERNAL, WARRANTY, SERVICE PLAN,
// ROUNDING, REFUND) as customer payment rows, and legacy credited Accounts
// Receivable for each. A dry run builds every journal; validateLines is where
// this test reads them. Only the database, logger, posting engine and balances
// are stubbed.

const MIRROR = path.join(__dirname, "../src/migrate/gl/glBackfill/mirror");
const stub = (relative, exports) => {
	const file = require.resolve(path.join(MIRROR, relative));
	require.cache[file] = { id: file, filename: file, loaded: true, exports };
};

const ACTIVE_ROW_ACCOUNTS = new Set([3004, 3500]);
const PAYMENTS = [
	{ payid: 11473, paydate: "2022-09-21", paymethod: "INTERNAL", amount: "7547.97", vat: "0.00", cid: 10121, invoice_nr: "18106", job_number: 16422, acc: 3004 },
	{ payid: 3181, paydate: "2017-08-21", paymethod: "INTERNAL", amount: "1389.87", vat: "4590.13", cid: 2210, invoice_nr: "11458", job_number: 9644, acc: 3993002 },
	{ payid: 4649, paydate: "2018-11-06", paymethod: "WARRANTY", amount: "2983.41", vat: "389.14", cid: 1760, invoice_nr: "13164", job_number: 11346, acc: 3500 },
	{ payid: 9001, paydate: "2022-01-10", paymethod: "Service Plan", amount: "500.00", vat: "0.00", cid: 7, invoice_nr: "9001", job_number: 1, acc: 3500 },
	{ payid: 5067, paydate: "2019-06-25", paymethod: " rounding ", amount: "0.11", vat: "0.00", cid: 5547, invoice_nr: "13991", job_number: 12171, acc: 7507700 },
	{ payid: 52010, paydate: "2026-09-25", paymethod: "REFUND", amount: "-5997.44", vat: "0.00", cid: 20898, invoice_nr: "26232", job_number: 24863, acc: 1501330 },
	{ payid: 12, paydate: "2016-05-06", paymethod: "CASH", amount: "293.55", vat: "0.00", cid: 57, invoice_nr: "9701", job_number: 7809, acc: 3993001 }
];

const executed = [];
const journals = [];
async function run(sql, params = []) {
	const text = String(sql).replace(/\s+/g, " ").trim();
	executed.push({ sql: text, params });
	if (/^SELECT 1 FROM information_schema\.tables/.test(text)) return [{ 1: 1 }];
	if (/^SELECT COUNT\(\*\) AS cnt/.test(text)) return [{ cnt: 0 }];
	if (/WHERE c\.control_key = 'VAT_INPUT'/.test(text)) return [{ accnr: 3300, name: "VAT Input", type_code: "ASSET" }];
	if (/^SELECT p\.payid, p\.paydate, p\.paymethod, .* FROM tenant\.payments p WHERE/.test(text)) return PAYMENTS;
	if (/^SELECT accnr FROM tenant\.gl_accounts WHERE accnr IN .* AND active = 1/.test(text)) return params.filter((accnr) => ACTIVE_ROW_ACCOUNTS.has(accnr)).map((accnr) => ({ accnr }));
	if (/^SELECT accnr, active FROM tenant\.gl_accounts/.test(text)) return params.map((accnr) => ({ accnr, active: 1 }));
	if (/^SELECT/.test(text)) return [];
	return { affectedRows: 0, insertId: 1 };
}

const quietLogger = { info() {}, warn() {}, error() {}, debug() {}, log() {} };
quietLogger.child = () => quietLogger;
stub("lib/logger.js", quietLogger);
stub("database/database.js", {
	withPool: async (_pool, fn) => fn(),
	sanitizeParams: (params) => params,
	query: run,
	tenantQuery: (_companyDb, sql, params) => run(sql, params),
	companyTransaction: async () => ({ query: run, commit: async () => {}, rollback: async () => {} }),
	runInCompanyTx: async (first, second) => (typeof first === "function" ? first : second)({ query: run })
});
stub("utils/customerBalance.js", { recalculateCustomerBalance: async () => 0, getCustomerBalance: async () => 0, getCustomerBalances: async () => new Map(), saveCustomerBalance: async () => {}, openInvoiceConditionSql: () => "1=1" });
stub("utils/supplierBalance.js", { getSupplierBalance: async () => 0, saveSupplierBalance: async () => {}, recalculateSupplierBalance: async () => 0 });
stub("lib/finance/postingEngine.js", {
	postJournal: async () => { throw new Error("a dry run posts nothing"); },
	ensureGlSchemaSeed: async () => {},
	ensureDefaultPeriods: async () => {},
	validateLines: (lines) => { journals.push(lines); },
	getJournalBySource: async () => { throw Object.assign(new Error("not found"), { code: "JOURNAL_NOT_FOUND" }); },
	deleteGlJournalBySource: async () => {},
	getOpenPeriodId: async () => 1,
	resolveControlAccounts: async () => ({ AR: 3100, BANK: 3000, DISCOUNT: 2350, BAD_DEBTS: 2001, SALES: 1000, VAT_OUTPUT: 5100, CUSTOMER_DEPOSITS: 5200, AP: 5000, VAT_INPUT: 3300, INVENTORY: 3200, COS: 6000 })
});

const { runBackfillJob, clearPreviousBackfillScope } = require("../src/migrate/gl/glBackfill/mirror/lib/finance/glBackfill");

async function dryRun(types) {
	executed.length = 0;
	journals.length = 0;
	await runBackfillJob({ companyDb: "tenant", schema: "tenant", runId: 1, fromDate: "2016-01-01", toDate: "2026-12-31", types, dryRun: true, staffId: 3 });
}

const journalFor = (invoiceNr) => {
	const lines = journals.find((item) => item.some((line) => String(line.invoice_nr) === invoiceNr));
	assert.ok(lines, `a journal was built for invoice ${invoiceNr}`);
	return lines.map((line) => [line.accnr, Number(line.debit || 0), Number(line.credit || 0)]);
};

test("legacy settlements credit Accounts Receivable against their own account, Discounts or Bank", async () => {
	await dryRun(["DEBTOR_PAYMENT"]);
	assert.deepEqual(journalFor("18106"), [[3004, 7547.97, 0], [3100, 0, 7547.97]], "INTERNAL debits the INTERNAL PAYMENTS account it names");
	assert.deepEqual(journalFor("11458"), [[3000, 1389.87, 0], [3100, 0, 1389.87]], "an INTERNAL row naming no active account debits Bank, as legacy did");
	assert.deepEqual(journalFor("13164"), [[3500, 2983.41, 0], [3100, 0, 2983.41]], "WARRANTY debits the WARRANTY account it names");
	assert.deepEqual(journalFor("9001"), [[3500, 500, 0], [3100, 0, 500]], "SERVICE PLAN is read however it is cased");
	assert.deepEqual(journalFor("13991"), [[2350, 0.11, 0], [3100, 0, 0.11]], "ROUNDING debits Discounts Allowed");
	assert.deepEqual(journalFor("26232"), [[3100, 5997.44, 0], [3000, 0, 5997.44]], "a REFUND is owed again and paid out of Bank");
	assert.deepEqual(journalFor("9701"), [[3000, 293.55, 0], [3100, 0, 293.55]], "an ordinary receipt is unchanged");

	const items = executed.filter((q) => /^INSERT INTO tenant\.gl_backfill_run_items/.test(q.sql)).map((q) => q.params);
	assert.equal(items.length, PAYMENTS.length);
	for (const [, docType, source, sourceId, , status] of items) {
		assert.equal(docType, "DEBTOR_PAYMENT");
		assert.equal(source, "DEBTOR_PAYMENT", "settlements post as receipts, so Clear Previous and the integrity check find them");
		assert.ok(PAYMENTS.some((payment) => String(payment.payid) === String(sourceId)));
		assert.notEqual(status, "FAILED");
	}
});

test("customer payments skip only INVOICE, REVERSED and CUSTOMER CREDIT; supplier payments keep their rule", async () => {
	await dryRun(["DEBTOR_PAYMENT", "CREDITOR_PAYMENT"]);
	const customer = executed.filter((q) => /FROM tenant\.payments p WHERE/.test(q.sql));
	const supplier = executed.filter((q) => /FROM tenant\.payments_suppliers p WHERE/.test(q.sql));
	assert.equal(customer.length, 2, "customer payments are counted and selected");
	assert.equal(supplier.length, 2, "supplier payments are counted and selected");
	for (const q of customer) assert.match(q.sql, /NOT IN \('INVOICE', 'REVERSED', 'CUSTOMER CREDIT'\)/);
	for (const q of supplier) assert.match(q.sql, /NOT IN \('INVOICE', 'INTERNAL' , 'WARRANTY', 'REFUND','SERVICE PLAN','REVERSED','ROUNDING','CUSTOMER CREDIT'\)/);
});

test("Clear Previous removes the receipts the run posts again, settlements included", async () => {
	executed.length = 0;
	await clearPreviousBackfillScope({ companyDb: "tenant", schema: "tenant", fromDate: "2016-01-01", toDate: "2026-12-31", types: ["DEBTOR_PAYMENT"] });
	const deletes = executed.filter((q) => /^DELETE h FROM tenant\.gl_journal_headers h WHERE h\.source = 'DEBTOR_PAYMENT'/.test(q.sql));
	assert.equal(deletes.length, 1);
	assert.match(deletes[0].sql, /NOT IN \('INVOICE', 'REVERSED', 'CUSTOMER CREDIT'\)/);
});
