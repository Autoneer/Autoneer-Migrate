const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

// Legacy supplier invoice headers can sit under their lines. The header total
// and VAT stand and the lines' excess is credited to Cost of Sales. The figures
// are real dm_service_centre invoices. The end-to-end test reads each dry-run
// journal from validateLines; only the database, logger, posting engine,
// balances and account resolvers are stubbed.

const MIRROR = path.join(__dirname, "../src/migrate/gl/glBackfill/mirror");
const stub = (relative, exports) => {
	const file = require.resolve(path.join(MIRROR, relative));
	require.cache[file] = { id: file, filename: file, loaded: true, exports };
};

const COS = 6000, INVENTORY = 3200, AP = 5000, VAT_INPUT = 3300;
const line = (amountexvat, vat) => ({ amount: String(amountexvat + vat), amountexvat: String(amountexvat), discount: "0.00", vat: String(vat), quantity: "1.00", job_number: 0, partnr: "P1", stock_id: 1, siid: null, accasset: null, stocktype: null });
const INVOICES = [
	{ header: { id: 3923, doc_date: "2017-02-20", invoice_nr: "48565", suppid: 257, status: "DONE", amount: "2775.90", amountexvat: "2435.00", vat: "340.90", purchasetype: null, legacy_rfc_id: null }, lines: [line(2435, 340.9), line(2435, 340.9)] },
	{ header: { id: 3924, doc_date: "2017-02-21", invoice_nr: "48565-RFC", suppid: 257, status: "DONE", amount: "2775.90", amountexvat: "2435.00", vat: "340.90", purchasetype: null, legacy_rfc_id: null }, lines: [line(2435, 340.9), line(2435, 340.9)] },
	{ header: { id: 25964, doc_date: "2024-05-02", invoice_nr: "821421", suppid: 5, status: "DONE", amount: "292.44", amountexvat: "254.30", vat: "38.15", purchasetype: null, legacy_rfc_id: null }, lines: [line(254.3, 38.15)] },
	// 2523: header 7760 matches both lines; 7762 repeats one of them.
	{ header: { id: 7760, doc_date: "2018-03-17", invoice_nr: "2523", suppid: 38, status: "DONE", amount: "520.93", amountexvat: "456.95", vat: "63.98", purchasetype: null, legacy_rfc_id: null }, lines: [line(55.4, 7.76), line(401.55, 56.22)] },
	{ header: { id: 7762, doc_date: "2018-03-17", invoice_nr: "2523", suppid: 38, status: "DONE", amount: "457.74", amountexvat: "401.53", vat: "56.21", purchasetype: null, legacy_rfc_id: null }, lines: [] },
	// Neither header matches the lines they share.
	{ header: { id: 9001, doc_date: "2019-01-10", invoice_nr: "777", suppid: 9, status: "DONE", amount: "100.00", amountexvat: "86.96", vat: "13.04", purchasetype: null, legacy_rfc_id: null }, lines: [line(130.43, 19.57)] },
	{ header: { id: 9002, doc_date: "2019-01-10", invoice_nr: "777", suppid: 9, status: "DONE", amount: "200.00", amountexvat: "173.91", vat: "26.09", purchasetype: null, legacy_rfc_id: null }, lines: [] }
];

