// src/utils/customerBalance.js
const { tenantQuery } = require('../database/database');
const { resolveSchema } = require('./schemaHelper');
const { resolveControlAccounts } = require('../lib/finance/postingEngine');
const { buildCustomerDmmArBalanceSql } = require('../services/dealer/dealerDebtor.service');

// customer_credits (migration 072) and dealer_accounting_postings (migration 088)
// are the only optional debtor sources. Every supported tenant schema carries
// both, so the combined statement is the path production always takes; a schema
// that predates either migration reports one of these codes and is served by the
// compatibility path in loadBalanceRows().
const OPTIONAL_SOURCE_ERROR_CODES = new Set(['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR']);
const OPTIONAL_SOURCE_TABLES = ['customer_credits', 'dealer_accounting_postings'];

function normalizeQueryFn(companyDb, queryFn) {
	if (typeof queryFn === 'function') return queryFn;
	return (sql, params = []) => tenantQuery(companyDb, sql, params);
}

async function getCustomerBalance(companyData, cid, options = {}) {
	const customerId = Number.parseInt(cid, 10);
	const balances = await getCustomerBalances(companyData, [customerId], options);
	return balances.get(customerId) || 0;
}

function normalizeCustomerIds(cids) {
	return [...new Set((Array.isArray(cids) ? cids : [cids])
		.map((value) => Number.parseInt(value, 10))
		.filter((value) => Number.isFinite(value) && value > 0))];
}

function toAmount(value) {
	const amount = Number.parseFloat(value);
	return Number.isFinite(amount) ? amount : 0;
}

function round2(value) {
	return Math.round((Number(value) || 0) * 100) / 100;
}

function readRowCid(row, balances) {
	return row.cid === undefined && balances.size === 1
		? balances.keys().next().value
		: Number.parseInt(row.cid, 10);
}

// ── Debtor balance components ──────────────────────────────────────────────
// One fragment per accounting source, each aggregating to a single row per
// customer. They are written once here and composed into the combined statement,
// so a legacy schema missing an optional source is served by the same SQL with
// that source left out rather than by a second copy of the accounting rules.

// Whether one invoice row (alias `i`) is an open debtor document whose
// "total - paid" counts toward the customer's balance. Shared with the read-only
// Customer Invoice Register so its per-invoice outstanding follows these rules.
function openInvoiceConditionSql(schema) {
	return `(i.status IS NULL OR UPPER(i.status) NOT IN ('VOID', 'QUOTE', 'SPLIT'))
		     -- A historical invoice's own total is not a debtor: the legacy sale was
		     -- never posted here. Only the amount actually brought into Accounts
		     -- Receivable by a posted DEBTOR_OPENING_BALANCE journal counts, and
		     -- since invoices.paid carries legacy_paid_before_cutover that is exactly
		     -- what "total - paid" evaluates to. An unposted opening debtor
		     -- contributes nothing, so the subledger can never lead the GL.
		     AND (
		         COALESCE(i.is_historical_import, 0) = 0
		         OR UPPER(TRIM(COALESCE(i.opening_debtor_status, 'NOT_REQUIRED'))) = 'POSTED'
		     )
		     AND NOT EXISTS (
		         SELECT 1 FROM ${schema}.job_information j
		         WHERE j.job_number = i.job_number
		           AND UPPER(COALESCE(j.status, '')) = 'QUOTE'
		     )
		     -- A credit note already applied to its original invoice as a
		     -- CREDIT_NOTE adjustment lives inside that invoice's paid.
		     AND NOT EXISTS (
		         SELECT 1 FROM ${schema}.invoice_adjustments ia
		         WHERE ia.cid = i.cid
		           AND ia.adjustment_type = 'CREDIT_NOTE'
		           AND ia.ref_invoice_nr = i.invoice_nr
		     )`;
}

function openInvoiceSql(schema, placeholders) {
	return `SELECT i.cid,
		          SUM(CAST(i.inv_totalinclvat AS DECIMAL(18,2)) - COALESCE(i.paid, 0)) AS open_invoice_total
		   FROM ${schema}.invoices i
		   WHERE i.cid IN (${placeholders})
		     AND ${openInvoiceConditionSql(schema)}
		   GROUP BY i.cid`;
}

