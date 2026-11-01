const test = require("node:test");
const assert = require("node:assert/strict");

const { checkBalanceSheet } = require("../src/migrate/gl/glReconciliation");

const pool = (rows) => ({ query: async () => [rows] });
const typeRow = (code, statement_section, total_debit, total_credit) => ({ code, statement_section, total_debit, total_credit });

test("the balance sheet identity counts the unclosed result as equity", async () => {
	// October 2025 of a backfilled tenant: a loss, not yet closed to retained earnings.
	const result = await checkBalanceSheet(pool([
		typeRow("ASSET", "BalanceSheet", "900000.00", "587059.01"),
		typeRow("LIABILITY", "BalanceSheet", "100000.00", "437753.84"),
		typeRow("INCOME", "IncomeStatement", "0.00", "71875.44"),
		typeRow("COS", "IncomeStatement", "96688.29", "0.00")
	]));
	assert.equal(result.passed, true, JSON.stringify(result.errors));
	assert.equal(result.details.current_result.toFixed(2), "-24812.85");
});

test("the balance sheet identity still fails a ledger that does not balance", async () => {
	const result = await checkBalanceSheet(pool([
		typeRow("ASSET", "BalanceSheet", "100.00", "0.00"),
		typeRow("EQUITY", "BalanceSheet", "0.00", "60.00"),
		typeRow("INCOME", "IncomeStatement", "0.00", "30.00")
	]));
	assert.equal(result.passed, false);
	assert.equal(result.details.difference.toFixed(2), "10.00");
});