const journals = [];
const runItems = [];
async function run(sql, params = []) {
	const text = String(sql).replace(/\s+/g, " ").trim();
	if (/^INSERT INTO tenant\.gl_backfill_run_items/.test(text)) runItems.push({ docType: params[1], sourceId: params[3], status: params[5], message: params[6] });
	if (/^SELECT 1 FROM information_schema\.tables/.test(text)) return [{ 1: 1 }];
	if (/^SELECT COUNT\(\*\) AS cnt/.test(text)) return [{ cnt: 0 }];
	if (/WHERE c\.control_key = 'VAT_INPUT'/.test(text)) return [{ accnr: VAT_INPUT, name: "VAT Input", type_code: "ASSET" }];
	if (/^SELECT sinvid AS id, .* FROM tenant\.invoices_supplier si WHERE/.test(text)) return INVOICES.map((invoice) => invoice.header);
	if (/FROM tenant\.invoice_items/.test(text)) return INVOICES.find((invoice) => invoice.header.suppid === params[0] && invoice.header.invoice_nr === params[1]).lines;
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
stub("lib/finance/stockGlResolver.js", { resolveStockGlAccounts: async () => ({ assetAccnr: INVENTORY, cosAccnr: COS }) });
stub("services/suppliers/supplierInvoices.service.js", {
	normalizeJobNumber: (value) => (Number(value) > 0 ? String(value) : null),
	resolveCreditorInvoiceLineAccount: async () => INVENTORY,
	resolveSupplierAssetControls: async () => ({ AP, VAT_INPUT, INVENTORY, WIP: 3250 })
});
stub("lib/finance/postingEngine.js", {
	postJournal: async () => { throw new Error("a dry run posts nothing"); },
	ensureGlSchemaSeed: async () => {},
	ensureDefaultPeriods: async () => {},
	validateLines: (lines) => { journals.push(lines); },
	getJournalBySource: async () => { throw Object.assign(new Error("not found"), { code: "JOURNAL_NOT_FOUND" }); },
	deleteGlJournalBySource: async () => {},
	getOpenPeriodId: async () => 1,
	resolveControlAccounts: async () => ({ AR: 3100, BANK: 3000, DISCOUNT: 2350, BAD_DEBTS: 2001, SALES: 1000, VAT_OUTPUT: 5100, CUSTOMER_DEPOSITS: 5200, AP, VAT_INPUT, INVENTORY, COS })
});

const { settleCreditorLineGap, runBackfillJob } = require("../src/migrate/gl/glBackfill/mirror/lib/finance/glBackfill");

test("a header a cent under its lines keeps its total and VAT; the cent goes to Cost of Sales", () => {
	// 821421: header 292.44 = 254.30 ex-VAT + 38.15 VAT rounded separately.
	assert.deepEqual(settleCreditorLineGap({ apTotal: 292.44, vatToPost: 38.15, headerVat: 38.15, itemExVatTotal: 254.30 }), { vat: 38.15, gap: -0.01 });
	// 440250 from the dry run: the lines' ex-VAT is a cent over the header's.
	assert.deepEqual(settleCreditorLineGap({ apTotal: 609.04, vatToPost: 79.44, headerVat: 79.44, itemExVatTotal: 529.61 }), { vat: 79.44, gap: -0.01 });
});

test("per-line VAT rounding of a few cents posts the tax invoice's VAT", () => {
	// 345071: six lines round their VAT to 117.38; the tax invoice says 117.36.
	assert.deepEqual(settleCreditorLineGap({ apTotal: 899.75, vatToPost: 117.38, headerVat: 117.36, itemExVatTotal: 782.40 }), { vat: 117.36, gap: -0.01 });
	// 353003: seven lines, three cents.
	assert.deepEqual(settleCreditorLineGap({ apTotal: 1594.98, vatToPost: 208.06, headerVat: 208.04, itemExVatTotal: 1386.95 }), { vat: 208.04, gap: -0.01 });
});

test("lines well over the header keep the header's total and VAT; the excess is credited to Cost of Sales", () => {
	// 48565: the lines are the header twice over.
	assert.deepEqual(settleCreditorLineGap({ apTotal: 2775.90, vatToPost: 681.80, headerVat: 340.90, itemExVatTotal: 4870 }), { vat: 340.90, gap: -2435 });
	// 1326111: R3.59 over, VAT included.
	assert.deepEqual(settleCreditorLineGap({ apTotal: 147.56, vatToPost: 19.72, headerVat: 19.25, itemExVatTotal: 131.43 }), { vat: 19.25, gap: -3.12 });
	// 88121035: the tax invoice charges no VAT, so none is claimed for its lines.
	assert.deepEqual(settleCreditorLineGap({ apTotal: 150, vatToPost: 36.55, headerVat: 0, itemExVatTotal: 393.68 }), { vat: 0, gap: -243.68 });
});

test("a header above its lines is unchanged: the backfill VAT stands and the gap is debited", () => {
	assert.deepEqual(settleCreditorLineGap({ apTotal: 1000, vatToPost: 120, headerVat: 130, itemExVatTotal: 800 }), { vat: 120, gap: 80 });
	assert.deepEqual(settleCreditorLineGap({ apTotal: 920, vatToPost: 120, headerVat: 120, itemExVatTotal: 800 }), { vat: 120, gap: 0 });
});

const byAccount = (lines) => {
	const totals = {};
	for (const ln of lines) totals[ln.accnr] = Math.round(((totals[ln.accnr] || 0) + Number(ln.debit || 0) - Number(ln.credit || 0)) * 100) / 100;
	return totals;
};
const journalFor = (invoiceNr) => journals.filter((lines) => lines.some((ln) => ln.invoice_nr === invoiceNr));

test("supplier invoices and returns whose lines exceed the header post balanced journals", async () => {
	journals.length = 0;
	runItems.length = 0;
	await runBackfillJob({ companyDb: "tenant", schema: "tenant", runId: 1, fromDate: "2017-01-01", toDate: "2024-12-31", types: ["CREDITOR_INVOICE"], dryRun: true, staffId: 3 });
	const [invoice, ret, rounding] = INVOICES.slice(0, 3).map(({ header }) => journalFor(header.invoice_nr)[0]);
	assert.ok(invoice && ret && rounding, "every invoice built a journal");
	for (const lines of [invoice, ret, rounding]) {
		const net = lines.reduce((sum, ln) => sum + Number(ln.debit || 0) - Number(ln.credit || 0), 0);
		assert.ok(Math.abs(net) < 0.005, "the journal balances");
	}
	// Positive is a debit: stock at the lines, VAT and AP at the header, the excess off Cost of Sales.
	assert.deepEqual(byAccount(invoice), { [INVENTORY]: 4870, [VAT_INPUT]: 340.9, [AP]: -2775.9, [COS]: -2435 });
	assert.deepEqual(byAccount(ret), { [INVENTORY]: -4870, [VAT_INPUT]: -340.9, [AP]: 2775.9, [COS]: 2435 }, "a return reverses every side");
	assert.deepEqual(byAccount(rounding), { [INVENTORY]: 254.3, [VAT_INPUT]: 38.15, [AP]: -292.44, [COS]: -0.01 });
});

test("a duplicated supplier invoice posts once, with the header that matches its lines", async () => {
	journals.length = 0;
	runItems.length = 0;
	await runBackfillJob({ companyDb: "tenant", schema: "tenant", runId: 1, fromDate: "2017-01-01", toDate: "2024-12-31", types: ["CREDITOR_INVOICE"], dryRun: true, staffId: 3 });
	const posted = journalFor("2523");
	assert.equal(posted.length, 1, "one journal for supplier 38 invoice 2523");
	assert.deepEqual(byAccount(posted[0]), { [INVENTORY]: 456.95, [VAT_INPUT]: 63.98, [AP]: -520.93 }, "header 7760 and its lines, with no gap");
	const items = (invoiceNr) => runItems.filter((item) => item.sourceId === invoiceNr).map(({ status, message }) => ({ status, message }));
	assert.deepEqual(items("2523"), [{ status: "SKIPPED", message: "Duplicate of supplier invoice header 7760, which has the same supplier and invoice number and posts their lines." }]);
	// No header matches: nothing posts and both headers fail for review.
	assert.equal(journalFor("777").length, 0);
	assert.deepEqual(items("777").map((item) => item.status), ["FAILED", "FAILED"]);
	assert.equal(runItems.length, INVOICES.length, "every header ends as one run item");
});
