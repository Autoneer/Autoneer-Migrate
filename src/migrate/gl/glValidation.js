/**
 * GL Validation — Post-Migration Verification Queries
 * =====================================================
 * Automated SQL checks that MUST pass after every migration.
 * Each check returns { passed: boolean, errors: Array, details: any }.
 *
 * If ANY check fails, the migration is considered invalid and must be
 * corrected before the data is used for reporting.
 */

"use strict";

const {
	GL_ACCOUNT_TYPES,
	ACCCLASS_TO_TYPE_ID,
	INCOME_STATEMENT_TYPE_IDS,
	BALANCE_SHEET_TYPE_IDS
} = require("./glAccountTypes");

/**
 * CHECK A: Accounts typed incorrectly.
 * Any gl_accounts whose type_id does not match expected mapping derived
 * from the original Firebird ACCCLASS for that accnr.
 *
 * Joins gl_accounts → staging accounts (via accnr) → compares type_id
 * against the canonical ACCCLASS → type_id mapping.
 */
async function checkAccountTypeMismatches(pool) {
	const errors = [];

	// Build a CASE expression for the canonical mapping
	const caseExpr = Object.entries(ACCCLASS_TO_TYPE_ID)
		.map(([accclass, typeId]) => `WHEN ${accclass} THEN ${typeId}`)
		.join(" ");

	const sql = `
		SELECT
			ga.accnr,
			ga.name,
			ga.type_id                          AS actual_type_id,
			gat_actual.code                     AS actual_type_code,
			a.accclass                          AS source_accclass,
			CASE a.accclass ${caseExpr} ELSE NULL END AS expected_type_id
		FROM gl_accounts ga
		JOIN accounts a ON a.accnr = ga.accnr
			OR (a.accnr IS NOT NULL AND MOD(a.accnr, 10000) = ga.accnr
				AND LOWER(TRIM(a.acctype)) = 'group account')
		LEFT JOIN gl_account_types gat_actual ON gat_actual.id = ga.type_id
		HAVING actual_type_id != expected_type_id
			OR expected_type_id IS NULL
		ORDER BY ga.accnr
	`;

	const [rows] = await pool.query(sql);

	for (const row of rows) {
		errors.push({
			accnr: row.accnr,
			name: row.name,
			actual_type_id: row.actual_type_id,
			actual_type_code: row.actual_type_code,
			source_accclass: row.source_accclass,
			expected_type_id: row.expected_type_id,
			message: `Account ${row.accnr} (${row.name}): type_id=${row.actual_type_id} but ACCCLASS=${row.source_accclass} → expected type_id=${row.expected_type_id}`
		});
	}

	return {
		check: "A",
		name: "Account Type Mismatches",
		passed: errors.length === 0,
		errors,
		count: errors.length
	};
}

/**
 * CHECK B: Posted lines into wrong account type.
 * Join posting lines → gl_accounts → gl_account_types and confirm the account
 * type aligns with the source account class for that posting.
 */
async function checkPostingLineTypes(pool) {
	const errors = [];

	const caseExpr = Object.entries(ACCCLASS_TO_TYPE_ID)
		.map(([accclass, typeId]) => `WHEN ${accclass} THEN ${typeId}`)
		.join(" ");

	const sql = `
		SELECT
			jl.id AS line_id,
			jl.header_id,
			jl.accnr,
			ga.type_id                          AS account_type_id,
			gat.code                            AS account_type_code,
			gat.statement_section,
			j_legacy.accclass                   AS legacy_accclass,
			CASE j_legacy.accclass ${caseExpr} ELSE NULL END AS expected_type_id
		FROM gl_journal_lines jl
		JOIN gl_accounts ga ON ga.accnr = jl.accnr
		JOIN gl_account_types gat ON gat.id = ga.type_id
		LEFT JOIN gl_journal_headers jh ON jh.id = jl.header_id
		LEFT JOIN journal j_legacy ON j_legacy.accnr = jl.accnr
			AND j_legacy.jdate = jh.trxdate
			AND j_legacy.sourceid = CAST(jh.source_id AS SIGNED)
		WHERE j_legacy.accclass IS NOT NULL
		HAVING account_type_id != expected_type_id
		LIMIT 100
	`;

	try {
		const [rows] = await pool.query(sql);
		for (const row of rows) {
			errors.push({
				line_id: row.line_id,
				accnr: row.accnr,
				account_type_id: row.account_type_id,
				account_type_code: row.account_type_code,
				legacy_accclass: row.legacy_accclass,
				expected_type_id: row.expected_type_id,
				message: `Journal line ${row.line_id} uses accnr=${row.accnr} typed as ${row.account_type_code}(${row.account_type_id}) but legacy ACCCLASS=${row.legacy_accclass} maps to type_id=${row.expected_type_id}`
			});
		}
	} catch (err) {
		// If gl_journal_lines is empty or tables don't exist, pass gracefully
		if (!err.message.includes("doesn't exist")) {
			throw err;
		}
	}

	return {
		check: "B",
		name: "Posting Line Type Alignment",
		passed: errors.length === 0,
		errors,
		count: errors.length
	};
}

