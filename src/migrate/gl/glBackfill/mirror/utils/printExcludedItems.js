'use strict';

const { tenantQuery } = require('../database/database');
const logger = require('../lib/logger');

const DEFAULT_PRINT_EXCLUDED_ITEMS = 'YES';

// Stored as YES/NO in company_prefferences.print_excluded_items. Anything else
// (NULL on legacy rows, stray casing) means "print", so the disclosure is never
// dropped by accident.
function normalizePrintExcludedItems(value) {
	return String(value == null ? '' : value).trim().toUpperCase() === 'NO'
		? 'NO'
		: DEFAULT_PRINT_EXCLUDED_ITEMS;
}

/**
 * Whether this tenant prints the lines the customer asked to exclude on their
 * quotes and invoices. Unreadable preferences fall back to printing them.
 */
async function isPrintExcludedItemsEnabled(companyDb, schema, queryExecutor = tenantQuery) {
	if (!companyDb || !schema) return true;

	try {
		const rows = await queryExecutor(
			companyDb,
			`SELECT print_excluded_items
			 FROM ${schema}.company_prefferences
			 ORDER BY id ASC
			 LIMIT 1`
		);
		const row = rows && rows[0] ? rows[0] : null;
		if (!row) return true;
		return normalizePrintExcludedItems(row.print_excluded_items) !== 'NO';
	} catch (err) {
		// Tenants that have not run migration 189 yet simply keep printing.
		const isMissingColumn = err && (err.code === 'ER_BAD_FIELD_ERROR' || err.errno === 1054);
		if (!isMissingColumn) {
			logger.warn('Error reading print excluded items preference:', err && err.message ? err.message : err);
		}
		return true;
	}
}

/**
 * Whether the lines flagged "excluded from quote" carry cost on this tenant.
 *
 * The two settings describe two different things, which is why they are exact
 * opposites:
 *   - PRINT the excluded items  → the line is a customer-facing "you asked us to
 *     leave this out" note. Nothing was fitted and no work was done, so the line
 *     costs the workshop nothing and must never reach the GL.
 *   - HIDE the excluded items   → the line is absorbed into the job. The part is
 *     consumed and the work is done, it is simply not itemised for the customer,
 *     so its cost belongs to the job and must post to cost of sales.
 *
 * Neither mode ever bills an excluded line: they stay out of revenue, VAT and
 * the printed documents in both cases.
 */
async function areExcludedLinesCosted(companyDb, schema, queryExecutor = tenantQuery) {
	return !(await isPrintExcludedItemsEnabled(companyDb, schema, queryExecutor));
}

module.exports = {
	DEFAULT_PRINT_EXCLUDED_ITEMS,
	normalizePrintExcludedItems,
	isPrintExcludedItemsEnabled,
	areExcludedLinesCosted
};
