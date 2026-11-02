const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

// Legacy general invoices (counter sales) keep their parts and labour on job 0,
// stamped with the invoice number. The customer-invoice backfill must post them
// like a job invoice: Sales per line and Cost of Sales against Inventory, found
// by invoice alone and with no WIP relief, since job 0 is shared by every such
// sale. A dry run builds every journal; validateLines is where this test reads
// them. Only the database, logger, posting engine and balances are stubbed.

const MIRROR = path.join(__dirname, "../src/migrate/gl/glBackfill/mirror");
const stub = (relative, exports) => {
	const file = require.resolve(path.join(MIRROR, relative));
	require.cache[file] = { id: file, filename: file, loaded: true, exports };
};

const INVOICES = [
	{ invoice_nr: 26497, doc_date: "2026-10-30", job_number: 0, cid: 24 },
	{ invoice_nr: 26498, doc_date: "2026-10-30", job_number: 25137, cid: 31 }
];
const HEADERS = {
	26497: { ex: "4134.67", inc: "4754.87", vat: "620.20" },
	26498: { ex: "1000.00", inc: "1150.00", vat: "150.00" }
};
const PARTS = {
	"0:26497": [
		{ stock_id: 22562, partnr: "K30VALVEGASKETSET", acc: 1501200, siid: 6050, accasset: 3200, status: "DONE", item_sale: "2040.54", item_cost: "1530.44" },
		{ stock_id: 22563, partnr: "OIL", acc: 1501200, siid: 6050, accasset: 3200, status: "DONE", item_sale: "579.71", item_cost: "434.79" }
	],
	"25137:26498": [
		{ stock_id: 7, partnr: "FILTER", acc: null, siid: 6050, accasset: 3200, status: "DONE", item_sale: "1000.00", item_cost: "600.00" }
	]
};
const WORK = {
	"0:26497": [{ acc: 1300, siid: 6300, work_sale: "1514.42", work_cost: "0.00" }]
};
const ACTIVE_ACCOUNTS = new Set([1300, 1400, 6050, 3200, 3400, 6300]);
let failedPartsInvoice = null;