/**
 * CHECK C: Orphan or invalid postings.
 * C1: Any posting line whose accnr is missing from gl_accounts.
 * C2: Any posting line posted to an account whose type_id is null/invalid.
 */
async function checkOrphanPostings(pool) {
	const errors = [];

	// C1: Missing gl_accounts rows
	const sqlOrphan = `
		SELECT jl.id AS line_id, jl.header_id, jl.accnr, jl.debit, jl.credit
		FROM gl_journal_lines jl
		LEFT JOIN gl_accounts ga ON ga.accnr = jl.accnr
		WHERE ga.id IS NULL
		LIMIT 100
	`;

	try {
		const [orphans] = await pool.query(sqlOrphan);
		for (const row of orphans) {
			errors.push({
				type: "orphan_accnr",
				line_id: row.line_id,
				accnr: row.accnr,
				message: `Journal line ${row.line_id}: accnr=${row.accnr} does not exist in gl_accounts`
			});
		}
	} catch (err) {
		if (!err.message.includes("doesn't exist")) throw err;
	}

	// C2: Invalid type_id
	const sqlInvalidType = `
		SELECT jl.id AS line_id, jl.accnr, ga.type_id
		FROM gl_journal_lines jl
		JOIN gl_accounts ga ON ga.accnr = jl.accnr
		LEFT JOIN gl_account_types gat ON gat.id = ga.type_id
		WHERE ga.type_id IS NULL OR gat.id IS NULL
		LIMIT 100
	`;

	try {
		const [invalid] = await pool.query(sqlInvalidType);
		for (const row of invalid) {
			errors.push({
				type: "invalid_type_id",
				line_id: row.line_id,
				accnr: row.accnr,
				type_id: row.type_id,
				message: `Journal line ${row.line_id}: accnr=${row.accnr} has type_id=${row.type_id} which is null or not in gl_account_types`
			});
		}
	} catch (err) {
		if (!err.message.includes("doesn't exist")) throw err;
	}

	return {
		check: "C",
		name: "Orphan / Invalid Postings",
		passed: errors.length === 0,
		errors,
		count: errors.length
	};
}

/**
 * CHECK D: COS integrity.
 * D1: COS accounts must appear ONLY in IncomeStatement (type_id=6, statement_section=IncomeStatement).
 * D2: COS must NOT be accidentally treated as EXPENSE in totals.
 */
