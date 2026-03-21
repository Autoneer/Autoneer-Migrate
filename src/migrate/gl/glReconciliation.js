/**
 * GL Reconciliation — GAAP Consistency Checks
 * ==============================================
 * Post-migration checks that enforce:
 *  1. Trial Balance balances (sum debits = sum credits).
 *  2. Balance Sheet identity (Assets = Equity + Liabilities).
 *  3. Income Statement uses only INCOME/EXPENSE/COS types.
 *  4. No Balance Sheet accounts leak into P&L totals.
 *
 * All monetary comparisons use a tolerance of 0.01 (one cent) to handle
 * floating-point rounding from decimal(18,2) arithmetic.
 */

"use strict";

const { INCOME_STATEMENT_TYPE_IDS, BALANCE_SHEET_TYPE_IDS } = require("./glAccountTypes");

const TOLERANCE = 0.01; // 1 cent tolerance for rounding

async function resolveGLJournalHeaderDateColumn(pool) {
	const [rows] = await pool.query(`
		SELECT column_name AS name
		FROM information_schema.columns
		WHERE table_schema = DATABASE()
		  AND table_name = 'gl_journal_headers'
		  AND column_name IN ('jdate', 'trxdate')
	`);
	const names = rows.map((row) => String(row.name || "").toLowerCase());
	if (names.includes("jdate")) return "jdate";
	if (names.includes("trxdate")) return "trxdate";
	return null;
}

/**
 * GAAP CHECK 1: Trial Balance — sum(debit) must equal sum(credit).
 * Tests both: (a) gl_journal_lines, and (b) legacy journal table if present.
 * @param {import('mysql2/promise').Pool} pool
 * @param {object} [opts] - Optional { startDate, endDate } to constrain period.
 */
async function checkTrialBalance(pool, opts = {}) {
	const errors = [];
	const details = {};

	// GL journal lines
	try {
		let where = "";
		const params = [];
		let skippedForMissingDateColumn = false;
		if (opts.startDate || opts.endDate) {
			const headerDateColumn = await resolveGLJournalHeaderDateColumn(pool);
			if (!headerDateColumn) {
				skippedForMissingDateColumn = true;
				details.gl_journal_lines = {
					skipped: true,
					reason: "gl_journal_headers date column not found"
				};
			} else {
				where = "JOIN gl_journal_headers jh ON jh.id = jl.header_id WHERE 1=1";
				if (opts.startDate) { where += ` AND jh.${headerDateColumn} >= ?`; params.push(opts.startDate); }
				if (opts.endDate) { where += ` AND jh.${headerDateColumn} <= ?`; params.push(opts.endDate); }
			}
		}

		if (!skippedForMissingDateColumn) {
			const sql = `
				SELECT
					COALESCE(SUM(jl.debit), 0) AS total_debit,
					COALESCE(SUM(jl.credit), 0) AS total_credit
				FROM gl_journal_lines jl
				${where}
			`;

			const [rows] = await pool.query(sql, params);
			const totalDebit = Number(rows[0]?.total_debit || 0);
			const totalCredit = Number(rows[0]?.total_credit || 0);
			const diff = Math.abs(totalDebit - totalCredit);

			details.gl_journal_lines = { totalDebit, totalCredit, difference: diff };

			if (diff > TOLERANCE) {
				errors.push({
					source: "gl_journal_lines",
					totalDebit,
					totalCredit,
					difference: diff,
					message: `Trial balance imbalance in gl_journal_lines: debits=${totalDebit.toFixed(2)}, credits=${totalCredit.toFixed(2)}, diff=${diff.toFixed(2)}`
				});
			}
		}
	} catch (err) {
		if (!err.message.includes("doesn't exist")) throw err;
		details.gl_journal_lines = { skipped: true, reason: "table does not exist" };
	}

	// Legacy journal table (informational cross-check)
	try {
		let where = "WHERE 1=1";
		const params = [];
		if (opts.startDate) { where += " AND jdate >= ?"; params.push(opts.startDate); }
		if (opts.endDate) { where += " AND jdate <= ?"; params.push(opts.endDate); }

		const sql = `
			SELECT
				COALESCE(SUM(debitamount), 0) AS total_debit,
				COALESCE(SUM(creditamount), 0) AS total_credit
			FROM journal
			${where}
		`;

		const [rows] = await pool.query(sql, params);
		const totalDebit = Number(rows[0]?.total_debit || 0);
		const totalCredit = Number(rows[0]?.total_credit || 0);
		const diff = Math.abs(totalDebit - totalCredit);

		details.legacy_journal = { totalDebit, totalCredit, difference: diff };

		if (diff > TOLERANCE) {
			errors.push({
				source: "legacy_journal",
				totalDebit,
				totalCredit,
				difference: diff,
				message: `Trial balance imbalance in legacy journal: debits=${totalDebit.toFixed(2)}, credits=${totalCredit.toFixed(2)}, diff=${diff.toFixed(2)}`
			});
		}
	} catch (err) {
		if (!err.message.includes("doesn't exist")) throw err;
		details.legacy_journal = { skipped: true, reason: "table does not exist" };
	}

	return {
		check: "GAAP-1",
		name: "Trial Balance",
		passed: errors.length === 0,
		errors,
		details
	};
}

