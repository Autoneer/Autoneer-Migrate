'use strict';
/**
 * dealerDebtor.service.js
 *
 * DMM Phase 7.1 — bridges posted DMM vehicle sales into the EXISTING AUTONEER
 * debtor surfaces (customer balance, debtor ageing, customer statement) so a
 * customer has one operational debtor view across the platform.
 *
 * Single source of truth: dealer_accounting_postings (written by Phase 7's
 * dealerAccounting.service). Only AR-affecting, POSTED rows contribute:
 *   SALE_INVOICE        → debits Debtors (AR)  → increases the customer balance
 *   DEPOSIT_ALLOCATION  → credits Debtors (AR) → decreases the customer balance
 *   DEAL_PAYMENT        → credits Debtors (AR) → decreases the customer balance
 *                         (post-sale receipt; Phase 7.2)
 *   FNI_PRODUCT_SALE    → debits Debtors (AR)  → increases the customer balance
 *                         (manual F&I product posting; Phase 9)
 * A reversal flips the relevant posting row to REVERSED, so it drops out of every
 * query here automatically — balance, ageing and statement all self-correct.
 *
 * This guarantees there is no double counting: these figures come exclusively
 * from DMM posting rows (a distinct table and distinct GL sources), never from
 * the invoices ledger, workshop GL sources, customer_credits, or DMM deal/payment
 * rows. The existing workshop debtor queries are untouched.
 *
 * Every helper is tenant-safe (schema-qualified) and degrades to a zero/empty
 * result when the DMM accounting table is absent (module not enabled / pre-Phase 7
 * tenant), so workshop-only tenants are never affected.
 */

const { tenantQuery } = require('../../database/database');
const { resolveSchema } = require('../../utils/schemaHelper');

const AR_POSTING_TYPES = "('SALE_INVOICE','DEPOSIT_ALLOCATION','DEAL_PAYMENT','FNI_PRODUCT_SALE')";
const FNI_AR_AMOUNT_SQL = `COALESCE((
	SELECT ROUND(SUM(l.debit - l.credit), 2)
	FROM \`__SCHEMA__\`.gl_journal_lines l
	WHERE l.header_id = p.gl_header_id
	  AND l.cid = p.customer_id
	  AND l.debit > 0
), p.amount)`;
// Signed contribution to the debtor (AR) balance per AR-affecting posting type.
function arAmountSql(schema) {
	return FNI_AR_AMOUNT_SQL.replace(/__SCHEMA__/g, schema);
}

function arSignSql(schema) {
	const fniArAmount = arAmountSql(schema);
	return `CASE
	WHEN p.posting_type = 'SALE_INVOICE' THEN p.amount
	WHEN p.posting_type = 'FNI_PRODUCT_SALE' THEN ${fniArAmount}
	WHEN p.posting_type = 'DEPOSIT_ALLOCATION' THEN -p.amount
	WHEN p.posting_type = 'DEAL_PAYMENT' THEN -p.amount
	ELSE 0 END`;
}

function statementAmountSql(schema) {
	const fniArAmount = arAmountSql(schema);
	return `CASE WHEN p.posting_type = 'FNI_PRODUCT_SALE' THEN ${fniArAmount} ELSE p.amount END`;
}

function round2(value) {
	return Math.round((Number(value) || 0) * 100) / 100;
}