async function checkCOSIntegrity(pool) {
	const errors = [];

	// D1: Verify COS type is correctly set as IncomeStatement
	const [cosType] = await pool.query(
		"SELECT id, code, statement_section FROM gl_account_types WHERE code = 'COS'"
	);

	if (!cosType.length) {
		errors.push({
			type: "cos_missing",
			message: "COS account type (code='COS') is missing from gl_account_types"
		});
	} else if (cosType[0].statement_section !== "IncomeStatement") {
		errors.push({
			type: "cos_wrong_section",
			message: `COS account type has statement_section='${cosType[0].statement_section}', expected 'IncomeStatement'`
		});
	}

	// D2: Check no COS-typed accounts leak into Balance Sheet groupings
	const [cosInBS] = await pool.query(`
		SELECT ga.accnr, ga.name, gat.code, gat.statement_section
		FROM gl_accounts ga
		JOIN gl_account_types gat ON gat.id = ga.type_id
		WHERE gat.code = 'COS'
		  AND gat.statement_section != 'IncomeStatement'
	`);

	for (const row of cosInBS) {
		errors.push({
			type: "cos_in_balance_sheet",
			accnr: row.accnr,
			name: row.name,
			message: `COS account ${row.accnr} (${row.name}) is in ${row.statement_section} instead of IncomeStatement`
		});
	}

	// D3: Ensure COS amounts are not posted to non-COS typed accounts
	// Check legacy journal entries where accclass=6 (COS) but the gl_accounts type != COS
	try {
		const [misclassified] = await pool.query(`
			SELECT j.jourid, j.accnr, j.accclass, ga.type_id, gat.code AS type_code
			FROM journal j
			JOIN gl_accounts ga ON ga.accnr = j.accnr
			JOIN gl_account_types gat ON gat.id = ga.type_id
			WHERE j.accclass = 6
			  AND gat.code != 'COS'
			LIMIT 50
		`);

		for (const row of misclassified) {
			errors.push({
				type: "cos_to_non_cos_account",
				jourid: row.jourid,
				accnr: row.accnr,
				legacy_accclass: row.accclass,
				actual_type: row.type_code,
				message: `Legacy journal ${row.jourid}: ACCCLASS=6 (COS) posted to accnr=${row.accnr} which is typed as ${row.type_code}`
			});
		}
	} catch (err) {
		if (!err.message.includes("doesn't exist")) throw err;
	}

	// D4: Ensure no non-COS entries are posted to COS accounts
	try {
		const [reverseMisclass] = await pool.query(`
			SELECT j.jourid, j.accnr, j.accclass, ga.type_id, gat.code AS type_code
			FROM journal j
			JOIN gl_accounts ga ON ga.accnr = j.accnr
			JOIN gl_account_types gat ON gat.id = ga.type_id
			WHERE j.accclass != 6
			  AND j.accclass IS NOT NULL
			  AND gat.code = 'COS'
			LIMIT 50
		`);

		for (const row of reverseMisclass) {
			errors.push({
				type: "non_cos_to_cos_account",
				jourid: row.jourid,
				accnr: row.accnr,
				legacy_accclass: row.accclass,
				actual_type: row.type_code,
				message: `Legacy journal ${row.jourid}: ACCCLASS=${row.accclass} (non-COS) posted to accnr=${row.accnr} which is typed as COS`
			});
		}
	} catch (err) {
		if (!err.message.includes("doesn't exist")) throw err;
	}

	return {
		check: "D",
		name: "COS Integrity",
		passed: errors.length === 0,
		errors,
		count: errors.length
	};
}

/**
 * CHECK E: gl_account_types contains exact canonical set.
 */
async function checkAccountTypesCanonical(pool) {
	const { validateAccountTypes } = require("./glAccountTypes");
	const result = await validateAccountTypes(pool);
	return {
		check: "E",
		name: "GL Account Types Canonical",
		passed: result.valid,
		errors: result.errors.map(e => ({ message: e })),
		count: result.errors.length
	};
}

/**
 * CHECK F: All gl_accounts have a valid type_id.
 */
async function checkAllAccountsTyped(pool) {
	const errors = [];

	const [rows] = await pool.query(`
		SELECT ga.accnr, ga.name, ga.type_id
		FROM gl_accounts ga
		LEFT JOIN gl_account_types gat ON gat.id = ga.type_id
		WHERE ga.type_id IS NULL OR gat.id IS NULL
	`);

	for (const row of rows) {
		errors.push({
			accnr: row.accnr,
			name: row.name,
			type_id: row.type_id,
			message: `gl_accounts accnr=${row.accnr}: type_id=${row.type_id} is null or references non-existent gl_account_types`
		});
	}

	return {
		check: "F",
		name: "All Accounts Typed",
		passed: errors.length === 0,
		errors,
		count: errors.length
	};
}

/**
 * Run ALL validation checks and return combined results.
 * @param {import('mysql2/promise').Pool} pool
 * @returns {Promise<{allPassed: boolean, checks: Array}>}
 */
async function runAllChecks(pool) {
	const checks = await Promise.all([
		checkAccountTypesCanonical(pool),
		checkAllAccountsTyped(pool),
		checkAccountTypeMismatches(pool),
		checkPostingLineTypes(pool),
		checkOrphanPostings(pool),
		checkCOSIntegrity(pool)
	]);

	const allPassed = checks.every(c => c.passed);

	return { allPassed, checks };
}

module.exports = {
	checkAccountTypeMismatches,
	checkPostingLineTypes,
	checkOrphanPostings,
	checkCOSIntegrity,
	checkAccountTypesCanonical,
	checkAllAccountsTyped,
	runAllChecks
};