/**
 * GAAP CHECK 2: Balance Sheet identity — Assets = Equity + Liabilities.
 * Uses gl_journal_lines joined to gl_accounts → gl_account_types.
 * Net balance for each BS category = SUM(debit) - SUM(credit).
 * For Assets (normal debit balance): net = debit - credit
 * For Liabilities/Equity (normal credit balance): net = credit - debit
 * Identity: Assets = Liabilities + Equity
 */
async function checkBalanceSheet(pool, opts = {}) {
	const errors = [];
	const details = {};

	try {
		let dateJoin = "";
		const params = [];
		let skippedForMissingDateColumn = false;
		if (opts.startDate || opts.endDate) {
			const headerDateColumn = await resolveGLJournalHeaderDateColumn(pool);
			if (!headerDateColumn) {
				skippedForMissingDateColumn = true;
				details.skipped = true;
				details.reason = "gl_journal_headers date column not found";
			} else {
				dateJoin = "JOIN gl_journal_headers jh ON jh.id = jl.header_id";
				if (opts.startDate) { dateJoin += ` AND jh.${headerDateColumn} >= ?`; params.push(opts.startDate); }
				if (opts.endDate) { dateJoin += ` AND jh.${headerDateColumn} <= ?`; params.push(opts.endDate); }
			}
		}

		if (!skippedForMissingDateColumn) {
			const sql = `
				SELECT
					gat.id AS type_id,
					gat.code,
					gat.statement_section,
					COALESCE(SUM(jl.debit), 0) AS total_debit,
					COALESCE(SUM(jl.credit), 0) AS total_credit
				FROM gl_journal_lines jl
				JOIN gl_accounts ga ON ga.accnr = jl.accnr
				JOIN gl_account_types gat ON gat.id = ga.type_id
				${dateJoin}
				WHERE gat.statement_section = 'BalanceSheet'
				GROUP BY gat.id, gat.code, gat.statement_section
			`;

			const [rows] = await pool.query(sql, params);

			let totalAssets = 0;
			let totalLiabilities = 0;
			let totalEquity = 0;

			for (const row of rows) {
				const debit = Number(row.total_debit);
				const credit = Number(row.total_credit);

				if (row.code === "ASSET") {
					// Assets have normal debit balance
					totalAssets = debit - credit;
				} else if (row.code === "LIABILITY") {
					// Liabilities have normal credit balance
					totalLiabilities = credit - debit;
				} else if (row.code === "EQUITY") {
					// Equity has normal credit balance
					totalEquity = credit - debit;
				}
			}

			details.assets = totalAssets;
			details.liabilities = totalLiabilities;
			details.equity = totalEquity;
			details.liabilities_plus_equity = totalLiabilities + totalEquity;

			const diff = Math.abs(totalAssets - (totalLiabilities + totalEquity));
			details.difference = diff;

			if (diff > TOLERANCE) {
				errors.push({
					assets: totalAssets,
					liabilities: totalLiabilities,
					equity: totalEquity,
					difference: diff,
					message: `Balance Sheet does not balance: Assets=${totalAssets.toFixed(2)}, Liabilities+Equity=${(totalLiabilities + totalEquity).toFixed(2)}, diff=${diff.toFixed(2)}`
				});
			}
		}
	} catch (err) {
		if (!err.message.includes("doesn't exist")) throw err;
		details.skipped = true;
		details.reason = "gl_journal_lines or related tables do not exist";
	}

	return {
		check: "GAAP-2",
		name: "Balance Sheet Identity (A = L + E)",
		passed: errors.length === 0,
		errors,
		details
	};
}

/**
 * GAAP CHECK 3: Income Statement uses only INCOME/EXPENSE/COS types.
 * No ASSET/LIABILITY/EQUITY accounts should appear in P&L totals.
 */