const executed = [];
const journals = [];
async function run(sql, params = []) {
	const text = String(sql).replace(/\s+/g, " ").trim();
	executed.push({ sql: text, params });
	if (/^SELECT 1 FROM information_schema\.tables/.test(text)) return [{ 1: 1 }];
	if (/^SELECT COUNT\(\*\) AS cnt/.test(text)) return [{ cnt: INVOICES.length }];
	if (/WHERE c\.control_key = 'VAT_INPUT'/.test(text)) return [{ accnr: 3300, name: "VAT Input", type_code: "ASSET" }];
	if (/^SELECT i\.invoice_nr, i\.invoice_date AS doc_date, i\.job_number, i\.cid FROM tenant\.invoices i/.test(text)) return INVOICES;
	if (/^SELECT i\.inv_totalexlvat AS ex/.test(text)) return [HEADERS[params[0]]];
	if (/FROM tenant\.spares_used WHERE job_number = \?/.test(text)) {
		if (params[1] === failedPartsInvoice) throw new Error("Parts read failed");
		return PARTS[`${params[0]}:${params[1]}`] || [];
	}
	if (/FROM tenant\.work_done WHERE job_number = \? AND invoice_nr = \?/.test(text)) return WORK[`${params[0]}:${params[1]}`] || [];
	if (/^SELECT COALESCE\(SUM\(l\.debit - l\.credit\), 0\) AS total FROM tenant\.gl_journal_lines l/.test(text)) return [{ total: "250.00" }];
	if (/^SELECT accnr FROM tenant\.gl_accounts WHERE accnr IN .* AND active = 1/.test(text)) return params.filter((accnr) => ACTIVE_ACCOUNTS.has(accnr)).map((accnr) => ({ accnr }));
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

test("general-invoice returns reverse signed sales and costs while preserving sublet mappings", async () => {
	const nr = 12329;
	INVOICES.push({ invoice_nr: nr, doc_date: "2026-10-30", job_number: 0, cid: 24 });
	HEADERS[nr] = { ex: "120.00", inc: "138.00", vat: "18.00" };
	PARTS[`0:${nr}`] = [
		{ acc: 1501200, siid: 6050, accasset: 3200, status: "DONE", item_sale: "100.00", item_cost: "60.00" },
		{ acc: 1501200, siid: 6050, accasset: 3200, status: "RETURNED", item_sale: "-100.00", item_cost: "-60.00" },
		{ acc: 1400, siid: 6300, accasset: 3400, status: "DONE", item_sale: "20.00", item_cost: "10.00" }
	];
	try {
		executed.length = 0; journals.length = 0;
		await runBackfillJob({ companyDb: "tenant", schema: "tenant", runId: 1, fromDate: "2016-01-01", toDate: "2026-12-31", types: ["DEBTOR_INVOICE"], dryRun: true, staffId: 3 });
		assert.deepEqual(journalFor(nr), [
			[3100,138,0], [5100,0,18], [1000,0,100], [1000,100,0], [1400,0,20],
			[6050,60,0], [3200,0,60], [6050,0,60], [3200,60,0],
			[6300,10,0], [3400,0,10], [1000,0,100]
		], "return costs cancel, service costs retain their mappings, and the header gap stays Sales");
		const generalSql = executed.find(q => /FROM tenant\.spares_used/.test(q.sql) && q.params[1] === nr).sql;
		assert.match(generalSql, /invoice_nr IS NOT NULL AND ABS\(/);
		assert.match(generalSql, /AND ABS\(CAST\(cost_price/);
		const jobSql = executed.find(q => /FROM tenant\.spares_used/.test(q.sql) && q.params[0] === 25137).sql;
		assert.doesNotMatch(jobSql, /ABS\(/, "job invoice selection is unchanged");
	} finally { INVOICES.pop(); delete HEADERS[nr]; delete PARTS[`0:${nr}`]; }
});

test("general-invoice parts read failures cannot fall back to an incomplete sales-only journal", async () => {
	executed.length = 0; journals.length = 0; failedPartsInvoice = 26497;
	try {
		await runBackfillJob({ companyDb: "tenant", schema: "tenant", runId: 1, fromDate: "2016-01-01", toDate: "2026-12-31", types: ["DEBTOR_INVOICE"], dryRun: true, staffId: 3 });
		assert.equal(journals.some(lines => lines.some(line => line.invoice_nr === 26497)), false);
		assert.ok(executed.some(q => /INSERT INTO tenant\.gl_backfill_run_items/.test(q.sql) && q.params.includes("FAILED") && q.params.includes("Parts read failed")));
		assert.ok(journalFor(26498), "other job invoices still build");
	} finally { failedPartsInvoice = null; }
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
	resolveControlAccounts: async () => ({ AR: 3100, BANK: 3000, SALES: 1000, VAT_OUTPUT: 5100, AP: 5000, VAT_INPUT: 3300, INVENTORY: 3200, COS: 6000, WIP: 3250 })
});

const { runBackfillJob } = require("../src/migrate/gl/glBackfill/mirror/lib/finance/glBackfill");

const journalFor = (invoiceNr) => {
	const lines = journals.find((item) => item.some((line) => Number(line.invoice_nr) === invoiceNr));
	assert.ok(lines, `a journal was built for invoice ${invoiceNr}`);
	return lines.map((line) => [line.accnr, Number(line.debit || 0), Number(line.credit || 0)]);
};

test("a legacy general invoice posts its job-0 lines by invoice: Sales per line, Cost of Sales against Inventory, no WIP", async () => {
	executed.length = 0;
	journals.length = 0;
	await runBackfillJob({ companyDb: "tenant", schema: "tenant", runId: 1, fromDate: "2016-01-01", toDate: "2026-12-31", types: ["DEBTOR_INVOICE"], dryRun: true, staffId: 3 });

	assert.deepEqual(journalFor(26497), [
		[3100, 4754.87, 0],
		[5100, 0, 620.2],
		[1000, 0, 2040.54], [1000, 0, 579.71],
		[6050, 1530.44, 0], [3200, 0, 1530.44],
		[6050, 434.79, 0], [3200, 0, 434.79],
		[1300, 0, 1514.42]
	], "the legacy part account is not a GL account, so part sales use Sales; labour keeps its own account");

	const partQueries = executed.filter((q) => /FROM tenant\.spares_used WHERE job_number = \?/.test(q.sql));
	const generalParts = partQueries.find((q) => q.params[0] === 0);
	assert.deepEqual(generalParts.params, [0, 26497]);
	assert.match(generalParts.sql, /WHERE job_number = \? AND invoice_nr = \? AND UPPER/, "unstamped job-0 lines belong to no invoice and are never taken");

	assert.deepEqual(journalFor(26498), [
		[3100, 1150, 0],
		[5100, 0, 150],
		[1000, 0, 1000],
		[6050, 600, 0], [3250, 0, 250], [3200, 0, 350]
	], "a job invoice still relieves its job's WIP first");
	const wipLookups = executed.filter((q) => /^SELECT COALESCE\(SUM\(l\.debit - l\.credit\), 0\) AS total FROM tenant\.gl_journal_lines l/.test(q.sql));
	assert.equal(wipLookups.length, 1, "only the job invoice looks up WIP");
});
