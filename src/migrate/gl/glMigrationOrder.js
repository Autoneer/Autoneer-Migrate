"use strict";

const ACCOUNTING_TABLE_SEQUENCE = [
	"accounts",
	"acc_class",
	"acc_department",
	"account_links",
	"acc_range",
	"gl_account_types",
	"gl_accounts",
	"gl_periods",
	"tax_codes",
	"journal",
	"journal_entry",
	"journal_temp",
	"ledger",
	"gl_journal_headers",
	"gl_journal_lines"
];

const ACCOUNTING_POSITION_MAP = new Map(
	ACCOUNTING_TABLE_SEQUENCE.map((tableName, index) => [tableName, index])
);

const GL_POSTING_TABLES = new Set([
	"gl_journal_headers",
	"gl_journal_lines"
]);

function normalizeTableName(tableName) {
	return String(tableName || "").trim().toLowerCase();
}

function isAccountingTable(tableName) {
	return ACCOUNTING_POSITION_MAP.has(normalizeTableName(tableName));
}

function reorderAccountingTableNames(tableNames = []) {
	const entries = (tableNames || []).map((tableName) => ({
		original: tableName,
		normalized: normalizeTableName(tableName)
	}));

	const accountingEntries = entries
		.filter((entry) => ACCOUNTING_POSITION_MAP.has(entry.normalized))
		.sort((a, b) => ACCOUNTING_POSITION_MAP.get(a.normalized) - ACCOUNTING_POSITION_MAP.get(b.normalized));

	let accountingIndex = 0;
	return entries.map((entry) => {
		if (!ACCOUNTING_POSITION_MAP.has(entry.normalized)) return entry.original;
		const nextEntry = accountingEntries[accountingIndex];
		accountingIndex += 1;
		return nextEntry.original;
	});
}

function reorderAccountingPlanSteps(planSteps = []) {
	const accountingSteps = (planSteps || [])
		.filter((step) => step && step.include !== false && isAccountingTable(step.table))
		.sort(
			(a, b) => ACCOUNTING_POSITION_MAP.get(normalizeTableName(a.table)) - ACCOUNTING_POSITION_MAP.get(normalizeTableName(b.table))
		);

	let accountingIndex = 0;
	return (planSteps || []).map((step) => {
		if (!step || step.include === false || !isAccountingTable(step.table)) return step;
		const nextStep = accountingSteps[accountingIndex];
		accountingIndex += 1;
		return nextStep;
	});
}

function findAccountingOrderIssues(tableNames = []) {
	const accountingOnly = (tableNames || [])
		.map(normalizeTableName)
		.filter((tableName) => ACCOUNTING_POSITION_MAP.has(tableName));
	const issues = [];

	for (let index = 1; index < accountingOnly.length; index += 1) {
		const previous = accountingOnly[index - 1];
		const current = accountingOnly[index];
		if (ACCOUNTING_POSITION_MAP.get(previous) > ACCOUNTING_POSITION_MAP.get(current)) {
			issues.push(`Move ${current} before ${previous}.`);
		}
	}

	return issues;
}

async function validateGLExecutionPrereqs(pool, planSteps = []) {
	const includedTables = (planSteps || [])
		.filter((step) => step && step.include !== false)
		.map((step) => normalizeTableName(step.table))
		.filter(Boolean);

	const needsGlPostingPrereqs = includedTables.some((tableName) => GL_POSTING_TABLES.has(tableName));
	if (!needsGlPostingPrereqs) return;

	let glAccountsRow;
	try {
		[[glAccountsRow]] = await pool.query("SELECT COUNT(*) AS count FROM gl_accounts");
	} catch (err) {
		const wrapped = new Error(
			"GL posting tables require rebuilt GL accounts. Migrate accounts, run 'Rebuild GL Accounts', then start the GL journal migration."
		);
		wrapped.code = "GL_REBUILD_REQUIRED";
		throw wrapped;
	}
	const glAccountsCount = Number(glAccountsRow?.count || 0);
	if (glAccountsCount <= 0) {
		const err = new Error(
			"GL posting tables require rebuilt GL accounts. Migrate accounts, run 'Rebuild GL Accounts', then start the GL journal migration."
		);
		err.code = "GL_REBUILD_REQUIRED";
		throw err;
	}

	let glPeriodsRow;
	try {
		[[glPeriodsRow]] = await pool.query("SELECT COUNT(*) AS count FROM gl_periods");
	} catch (err) {
		const wrapped = new Error(
			"GL posting tables require GL periods. Migrate or create gl_periods before starting the GL journal migration."
		);
		wrapped.code = "GL_PERIODS_REQUIRED";
		throw wrapped;
	}
	const glPeriodsCount = Number(glPeriodsRow?.count || 0);
	if (glPeriodsCount <= 0) {
		const err = new Error(
			"GL posting tables require GL periods. Migrate or create gl_periods before starting the GL journal migration."
		);
		err.code = "GL_PERIODS_REQUIRED";
		throw err;
	}
}

module.exports = {
	ACCOUNTING_TABLE_SEQUENCE,
	reorderAccountingTableNames,
	reorderAccountingPlanSteps,
	findAccountingOrderIssues,
	validateGLExecutionPrereqs
};