// Run a query, treating "table/column does not exist" as an empty result so that
// tenants without the DMM accounting schema keep working unchanged.
async function safeQuery(runQuery, sql, params) {
	try {
		return await runQuery(sql, params);
	} catch (err) {
		if (err && (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_FIELD_ERROR')) return null;
		throw err;
	}
}

function normalizeQueryFn(companyDb, queryFn) {
	if (typeof queryFn === 'function') return queryFn;
	return (sql, params = []) => tenantQuery(companyDb, sql, params);
}

/**
 * Net posted DMM debtor (AR) exposure for one customer.
 * = Σ posted SALE_INVOICE − Σ posted DEPOSIT_ALLOCATION (reversed rows excluded).
 */
async function getCustomerDmmArBalance(companyDb, cid, options = {}) {
	const schema = options.schema || resolveSchema(companyDb);
	const runQuery = normalizeQueryFn(companyDb, options.queryFn);
	const rows = await safeQuery(
		runQuery,
		`SELECT COALESCE(SUM(${arSignSql(schema)}), 0) AS dmm_ar
		 FROM \`${schema}\`.dealer_accounting_postings p
		 WHERE p.customer_id = ? AND p.status = 'POSTED'
		   AND p.posting_type IN ${AR_POSTING_TYPES}`,
		[cid]
	);
	if (!rows) return 0;
	return round2(rows[0] ? rows[0].dmm_ar : 0);
}

/**
 * Aggregate SQL for the net posted DMM debtor (AR) exposure of each listed
 * customer, one row per customer. Exported so the shared customer balance read
 * can fold DMM exposure into its single round-trip without restating the AR sign
 * rules; `placeholders` is the caller's `?` list for the customer ids.
 */
function buildCustomerDmmArBalanceSql(schema, placeholders) {
	return `SELECT p.customer_id AS cid, COALESCE(SUM(${arSignSql(schema)}), 0) AS dmm_ar
		 FROM \`${schema}\`.dealer_accounting_postings p
		 WHERE p.customer_id IN (${placeholders}) AND p.status = 'POSTED'
		   AND p.posting_type IN ${AR_POSTING_TYPES}
		 GROUP BY p.customer_id`;
}

async function getCustomerDmmArBalances(companyDb, cids, options = {}) {
	const customerIds = [...new Set((Array.isArray(cids) ? cids : [cids])
		.map((value) => Number.parseInt(value, 10))
		.filter((value) => Number.isFinite(value) && value > 0))];
	const balances = new Map(customerIds.map((cid) => [cid, 0]));
	if (!customerIds.length) return balances;
	const schema = options.schema || resolveSchema(companyDb);
	const runQuery = normalizeQueryFn(companyDb, options.queryFn);
	const placeholders = customerIds.map(() => '?').join(',');
	const rows = await safeQuery(
		runQuery,
		buildCustomerDmmArBalanceSql(schema, placeholders),
		customerIds
	);
	for (const row of rows || []) {
		const cid = Number.parseInt(row.cid, 10);
		if (balances.has(cid)) balances.set(cid, round2(row.dmm_ar));
	}
	return balances;
}

/**
 * Posted DMM vehicle-sale debtor rows shaped to merge into accounts.buildAgeing.
 * One row per deal with a non-zero net AR balance as at `asat`. The ageing date is
 * the deal date (= the sale-invoice posting date).
 *
 * @param {object} opts
 * @param {string} opts.schema
 * @param {string} opts.asat   YYYY-MM-DD as-at date
 * @param {number} [opts.cid]  Optional single-customer filter
 */
async function getDmmDebtorAgeingRows(companyDb, { schema, asat, cid = null, cids = null } = {}) {
	const resolvedSchema = schema || resolveSchema(companyDb);
	const runQuery = (sql, params = []) => tenantQuery(companyDb, sql, params);
	const params = [asat, asat];
	let cidFilter = '';
	const customerIds = [...new Set((Array.isArray(cids) ? cids : [])
		.map((value) => Number.parseInt(value, 10))
		.filter((value) => Number.isFinite(value) && value > 0))];
	if (cid) {
		cidFilter = ' AND d.customer_id = ?';
		params.push(Number.parseInt(cid, 10));
	} else if (customerIds.length) {
		cidFilter = ` AND d.customer_id IN (${customerIds.map(() => '?').join(',')})`;
		params.push(...customerIds);
	}
	const rows = await safeQuery(
		runQuery,
		`SELECT d.deal_number AS doc_no,
			d.deal_date AS doc_date,
			COALESCE(SUM(${arSignSql(resolvedSchema)}), 0) AS total,
			0 AS paid,
			c.name AS party_name, c.surname AS party_surname,
			d.customer_id AS party_id,
			DATEDIFF(?, d.deal_date) AS days_out
		 FROM \`${resolvedSchema}\`.dealer_accounting_postings p
		 JOIN \`${resolvedSchema}\`.dealer_vehicle_deals d ON d.id = p.deal_id
		 LEFT JOIN \`${resolvedSchema}\`.customers c ON c.cid = d.customer_id
		 WHERE p.status = 'POSTED'
		   AND p.posting_type IN ${AR_POSTING_TYPES}
		   AND p.trxdate <= ?${cidFilter}
		 GROUP BY d.id, d.deal_number, d.deal_date, c.name, c.surname, d.customer_id
		 HAVING ABS(COALESCE(SUM(${arSignSql(resolvedSchema)}), 0)) >= 0.005`,
		params
	);
	return (rows || []).map((r) => ({
		doc_no: r.doc_no,
		doc_date: r.doc_date,
		total: round2(r.total),
		paid: 0,
		party_name: r.party_name,
		party_surname: r.party_surname,
		party_id: r.party_id,
		days_out: Number(r.days_out) || 0,
		is_dmm: true
	}));
}

/**
 * Posted DMM AR postings for one customer, ordered for a running-balance
 * statement. SALE_INVOICE → debit; DEPOSIT_ALLOCATION → credit. Reversed rows are
 * excluded (matching the existing statement treatment of reversed credits).
 */
async function getCustomerDmmStatementEntries(companyDb, cid, options = {}) {
	const schema = options.schema || resolveSchema(companyDb);
	const runQuery = normalizeQueryFn(companyDb, options.queryFn);
	const rows = await safeQuery(
		runQuery,
		`SELECT p.posting_type, ${statementAmountSql(schema)} AS amount, p.trxdate, d.deal_number, d.id AS deal_id
		 FROM \`${schema}\`.dealer_accounting_postings p
		 JOIN \`${schema}\`.dealer_vehicle_deals d ON d.id = p.deal_id
		 WHERE p.customer_id = ? AND p.status = 'POSTED'
		   AND p.posting_type IN ${AR_POSTING_TYPES}
		 ORDER BY p.trxdate ASC, p.id ASC`,
		[cid]
	);
	return (rows || []).map((r) => ({
		posting_type: r.posting_type,
		amount: round2(r.amount),
		date: r.trxdate,
		deal_number: r.deal_number,
		deal_id: r.deal_id
	}));
}

async function getCustomerDmmStatementEntriesForCustomers(companyDb, cids, options = {}) {
	const customerIds = [...new Set((Array.isArray(cids) ? cids : [cids])
		.map((value) => Number.parseInt(value, 10))
		.filter((value) => Number.isFinite(value) && value > 0))];
	if (!customerIds.length) return [];
	const schema = options.schema || resolveSchema(companyDb);
	const runQuery = normalizeQueryFn(companyDb, options.queryFn);
	const placeholders = customerIds.map(() => '?').join(',');
	const rows = await safeQuery(
		runQuery,
		`SELECT p.customer_id AS cid, p.posting_type, ${statementAmountSql(schema)} AS amount,
		        p.trxdate, d.deal_number, d.id AS deal_id
		 FROM \`${schema}\`.dealer_accounting_postings p
		 JOIN \`${schema}\`.dealer_vehicle_deals d ON d.id = p.deal_id
		 WHERE p.customer_id IN (${placeholders}) AND p.status = 'POSTED'
		   AND p.posting_type IN ${AR_POSTING_TYPES}
		 ORDER BY p.customer_id, p.trxdate ASC, p.id ASC`,
		customerIds
	);
	return (rows || []).map((r) => ({
		cid: Number(r.cid),
		posting_type: r.posting_type,
		amount: round2(r.amount),
		date: r.trxdate,
		deal_number: r.deal_number,
		deal_id: r.deal_id
	}));
}

module.exports = {
	buildCustomerDmmArBalanceSql,
	getCustomerDmmArBalance,
	getCustomerDmmArBalances,
	getDmmDebtorAgeingRows,
	getCustomerDmmStatementEntries,
	getCustomerDmmStatementEntriesForCustomers
};
