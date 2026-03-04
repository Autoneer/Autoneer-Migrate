/**
 * Authoritative GL Account Type Mapping
 * ======================================
 * This module is the SINGLE SOURCE OF TRUTH for mapping Firebird account classes
 * (ACCCLASS) to MySQL gl_account_types.
 *
 * Non-negotiable rules:
 *  - Every migrated account MUST have a deterministic type_id.
 *  - No "best effort" mapping is acceptable.
 *  - If an account cannot be typed, migration MUST fail loudly.
 *
 * Source (Firebird) ACCCLASS → Target (MySQL) gl_account_types
 * ─────────────────────────────────────────────────────────────
 *  CLASSID 1  REVENUE      → id=1  INCOME      IncomeStatement
 *  CLASSID 2  EXPENSES     → id=2  EXPENSE     IncomeStatement
 *  CLASSID 3  ASSETS       → id=3  ASSET       BalanceSheet
 *  CLASSID 4  EQUITY       → id=4  EQUITY      BalanceSheet
 *  CLASSID 5  LIABILITIES  → id=5  LIABILITY   BalanceSheet
 *  CLASSID 6  COS          → id=6  COS         IncomeStatement
 */

"use strict";

/**
 * Canonical GL account types.  The `id` values are authoritative —
 * the seed SQL uses INSERT … ON DUPLICATE KEY UPDATE so the rows
 * are idempotent and always converge to this exact set.
 */
const GL_ACCOUNT_TYPES = Object.freeze([
	{ id: 1, code: "INCOME", statement_section: "IncomeStatement", display_order: 1, firebird_classid: 1, firebird_label: "REVENUE" },
	{ id: 2, code: "EXPENSE", statement_section: "IncomeStatement", display_order: 2, firebird_classid: 2, firebird_label: "EXPENSES" },
	{ id: 3, code: "ASSET", statement_section: "BalanceSheet", display_order: 3, firebird_classid: 3, firebird_label: "ASSETS" },
	{ id: 4, code: "EQUITY", statement_section: "BalanceSheet", display_order: 4, firebird_classid: 4, firebird_label: "EQUITY" },
	{ id: 5, code: "LIABILITY", statement_section: "BalanceSheet", display_order: 5, firebird_classid: 5, firebird_label: "LIABILITIES" },
	{ id: 6, code: "COS", statement_section: "IncomeStatement", display_order: 6, firebird_classid: 6, firebird_label: "COS" }
]);

/** Map from Firebird ACCCLASS integer → gl_account_types.id */
const ACCCLASS_TO_TYPE_ID = Object.freeze(
	GL_ACCOUNT_TYPES.reduce((map, t) => {
		map[t.firebird_classid] = t.id;
		return map;
	}, {})
);

/** Map from gl_account_types.id → canonical record */
const TYPE_ID_MAP = Object.freeze(
	GL_ACCOUNT_TYPES.reduce((map, t) => {
		map[t.id] = t;
		return map;
	}, {})
);

/** Codes that belong to the Income Statement */
const INCOME_STATEMENT_TYPE_IDS = Object.freeze(
	GL_ACCOUNT_TYPES.filter(t => t.statement_section === "IncomeStatement").map(t => t.id)
);

/** Codes that belong to the Balance Sheet */
const BALANCE_SHEET_TYPE_IDS = Object.freeze(
	GL_ACCOUNT_TYPES.filter(t => t.statement_section === "BalanceSheet").map(t => t.id)
);

/**
 * Resolve type_id from a Firebird ACCCLASS value.
 * @param {number|string} accclass - The ACCCLASS value from Firebird.
 * @returns {number} The gl_account_types.id
 * @throws {Error} If accclass cannot be deterministically mapped.
 */
function resolveTypeId(accclass) {
	const cls = Number(accclass);
	if (Number.isNaN(cls) || !ACCCLASS_TO_TYPE_ID.hasOwnProperty(cls)) {
		throw new Error(
			`GL HARD FAIL: Cannot map Firebird ACCCLASS=${JSON.stringify(accclass)} to any gl_account_types.id. ` +
			`Valid ACCCLASS values are: ${Object.keys(ACCCLASS_TO_TYPE_ID).join(", ")}. ` +
			`Migration cannot continue — every account MUST have a deterministic type.`
		);
	}
	return ACCCLASS_TO_TYPE_ID[cls];
}

/**
 * Build idempotent SQL to seed gl_account_types with the authoritative set.
 * Uses INSERT … ON DUPLICATE KEY UPDATE so it is safe to run repeatedly.
 */
function buildSeedSQL() {
	const rows = GL_ACCOUNT_TYPES.map(t =>
		`(${t.id}, '${t.code}', '${t.statement_section}', ${t.display_order})`
	).join(",\n  ");

	return `-- Authoritative gl_account_types seed (idempotent)
INSERT INTO gl_account_types (id, code, statement_section, display_order)
VALUES
  ${rows}
ON DUPLICATE KEY UPDATE
  code = VALUES(code),
  statement_section = VALUES(statement_section),
  display_order = VALUES(display_order);`;
}

/**
 * Seed gl_account_types into the given MySQL pool.
 * Idempotent — safe to call multiple times.
 * @param {import('mysql2/promise').Pool} pool
 */
async function seedAccountTypes(pool) {
	// Use individual inserts to ensure exact id values (avoids auto_increment gaps)
	for (const t of GL_ACCOUNT_TYPES) {
		await pool.query(
			`INSERT INTO gl_account_types (id, code, statement_section, display_order)
			 VALUES (?, ?, ?, ?)
			 ON DUPLICATE KEY UPDATE
			   code = VALUES(code),
			   statement_section = VALUES(statement_section),
			   display_order = VALUES(display_order)`,
			[t.id, t.code, t.statement_section, t.display_order]
		);
	}
}

/**
 * Validate that gl_account_types in the database matches the authoritative set exactly.
 * @param {import('mysql2/promise').Pool} pool
 * @returns {Promise<{valid: boolean, errors: string[]}>}
 */
async function validateAccountTypes(pool) {
	const errors = [];

	const [rows] = await pool.query(
		"SELECT id, code, statement_section, display_order FROM gl_account_types ORDER BY id"
	);

	// Check for exact match
	const dbMap = new Map(rows.map(r => [r.id, r]));

	for (const expected of GL_ACCOUNT_TYPES) {
		const actual = dbMap.get(expected.id);
		if (!actual) {
			errors.push(`Missing gl_account_types row: id=${expected.id} code=${expected.code}`);
			continue;
		}
		if (actual.code !== expected.code) {
			errors.push(`gl_account_types id=${expected.id}: expected code='${expected.code}', got '${actual.code}'`);
		}
		if (actual.statement_section !== expected.statement_section) {
			errors.push(`gl_account_types id=${expected.id}: expected statement_section='${expected.statement_section}', got '${actual.statement_section}'`);
		}
	}

	// Check for unexpected rows
	for (const row of rows) {
		if (!TYPE_ID_MAP[row.id]) {
			errors.push(`Unexpected gl_account_types row: id=${row.id} code=${row.code} — not in authoritative set`);
		}
	}

	return { valid: errors.length === 0, errors };
}

module.exports = {
	GL_ACCOUNT_TYPES,
	ACCCLASS_TO_TYPE_ID,
	TYPE_ID_MAP,
	INCOME_STATEMENT_TYPE_IDS,
	BALANCE_SHEET_TYPE_IDS,
	resolveTypeId,
	buildSeedSQL,
	seedAccountTypes,
	validateAccountTypes
};
