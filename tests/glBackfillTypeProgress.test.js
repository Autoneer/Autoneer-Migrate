const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

// The Run Backfill card shows a bar per document type: the run records each
// selected type's total, and the status counts its items so far. Only the
// database, logger, posting engine and balances are stubbed.

const MIRROR = path.join(__dirname, "../src/migrate/gl/glBackfill/mirror");
const stub = (relative, exports) => {
	const file = require.resolve(path.join(MIRROR, relative));
	require.cache[file] = { id: file, filename: file, loaded: true, exports };
};

const executed = [];
let runRow = null;
let itemCounts = [];
async function run(sql, params = []) {
	const text = String(sql).replace(/\s+/g, " ").trim();
	executed.push({ sql: text, params });
	if (/^SELECT 1 FROM information_schema\.tables/.test(text)) return [{ 1: 1 }];
	if (/^SELECT COUNT\(\*\) AS cnt FROM tenant\.invoices_supplier si/.test(text)) return [{ cnt: 3 }];
	if (/^SELECT COUNT\(\*\) AS cnt FROM tenant\.payments p/.test(text)) return [{ cnt: 7 }];
	if (/^SELECT COUNT\(\*\) AS cnt/.test(text)) return [{ cnt: 0 }];
	if (/WHERE c\.control_key = 'VAT_INPUT'/.test(text)) return [{ accnr: 3300, name: "VAT Input", type_code: "ASSET" }];
	if (/^SELECT \* FROM tenant\.gl_backfill_runs WHERE id = \?/.test(text)) return runRow ? [runRow] : [];
	if (/^SELECT doc_type, status, COUNT\(\*\) AS cnt FROM tenant\.gl_backfill_run_items/.test(text)) return itemCounts;
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
	validateLines: () => {},
	getJournalBySource: async () => null,
	deleteGlJournalBySource: async () => {},
	getOpenPeriodId: async () => 1,
	resolveControlAccounts: async () => ({ AR: 3100, BANK: 3000, DISCOUNT: 2350, BAD_DEBTS: 2001, SALES: 1000, VAT_OUTPUT: 5100, CUSTOMER_DEPOSITS: 5200, AP: 5000, VAT_INPUT: 3300, INVENTORY: 3200, COS: 6000 })
});

const { runBackfillJob, getRunStatus } = require("../src/migrate/gl/glBackfill/mirror/lib/finance/glBackfill");

const savedSummaries = () => executed
	.filter((q) => /^UPDATE tenant\.gl_backfill_runs SET summary_json = \?/.test(q.sql))
	.map((q) => JSON.parse(q.params[0]));

test("a run records each selected type's total and the type it is working on", async () => {
	executed.length = 0;
	await runBackfillJob({ companyDb: "tenant", schema: "tenant", runId: 1, fromDate: "2025-03-01", toDate: "2026-03-01", types: ["DEBTOR_PAYMENT", "CREDITOR_INVOICE"], dryRun: true, staffId: 3 });
	const summaries = savedSummaries();
	assert.deepEqual(summaries[0].byType, { CREDITOR_INVOICE: { total: 3 }, DEBTOR_PAYMENT: { total: 7 } }, "types appear in posting order with their own totals");
	assert.equal(summaries[0].totalDocs, 10);
	assert.deepEqual(summaries.map((s) => s.currentType).filter(Boolean), ["CREDITOR_INVOICE", "DEBTOR_PAYMENT", "DEBTOR_PAYMENT"], "each type is marked as it starts");
	const count = executed.find((q) => /^SELECT COUNT\(\*\) AS cnt FROM tenant\.invoices_supplier si/.test(q.sql));
	assert.match(count.sql, /IN \('DONE', 'POSTED', 'CREDIT'\)/, "supplier invoices are counted as the run selects them");
	assert.match(count.sql, /si\.voided_at IS NULL/);
});

test("the status reports each type's progress from its items", async () => {
	runRow = { id: 1, status: "RUNNING", summary_json: JSON.stringify({ totalDocs: 10, currentType: "DEBTOR_PAYMENT", byType: { CREDITOR_INVOICE: { total: 3 }, DEBTOR_PAYMENT: { total: 7 } } }) };
	itemCounts = [
		{ doc_type: "CREDITOR_INVOICE", status: "SKIPPED", cnt: 2 },
		{ doc_type: "CREDITOR_INVOICE", status: "FAILED", cnt: 1 },
		{ doc_type: "DEBTOR_PAYMENT", status: "EXISTS", cnt: 4 }
	];
	const { summary } = await getRunStatus({ companyDb: "tenant", schema: "tenant", runId: 1, itemStatuses: ["FAILED"], itemLimit: 10 });
	assert.deepEqual(summary.byType, { CREDITOR_INVOICE: { total: 3, processed: 3 }, DEBTOR_PAYMENT: { total: 7, processed: 4 } });
	assert.equal(summary.currentType, "DEBTOR_PAYMENT");
	assert.deepEqual([summary.processedDocs, summary.skipped, summary.failed, summary.exists, summary.totalDocs], [7, 2, 1, 4, 10]);
});

test("a run saved before per-type progress shows only the overall figures", async () => {
	runRow = { id: 2, status: "DONE", summary_json: JSON.stringify({ totalDocs: 5 }) };
	itemCounts = [{ doc_type: "DEBTOR_PAYMENT", status: "SKIPPED", cnt: 5 }];
	const { summary } = await getRunStatus({ companyDb: "tenant", schema: "tenant", runId: 2, itemStatuses: ["FAILED"], itemLimit: 10 });
	assert.deepEqual(summary.byType, {});
	assert.equal(summary.processedDocs, 5);
});