// A receipt carried on an invoice that was superseded by a split stays a debtor
// credit, so it is deducted from the open invoice total.
function splitReceiptSql(schema, placeholders) {
	return `SELECT original.cid, SUM(COALESCE(original.paid, 0)) AS split_receipt_total
		   FROM ${schema}.invoices original
		   WHERE original.cid IN (${placeholders})
		     AND UPPER(COALESCE(original.status, '')) = 'SPLIT'
		     AND original.split_group_id IS NOT NULL
		   GROUP BY original.cid`;
}

function debtorAdjustmentSql(schema, placeholders) {
	return `SELECT mh.cid, ROUND(COALESCE(SUM(l.debit - l.credit), 0), 2) AS adjustment_balance
		   FROM ${schema}.manual_journal_headers mh
		   JOIN ${schema}.manual_journal_lines l ON l.header_id = mh.id
		   JOIN ${schema}.gl_journal_headers h ON h.id = mh.posted_gl_header_id
		   WHERE mh.journal_type = 'DEBTOR_ADJUSTMENT'
		     AND mh.status = 'POSTED'
		     AND mh.cid IN (${placeholders})
		     AND h.status = 'POSTED'
		     AND h.source = 'MANUAL_DEBTOR_ADJUSTMENT'
		     AND l.accnr = ?
		     AND l.cid = mh.cid
		   GROUP BY mh.cid`;
}

function unappliedCreditSql(schema, placeholders) {
	return `SELECT cid, COALESCE(SUM(amount_remaining), 0) AS credit_remaining
		   FROM ${schema}.customer_credits
		   WHERE cid IN (${placeholders}) AND status <> 'REVERSED'
		   GROUP BY cid`;
}

/**
 * One statement returning every authoritative debtor component per customer:
 * open invoices less carried split receipts, posted manual debtor journals,
 * posted DMM vehicle-sale AR exposure, and unapplied customer credit. The four
 * components stay separate columns and are summed in JavaScript so that the
 * existing per-component rounding order — and with it the cent-exact result —
 * survives the consolidation unchanged.
 */
function buildCombinedBalanceQuery(schema, customerIds, { arAccount, includeCredit, includeDmm }) {
	const placeholders = customerIds.map(() => '?').join(',');
	const params = [...customerIds, ...customerIds, ...customerIds, arAccount];
	const joins = [
		`LEFT JOIN (${openInvoiceSql(schema, placeholders)}) open_invoices ON open_invoices.cid = c.cid`,
		`LEFT JOIN (${splitReceiptSql(schema, placeholders)}) split_receipts ON split_receipts.cid = c.cid`,
		`LEFT JOIN (${debtorAdjustmentSql(schema, placeholders)}) debtor_adjustments ON debtor_adjustments.cid = c.cid`
	];
	let dmmBalance = '0';
	if (includeDmm) {
		joins.push(`LEFT JOIN (${buildCustomerDmmArBalanceSql(schema, placeholders)}) dmm_postings ON dmm_postings.cid = c.cid`);
		params.push(...customerIds);
		dmmBalance = 'COALESCE(dmm_postings.dmm_ar, 0)';
	}
	let unappliedCredit = '0';
	if (includeCredit) {
		joins.push(`LEFT JOIN (${unappliedCreditSql(schema, placeholders)}) customer_credit ON customer_credit.cid = c.cid`);
		params.push(...customerIds);
		unappliedCredit = 'COALESCE(customer_credit.credit_remaining, 0)';
	}
	params.push(...customerIds);
	const sql = `SELECT c.cid,
		        ROUND(COALESCE(open_invoices.open_invoice_total, 0)
		              - COALESCE(split_receipts.split_receipt_total, 0), 2) AS invoice_balance,
		        COALESCE(debtor_adjustments.adjustment_balance, 0) AS adjustment_balance,
		        ${dmmBalance} AS dmm_balance,
		        ${unappliedCredit} AS unapplied_credit
		 FROM ${schema}.customers c
		 ${joins.join('\n\t\t ')}
		 WHERE c.cid IN (${placeholders})`;
	return { sql, params };
}

// Which optional debtor sources this tenant actually carries. Only consulted
// after the combined statement has already failed on a missing table or column.
async function findPresentOptionalSources(q, schema) {
	const rows = await q(
		`SELECT LOWER(table_name) AS table_name
		 FROM information_schema.tables
		 WHERE table_schema = ? AND table_name IN (?, ?)`,
		[schema, ...OPTIONAL_SOURCE_TABLES]
	);
	return new Set((rows || []).map((row) => String(row.table_name || '').toLowerCase()));
}

