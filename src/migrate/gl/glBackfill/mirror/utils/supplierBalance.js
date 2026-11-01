// src/utils/supplierBalance.js
const { tenantQuery } = require('../database/database');
const { resolveSchema } = require('./schemaHelper');
const logger = require('../lib/logger');

function normalizeQueryFn(companyData, queryFn) {
	if (typeof queryFn === 'function') return queryFn;
	return (sql, params = []) => tenantQuery(companyData, sql, params);
}

async function getSupplierBalance(companyData, suppid, options = {}) {
	const schema = resolveSchema(companyData);
	const q = normalizeQueryFn(companyData, options.queryFn);

	const rows = await q(
		`SELECT ROUND(COALESCE(SUM(l.credit - l.debit), 0), 2) AS gl_balance
		 FROM ${schema}.gl_journal_lines l
		 WHERE l.suppid = ?
		   AND l.accnr = (
		       SELECT accnr FROM ${schema}.gl_control_accounts
		       WHERE control_key = 'AP' AND transaction_type = 'GENERIC' AND active = 1
		       LIMIT 1
		   )`,
		[suppid]
	);

	let n = parseFloat(rows[0]?.gl_balance ?? 0);
	if (!Number.isFinite(n) || Math.abs(n) > 1e12) return 0;
	return Number(n.toFixed(2));
}

//add a function to save the balance to the supplier table
async function saveSupplierBalance(companyData, suppid, balance, options = {}) {
	const schema = resolveSchema(companyData);
	// Coerce and clamp balance to a sensible numeric value before writing to DB
	let b = Number(balance) || 0;
	if (!Number.isFinite(b) || Math.abs(b) > 1e12) {
		logger.warn(`Attempted to save out-of-range supplier balance for SUPPID ${suppid}:`, balance);
		b = 0;
	}

	const q = normalizeQueryFn(companyData, options.queryFn);
	await q(
		`UPDATE ${schema}.suppliers SET balance = ? WHERE suppid = ?`,
		[b, suppid]
	);
}

async function recalculateSupplierBalance(companyData, suppid, options = {}) {
	const balance = await getSupplierBalance(companyData, suppid, options);
	await saveSupplierBalance(companyData, suppid, balance, options);
	return balance;
}

module.exports = {
	getSupplierBalance,
	saveSupplierBalance,
	recalculateSupplierBalance
};