async function checkIncomeStatementPurity(pool) {
	const errors = [];
	const details = {};

	// Check if any Balance Sheet accounts have postings that could leak into P&L
	try {
		const bsTypeIds = BALANCE_SHEET_TYPE_IDS.join(",");
		const isTypeIds = INCOME_STATEMENT_TYPE_IDS.join(",");

		// Verify no BS accounts are accidentally flagged as IS
		const [leaks] = await pool.query(`
			SELECT ga.accnr, ga.name, gat.code, gat.statement_section
			FROM gl_accounts ga
			JOIN gl_account_types gat ON gat.id = ga.type_id
			WHERE gat.id IN (${bsTypeIds})
			  AND gat.statement_section = 'IncomeStatement'
		`);

		for (const row of leaks) {
			errors.push({
				type: "bs_account_in_is",
				accnr: row.accnr,
				name: row.name,
				type_code: row.code,
				message: `Balance Sheet account ${row.accnr} (${row.name}) typed as ${row.code} is labelled IncomeStatement`
			});
		}

		// Verify no IS accounts are accidentally flagged as BS
		const [reverseLeaks] = await pool.query(`
			SELECT ga.accnr, ga.name, gat.code, gat.statement_section
			FROM gl_accounts ga
			JOIN gl_account_types gat ON gat.id = ga.type_id
			WHERE gat.id IN (${isTypeIds})
			  AND gat.statement_section = 'BalanceSheet'
		`);

		for (const row of reverseLeaks) {
			errors.push({
				type: "is_account_in_bs",
				accnr: row.accnr,
				name: row.name,
				type_code: row.code,
				message: `Income Statement account ${row.accnr} (${row.name}) typed as ${row.code} is labelled BalanceSheet`
			});
		}

		details.balance_sheet_leaks = leaks.length;
		details.income_statement_leaks = reverseLeaks.length;
	} catch (err) {
		if (!err.message.includes("doesn't exist")) throw err;
		details.skipped = true;
	}

	return {
		check: "GAAP-3",
		name: "Income Statement Purity",
		passed: errors.length === 0,
		errors,
		details
	};
}

/**
 * GAAP CHECK 4: COS consistency — COS amounts posted only to COS-typed accounts.
 * Unless explicitly configured, no COS amounts should appear in EXPENSE totals.
 */
async function checkCOSConsistency(pool) {
	const errors = [];
	const details = {};

	try {
		// Check if any journal lines to COS accounts are incorrectly aggregated
		const [cosAccounts] = await pool.query(`
			SELECT ga.accnr, ga.name
			FROM gl_accounts ga
			JOIN gl_account_types gat ON gat.id = ga.type_id
			WHERE gat.code = 'COS'
		`);

		details.cos_account_count = cosAccounts.length;

		if (cosAccounts.length > 0) {
			// Verify COS accounts are not mixed with EXPENSE in any grouping
			const [mixed] = await pool.query(`
				SELECT
					ga.statement_group,
					COUNT(DISTINCT CASE WHEN gat.code = 'COS' THEN ga.accnr END) AS cos_accounts,
					COUNT(DISTINCT CASE WHEN gat.code = 'EXPENSE' THEN ga.accnr END) AS expense_accounts
				FROM gl_accounts ga
				JOIN gl_account_types gat ON gat.id = ga.type_id
				WHERE gat.code IN ('COS', 'EXPENSE')
				  AND ga.statement_group IS NOT NULL
				GROUP BY ga.statement_group
				HAVING cos_accounts > 0 AND expense_accounts > 0
			`);

			for (const row of mixed) {
				errors.push({
					type: "cos_expense_mixed_group",
					statement_group: row.statement_group,
					cos_count: row.cos_accounts,
					expense_count: row.expense_accounts,
					message: `Statement group '${row.statement_group}' mixes COS (${row.cos_accounts}) and EXPENSE (${row.expense_accounts}) accounts. ` +
						`These must be separated for correct P&L presentation.`
				});
			}
		}
	} catch (err) {
		if (!err.message.includes("doesn't exist")) throw err;
		details.skipped = true;
	}

	return {
		check: "GAAP-4",
		name: "COS Consistency",
		passed: errors.length === 0,
		errors,
		details
	};
}

/**
 * Run ALL GAAP checks.
 * @param {import('mysql2/promise').Pool} pool
 * @param {object} [opts] - Optional { startDate, endDate } for period filtering.
 */
async function runAllGAAPChecks(pool, opts = {}) {
	const checks = await Promise.all([
		checkTrialBalance(pool, opts),
		checkBalanceSheet(pool, opts),
		checkIncomeStatementPurity(pool),
		checkCOSConsistency(pool)
	]);

	const allPassed = checks.every(c => c.passed);

	return { allPassed, checks };
}

module.exports = {
	checkTrialBalance,
	checkBalanceSheet,
	checkIncomeStatementPurity,
	checkCOSConsistency,
	runAllGAAPChecks
};