/**
 * The combined balance read: one round-trip on every supported tenant. A schema
 * missing an optional source table is identified once and re-read with that
 * source left out, which keeps the long-standing "absent table contributes zero"
 * behaviour without letting a real accounting failure pass as a zero balance.
 */
async function loadBalanceRows(q, schema, customerIds, { arAccount, includeCredit }) {
	const combined = buildCombinedBalanceQuery(schema, customerIds, {
		arAccount,
		includeCredit,
		includeDmm: true
	});
	try {
		return await q(combined.sql, combined.params);
	} catch (err) {
		if (!err || !OPTIONAL_SOURCE_ERROR_CODES.has(err.code)) throw err;
		const present = await findPresentOptionalSources(q, schema);
		const missing = OPTIONAL_SOURCE_TABLES.filter((table) => !present.has(table));
		// Both optional sources are present, so the failure belongs to a required
		// accounting table and must surface rather than read as a zero balance.
		if (!missing.length) throw err;
		const reduced = buildCombinedBalanceQuery(schema, customerIds, {
			arAccount,
			includeCredit: includeCredit && !missing.includes('customer_credits'),
			includeDmm: !missing.includes('dealer_accounting_postings')
		});
		return q(reduced.sql, reduced.params);
	}
}

/**
 * Calculate authoritative debtor balances for many customers in one tenant-scoped
 * round-trip. This is the batch equivalent of getCustomerBalance: invoice ledger
 * + manual debtor journals + DMM AR less unapplied customer credit.
 */
async function getCustomerBalances(companyData, cids, options = {}) {
	const customerIds = normalizeCustomerIds(cids);
	const balances = new Map(customerIds.map((cid) => [cid, 0]));
	if (!customerIds.length) return balances;

	const schema = resolveSchema(companyData);
	const q = normalizeQueryFn(companyData, options.queryFn);
	const includeCredit = options.includeCredit !== false;
	const resolveControls = typeof options.resolveControlAccountsFn === 'function'
		? options.resolveControlAccountsFn
		: resolveControlAccounts;
	const controls = await resolveControls(schema, ['AR']);

	const rows = await loadBalanceRows(q, schema, customerIds, {
		arAccount: controls.AR,
		includeCredit
	});
	for (const row of rows || []) {
		const cid = readRowCid(row, balances);
		if (!balances.has(cid)) continue;
		const invoiceBalance = toAmount(row.invoice_balance);
		const adjustmentBalance = toAmount(row.adjustment_balance);
		const dmmBalance = round2(toAmount(row.dmm_balance));
		const unappliedCredit = includeCredit ? toAmount(row.unapplied_credit) : 0;
		balances.set(cid, invoiceBalance + adjustmentBalance + dmmBalance - unappliedCredit);
	}
	for (const [cid, amount] of balances) balances.set(cid, round2(amount));
	return balances;
}

//add a function to save the balance to the customer table
async function saveCustomerBalance(companyData, cid, balance, options = {}) {
	// Coerce and clamp the persisted value to avoid DB numeric overflow
	let n = typeof balance === 'string' ? parseFloat(balance) : Number(balance);
	if (!Number.isFinite(n)) n = 0;
	n = Math.round(n * 100) / 100; // 2 decimals
	const MAX_DEC_18_2 = 9999999999999999.99;
	if (n > MAX_DEC_18_2) n = MAX_DEC_18_2;
	if (n < -MAX_DEC_18_2) n = -MAX_DEC_18_2;

	const schema = resolveSchema(companyData);
	const q = normalizeQueryFn(companyData, options.queryFn);
	await q(`UPDATE ${schema}.customers SET balance = ? WHERE cid = ?`, [n, cid]);
}

async function recalculateCustomerBalance(companyData, cid, options = {}) {
	const balance = await getCustomerBalance(companyData, cid, options);
	await saveCustomerBalance(companyData, cid, balance, options);
	return balance;
}

module.exports = {
	getCustomerBalance,
	getCustomerBalances,
	saveCustomerBalance,
	recalculateCustomerBalance,
	openInvoiceConditionSql
};
