// Copied from AUTONEER-PWA (964ba34f) and now Migrate's own: the GL backfill runs
// only in Migrate, so changes are made here and mirrorSync never overwrites them.
const logger = require('../logger');
const { tenantQuery, companyTransaction, runInCompanyTx } = require('../../database/database');
const { postJournal, ensureGlSchemaSeed, ensureDefaultPeriods, validateLines, getJournalBySource, deleteGlJournalBySource, getOpenPeriodId, resolveControlAccounts } = require('./postingEngine');
const { resolveStockGlAccounts } = require('./stockGlResolver');
const { getSchema } = require('../../utils/schemaHelper');
const { recalculateCustomerBalance } = require('../../utils/customerBalance');
const { getSupplierBalance, saveSupplierBalance } = require('../../utils/supplierBalance');
const { costedLineSql, getJobWipDebitedTotal } = require('../../services/finalise/finalise.service');
const { areExcludedLinesCosted } = require('../../utils/printExcludedItems');
const { normalizeJobNumber, resolveCreditorInvoiceLineAccount, resolveSupplierAssetControls } = require('../../services/suppliers/supplierInvoices.service');
const rebuildStockAccounting = require('./rebuildStockAccounting');
const { requireSupplierWipAccount } = require('./supplierWipControl');
const { isWorkshopAsset } = require('../../utils/stockClassification');
const { COS_REF: LABOUR_COS_REF, OFFSET_REF: LABOUR_OFFSET_REF, buildWorkshopLabourCostLines } = require('./workshopLabourCost');

// Rebuild capitalisation runs after supplier invoices (so supplier-funded WIP
// exists before a rebuild relieves it) and before customer invoices (so the
// rebuilt unit is in Inventory before a later sale credits it out again).
const BACKFILL_TYPE_ORDER = Object.freeze(['CREDITOR_INVOICE', 'REBUILD_STOCK', 'DEBTOR_INVOICE', 'DEBTOR_PAYMENT', 'CREDITOR_PAYMENT']);

/**
 * Tables and conditions shared by every REBUILD_STOCK backfill query: stocked
 * rebuilds (alias r) with their own AUTONEER_REBUILD listed unit (alias u),
 * completed within [from, to]. The WHERE fragment takes two params: fromDate, toDate.
 */
function rebuildStockBackfillTablesSql(schema) {
	return `${schema}.stock_rebuild_jobs r
		JOIN ${schema}.stock_listed_units u
		  ON u.id = r.listed_unit_id
		 AND u.source_rebuild_job_number = r.job_number`;
}

const REBUILD_STOCK_BACKFILL_WHERE_SQL = `r.status = 'STOCKED'
		  AND u.origin_type = 'AUTONEER_REBUILD'
		  AND r.completed_at IS NOT NULL
		  AND DATE(r.completed_at) BETWEEN ? AND ?`;

// CUSTOMER CREDIT rows mirror deposit allocations — their GL is posted by the
// customerCredit service under source CREDIT_ALLOCATION, never as a bank receipt.
const PAYMENT_BACKFILL_EXCLUSION_SQL = `UPPER(TRIM(COALESCE(p.paymethod, ''))) NOT IN ('INVOICE', 'INTERNAL' , 'WARRANTY', 'REFUND','SERVICE PLAN','REVERSED','ROUNDING','CUSTOMER CREDIT')`;
// Legacy imports mark a voided supplier payment REVERSED and keep its re-capture
// as a separate row; the invoice's paid amount counts only the re-capture. The
// PWA never writes this status, and supplier balances already skip these rows.
const SUPPLIER_PAYMENT_BACKFILL_SQL = `${PAYMENT_BACKFILL_EXCLUSION_SQL} AND UPPER(TRIM(COALESCE(p.status, ''))) <> 'REVERSED'`;
// Customer payments. Legacy imports also keep the non-cash settlements INTERNAL,
// WARRANTY, SERVICE PLAN, ROUNDING and REFUND as payment rows, and the legacy
// system credited Accounts Receivable for each, so they post too (see
// legacySettlementType). INVOICE only marked a job released on account.
const DEBTOR_PAYMENT_BACKFILL_SQL = `UPPER(TRIM(COALESCE(p.paymethod, ''))) NOT IN ('INVOICE', 'REVERSED', 'CUSTOMER CREDIT')`;
const LEGACY_PAYMENT_ADJUSTMENT_SQL = `UPPER(TRIM(COALESCE(p.paymethod, ''))) IN ('DISCOUNT', 'BAD DEBT', 'BAD_DEBT', 'BAD-DEBT', 'BADDEBT', 'WRITE OFF', 'WRITE_OFF', 'WRITE-OFF', 'WRITEOFF', 'CREDIT NOTE', 'CREDIT_NOTE', 'CREDIT-NOTE', 'CREDITNOTE')`;
const DEBTOR_INVOICE_BACKFILL_STATUSES = Object.freeze(['PRINTED', 'POSTED', 'FINAL', 'CREDIT']);

function isDebtorInvoiceBackfillStatus(status) {
	return DEBTOR_INVOICE_BACKFILL_STATUSES.includes(String(status || '').trim().toUpperCase());
}

/**
 * Fail-closed eligibility for customer-invoice GL backfill.
 *
 * Some Firebird databases contain unfinished INVOICES rows whose INV_NR is
 * NULL. Importing those rows into MySQL's auto-increment invoice_nr column can
 * assign them a real-looking number. Header totals alone are therefore not
 * proof that a tax invoice was issued.
 *
 * A backfillable invoice must have an explicit final/printed status and at
 * least one detail row stamped with the same invoice number. The snapshot
 * check covers general invoices and credit notes; the job-detail checks cover
 * legacy workshop invoices.
 */
function buildDebtorInvoiceBackfillEligibilitySql(schema, invoiceAlias = 'i') {
	const statuses = DEBTOR_INVOICE_BACKFILL_STATUSES.map(status => `'${status}'`).join(', ');
	return `COALESCE(${invoiceAlias}.invoice_nr, 0) > 0
		AND UPPER(TRIM(COALESCE(${invoiceAlias}.status, ''))) IN (${statuses})
		AND COALESCE(${invoiceAlias}.is_split_invoice, 0) = 0
		-- A historical invoice is POSTED, carries detail lines and deliberately has
		-- no DEBTOR_INVOICE journal, because the legacy sale was never an AUTONEER
		-- sale. That is correct, not broken: backfilling it would invent Sales, VAT
		-- and Cost of Sales that belong to the tenant's previous system. Its only
		-- possible debtor GL is DEBTOR_OPENING_BALANCE, posted at finalisation.
		AND COALESCE(${invoiceAlias}.is_historical_import, 0) = 0
		AND NOT EXISTS (
			SELECT 1
			FROM ${schema}.job_information backfill_job
			WHERE backfill_job.job_number = ${invoiceAlias}.job_number
			  AND UPPER(TRIM(COALESCE(backfill_job.status, ''))) = 'QUOTE'
		)
		AND (
			EXISTS (
				SELECT 1
				FROM ${schema}.spares_used backfill_part
				WHERE backfill_part.job_number = ${invoiceAlias}.job_number
				  AND backfill_part.invoice_nr = ${invoiceAlias}.invoice_nr
			)
			-- Finalise never stamps excluded lines with the invoice number, but costs
			-- them when the tenant hides excluded items. A R0 invoice whose only
			-- parts are such lines is still a real, cost-bearing AUTONEER invoice.
			OR EXISTS (
				SELECT 1
				FROM ${schema}.spares_used backfill_excluded_part
				WHERE backfill_excluded_part.job_number = ${invoiceAlias}.job_number
				  AND backfill_excluded_part.invoice_nr IS NULL
				  AND COALESCE(backfill_excluded_part.is_excluded_from_quote, 0) = 1
				  AND COALESCE(backfill_excluded_part.excluded_stock_returned, 0) = 0
				  AND UPPER(TRIM(COALESCE(${invoiceAlias}.status, ''))) <> 'CREDIT'
			)
			OR EXISTS (
				SELECT 1
				FROM ${schema}.work_done backfill_work
				WHERE backfill_work.job_number = ${invoiceAlias}.job_number
				  AND (backfill_work.invoice_nr = ${invoiceAlias}.invoice_nr
				    OR (backfill_work.invoice_nr IS NULL
				      AND COALESCE(backfill_work.is_excluded_from_quote, 0) = 1
				      AND CAST(COALESCE(backfill_work.workcost, 0) AS DECIMAL(18,2)) > 0.009
				      AND UPPER(TRIM(COALESCE(${invoiceAlias}.status, ''))) <> 'CREDIT'))
			)
			OR EXISTS (
				SELECT 1
				FROM ${schema}.customer_invoice_lines backfill_line
				WHERE backfill_line.invoice_nr = ${invoiceAlias}.invoice_nr
				  AND backfill_line.cid = ${invoiceAlias}.cid
				  AND (
					COALESCE(${invoiceAlias}.job_number, 0) = 0
					OR UPPER(TRIM(COALESCE(${invoiceAlias}.status, ''))) = 'CREDIT'
				  )
			)
		)`;
}

function round2(v) {
	return Math.round((Number(v) || 0) * 100) / 100;
}

function getBalancedDebtorInvoiceTotals({ ex, inc, vat } = {}) {
	const totalIncVat = round2(inc);
	const direction = totalIncVat < -0.009 ? -1 : 1;
	const vatMagnitude = Math.abs(round2(vat));
	const postedVat = vatMagnitude > 0.009 ? round2(direction * vatMagnitude) : 0;

	// The inclusive total is the amount posted to the customer account and the
	// stored VAT is the statutory amount posted to VAT Output. Some legacy
	// invoice headers have an ex-VAT total that differs from those two fields,
	// so derive the revenue target from the amounts that the journal actually
	// posts instead of reproducing an unbalanced header.
	return {
		totalIncVat,
		postedVat,
		revenueTotal: round2(totalIncVat - postedVat),
		storedExVat: round2(ex)
	};
}

/**
 * COS debits and WIP/asset credits for an invoice's costed parts, split the way
 * routes/finalise.js splits them: WIP is credited only up to what job-tagged
 * supplier invoices actually debited to WIP, and the rest relieves the part's
 * own asset account.
 *
 * @param {{parts: Array<{cost:number}>, wipBalance: number, wipAccnr: number|null,
 *          refs: object, resolveAccounts: (part: object) => Promise<{cosAccnr:number, assetAccnr:number}>}} opts
 */
async function buildDebtorInvoicePartCostLines({ parts, wipBalance, wipAccnr, refs, resolveAccounts }) {
	let wipRemaining = wipAccnr ? round2(wipBalance) : 0;
	const lines = [];
	for (const part of parts || []) {
		const cost = round2(part.cost);
		if (cost <= 0.009) continue;
		const wipPortion = round2(Math.min(cost, Math.max(wipRemaining, 0)));
		const assetPortion = round2(cost - wipPortion);
		wipRemaining = round2(wipRemaining - wipPortion);
		const { cosAccnr, assetAccnr } = await resolveAccounts(part);
		lines.push({ accnr: cosAccnr, debit: cost, ...refs });
		if (wipPortion > 0.009) lines.push({ accnr: wipAccnr, credit: wipPortion, ...refs });
		if (assetPortion > 0.009) lines.push({ accnr: assetAccnr, credit: assetPortion, ...refs });
	}
	return lines;
}

// Live posting (buildCreditorInvoiceGlLines) debits the header VAT, which carries
// the invoice-level VAT rounding. Headers saved before migration 231 hold that
// cent without recording vat_rounding_adjustment, so the header VAT is trusted
// whenever the header's ex-VAT value agrees with its lines.
function getCreditorInvoiceVatToPost({ headerAmount, headerVat, lineExVat, lineVat }) {
	const amount = round2(Math.abs(Number(headerAmount) || 0));
	const vat = round2(Math.abs(Number(headerVat) || 0));
	if (amount > 0.009 && Math.abs(round2(amount - vat) - round2(lineExVat)) < 0.005) return vat;
	return round2(lineVat);
}

// Legacy supplier invoice headers can sit under their lines: by a few cents where
// the header's total, ex-VAT and VAT were rounded separately or each line rounded
// its own VAT, and by more where legacy lines were entered twice or overstated.
// The header total is what the supplier was owed (paid, owing and returned add up
// to it) and its VAT is the tax invoice's, so both stand: the lines post as
// recorded and their excess is credited to Cost of Sales.

/**
 * The VAT to post and the gap left for Cost of Sales on a supplier invoice with
 * lines: positive when the header is above its lines, negative when below.
 */
function settleCreditorLineGap({ apTotal, vatToPost, headerVat, itemExVatTotal }) {
	const vat = round2(vatToPost);
	const gap = round2(apTotal - vat - itemExVatTotal);
	if (gap >= -0.009) return { vat, gap };
	const invoiceVat = round2(Math.abs(Number(headerVat) || 0));
	return { vat: invoiceVat, gap: round2(apTotal - invoiceVat - itemExVatTotal) };
}

function getCreditorInvoiceLinePostingAmounts(line = {}) {
	const vat = round2(Math.abs(Number(line.vat) || 0));
	const storedIncVat = round2(Math.abs(Number(line.amount) || 0));
	if (storedIncVat > 0.009) {
		return {
			amountExVat: round2(Math.max(0, storedIncVat - vat)),
			vat,
			amountIncVat: storedIncVat
		};
	}

	// Legacy rows may not have a populated inclusive amount. In that case,
	// reconstruct the discount-net line value from unit cost and quantity.
	const quantity = Math.abs(Number(line.quantity) || 0) || 1;
	const grossExVat = round2(Math.abs(Number(line.amountexvat) || 0) * quantity);
	const discount = Math.min(grossExVat, round2(Math.abs(Number(line.discount) || 0)));
	const amountExVat = round2(grossExVat - discount);
	return { amountExVat, vat, amountIncVat: round2(amountExVat + vat) };
}

function normalizeLegacyPaymentMethod(paymethod) {
	return String(paymethod || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function legacyAdjustmentType(paymethod) {
	const method = normalizeLegacyPaymentMethod(paymethod);
	if (method === 'DISCOUNT') return 'DISCOUNT';
	if (method === 'BAD DEBT' || method === 'BADDEBT' || method === 'WRITE OFF' || method === 'WRITEOFF') return 'WRITE_OFF';
	if (method === 'CREDIT NOTE' || method === 'CREDITNOTE') return 'CREDIT_NOTE';
	return null;
}

function legacyPaymentSourceId(payid) {
	return `PAYMENT-${payid}`;
}

// A non-cash settlement a legacy import keeps as a customer payment row. The PWA
// never writes these methods.
function legacySettlementType(paymethod) {
	const method = normalizeLegacyPaymentMethod(paymethod);
	if (method === 'INTERNAL' || method === 'WARRANTY' || method === 'SERVICE PLAN') return 'ACCOUNT';
	if (method === 'ROUNDING') return 'ROUNDING';
	if (method === 'REFUND') return 'REFUND';
	return null;
}

/**
 * The journal lines of one legacy settlement: Accounts Receivable against
 *   ACCOUNT  - the account the row names (legacy's INTERNAL PAYMENTS or WARRANTY
 *              account), or Bank when it names no active account, as for a receipt;
 *   ROUNDING - Discounts Allowed, as legacy's rounding account has no
 *              counterpart in the chart;
 *   REFUND   - Bank, as a customer refund is posted.
 * A positive amount settles the invoice; a negative one (a refund) is owed again.
 */
function buildLegacySettlementLines({ type, amount, rowAccnr, controls, cid, invoiceNr }) {
	let otherAccnr = controls.BANK;
	if (type === 'ROUNDING') otherAccnr = controls.DISCOUNT;
	else if (type === 'ACCOUNT' && rowAccnr) otherAccnr = rowAccnr;
	const value = round2(amount);
	const abs = Math.abs(value);
	const refs = { cid, invoice_nr: invoiceNr };
	return value >= 0
		? [{ accnr: otherAccnr, debit: abs, credit: 0, ...refs }, { accnr: controls.AR, debit: 0, credit: abs, ...refs }]
		: [{ accnr: controls.AR, debit: abs, credit: 0, ...refs }, { accnr: otherAccnr, debit: 0, credit: abs, ...refs }];
}

function buildCreditorInvoiceSourceId(suppid, invoiceNr) {
	return `${String(suppid || '').trim()}:${String(invoiceNr || '').trim()}`;
}

// The supplier RFC of a legacy '-RFC' return whose pair migrateLegacyRfcs moved
// into supplier_rfc_headers, paired the way that migration pairs them. Such a
// return keeps its legacy status (RFC-DONE or RFC-LEGACY), but its reversal must
// still be posted, or its original invoice stays in Accounts Payable in full.
function legacyRfcIdSql(schema, alias) {
	return `(SELECT legacy_rfc.rfc_id
		 FROM ${schema}.supplier_rfc_headers legacy_rfc
		 JOIN ${schema}.invoices_supplier legacy_orig ON legacy_orig.sinvid = legacy_rfc.original_sinvid
		 WHERE legacy_rfc.reason = 'LEGACY_MIGRATION'
		   AND ${alias}.invoice_nr LIKE '%-RFC'
		   AND legacy_orig.suppid = ${alias}.suppid
		   AND legacy_orig.invoice_nr = REPLACE(${alias}.invoice_nr, '-RFC', '')
		 ORDER BY legacy_rfc.rfc_id
		 LIMIT 1)`;
}

/**
 * Journal identity of a migrated legacy return: keyed by its supplier RFC, as a
 * live RFC is, with the description and references rewriteLegacyRfcGlSourceIds
 * gives a renumbered legacy journal. A journal already posted under the legacy
 * '-RFC' number keeps that key, so the return is not posted twice; the
 * post-backfill repair renumbers it. The legacy return keeps its status.
 */
async function legacyRfcJournalIdentity(companyDb, schema, row) {
	const legacyInvoiceNr = String(row.invoice_nr);
	const headers = await tenantQuery(companyDb,
		`SELECT rfc_number FROM ${schema}.supplier_rfc_headers WHERE rfc_id = ? LIMIT 1`,
		[row.legacy_rfc_id]
	);
	const legacyJournals = await tenantQuery(companyDb,
		`SELECT id FROM ${schema}.gl_journal_headers WHERE source = 'CREDITOR_RFC' AND source_id = ? LIMIT 1`,
		[legacyInvoiceNr]
	);
	const originalInvoiceNr = legacyInvoiceNr.replace(/-RFC/g, '');
	const rfcNumber = headers && headers[0] ? headers[0].rfc_number : row.legacy_rfc_id;
	return {
		sourceId: legacyJournals && legacyJournals[0] ? legacyInvoiceNr : String(row.legacy_rfc_id),
		description: `RFC ${rfcNumber} — Reversal of supplier invoice ${originalInvoiceNr} (legacy)`,
		extraRefs: { suppid: row.suppid || null, invoice_nr: originalInvoiceNr, ref2: legacyInvoiceNr },
		skipSourceStatus: true
	};
}

function buildCreditorInvoiceTargetFilter(targetIds) {
	const filters = [];
	const params = [];
	for (const target of targetIds) {
		const match = /^([1-9]\d*):(.+)$/.exec(String(target));
		if (!match || !Number.isSafeInteger(Number(match[1])) || !match[2].trim()) {
			const err = new Error('A targeted supplier invoice needs a supplier ID and exact invoice reference.');
			err.code = 'SUPPLIER_INVOICE_TARGET_AMBIGUOUS';
			throw err;
		}
		filters.push('(suppid = ? AND BINARY invoice_nr = BINARY ?)');
		params.push(Number(match[1]), match[2]);
	}
	return { sql: filters.join(' OR '), params };
}

async function resolveCreditorInvoiceSourceId(companyDb, schema, suppid, invoiceNr) {
	const duplicateRows = await tenantQuery(companyDb,
		`SELECT COUNT(DISTINCT suppid) AS cnt
		 FROM ${schema}.invoices_supplier
		 WHERE invoice_nr = ?`,
		[invoiceNr]
	);
	const duplicateSupplierCount = Number(duplicateRows && duplicateRows[0] ? duplicateRows[0].cnt : 0);
	if (duplicateSupplierCount > 1) {
		return buildCreditorInvoiceSourceId(suppid, invoiceNr);
	}

	const rows = await tenantQuery(companyDb,
		`SELECT h.source_id
		 FROM ${schema}.gl_journal_headers h
		 JOIN ${schema}.gl_journal_lines l ON l.header_id = h.id
		 WHERE h.source = 'CREDITOR_INVOICE'
		   AND l.suppid = ?
		   AND l.invoice_nr = ?
		 LIMIT 1`,
		[suppid, invoiceNr]
	);
	return rows && rows[0] && rows[0].source_id
		? String(rows[0].source_id)
		: buildCreditorInvoiceSourceId(suppid, invoiceNr);
}

async function createRun({ companyDb, schema, staffId, fromDate, toDate, types, dryRun }) {
	const now = new Date();
	const typesJson = JSON.stringify(types || []);
	const startedAt = now.toISOString().slice(0, 19).replace('T', ' ');
	const r = await tenantQuery(companyDb,
		`INSERT INTO ${schema}.gl_backfill_runs (started_at, started_by_staff_id, from_date, to_date, types_json, dry_run, status) VALUES (?, ?, ?, ?, ?, ?, 'RUNNING')`,
		[startedAt, staffId, fromDate, toDate, typesJson, dryRun ? 1 : 0]
	);
	const runId = r && r.insertId ? r.insertId : null;
	return runId;
}

// Ensure supplier references for a single journal header (non-destructive)
// - Only updates NULL suppid or invoice_nr fields
// - Resolves values by looking up source_id against invoices_supplier (and payments_suppliers if necessary)
async function ensureSupplierRefs({ companyDb, schema, headerId }) {
	if (!headerId) return { updated: 0, skipped: true };
	// load header
	const headers = await tenantQuery(companyDb, `SELECT id, source, source_id FROM ${schema}.gl_journal_headers WHERE id = ? LIMIT 1`, [headerId]);
	if (!headers || !headers[0]) return { updated: 0, skipped: true };
	const h = headers[0];
	const src = String(h.source || '').toUpperCase();
	const srcId = String(h.source_id || '');

	// Only attempt for supplier-origin journals
	if (!['CREDITOR_INVOICE', 'SUPPLIER_INVOICE'].includes(src)) return { updated: 0, skipped: true };

	// Try to resolve supplier and invoice number from source tables
	let resolvedSuppid = null;
	let resolvedInvoiceNr = null;
	try {
		const invRows = await tenantQuery(companyDb, `SELECT suppid, invoice_nr FROM ${schema}.invoices_supplier WHERE invoice_nr = ? LIMIT 1`, [srcId]);
		if (invRows && invRows[0]) {
			resolvedSuppid = invRows[0].suppid || null;
			resolvedInvoiceNr = invRows[0].invoice_nr || null;
		}
	} catch (e) {
		// ignore resolution errors - we'll skip updating
		logger.warn && logger.warn('ensureSupplierRefs: invoice lookup failed', { headerId, err: e && e.message });
	}

	// If we couldn't resolve anything, skip
	if (resolvedSuppid === null && (resolvedInvoiceNr === null || resolvedInvoiceNr === undefined)) {
		return { updated: 0, skipped: true };
	}

	// Build update; only set values where currently NULL
	const setSupp = resolvedSuppid !== null ? `suppid = CASE WHEN suppid IS NULL THEN ? ELSE suppid END` : null;
	const setInv = (resolvedInvoiceNr !== null && resolvedInvoiceNr !== undefined && resolvedInvoiceNr !== '') ? `invoice_nr = CASE WHEN invoice_nr IS NULL THEN ? ELSE invoice_nr END` : null;
	const sets = [setSupp, setInv].filter(Boolean).join(', ');
	if (!sets) return { updated: 0, skipped: true };

	const params = [];
	if (setSupp) params.push(resolvedSuppid);
	if (setInv) params.push(resolvedInvoiceNr);
	params.push(headerId);

	const res = await tenantQuery(companyDb, `UPDATE ${schema}.gl_journal_lines SET ${sets} WHERE header_id = ? AND (suppid IS NULL OR invoice_nr IS NULL)`, params);
	const affected = res && (res.affectedRows || res.affected_rows || res.changedRows) ? (res.affectedRows || res.changedRows || res.affected_rows) : 0;
	// logger.info && logger.info('ensureSupplierRefs', { headerId, resolvedSuppid, resolvedInvoiceNr, affected });
	return { updated: affected, skipped: false };
}

// Backfill supplier refs for existing journals (non-destructive). Idempotent.
async function backfillSupplierRefs({ companyDb, schema, limit = 1000, onProgress = null }) {
	// Find headers that appear to be supplier journals and have missing suppid or invoice_nr on any line
	const rows = await tenantQuery(companyDb,
		`SELECT h.id FROM ${schema}.gl_journal_headers h JOIN ${schema}.gl_journal_lines l ON l.header_id = h.id WHERE h.source IN ('CREDITOR_INVOICE','SUPPLIER_INVOICE') AND (l.suppid IS NULL OR l.invoice_nr IS NULL) GROUP BY h.id LIMIT ?`,
		[limit]
	);
	const headers = Array.isArray(rows) ? rows.map(r => r.id || r.ID || r.Id).filter(Boolean) : [];
	let totalUpdated = 0;
	if (typeof onProgress === 'function') {
		onProgress({ processed: 0, total: headers.length, updated: totalUpdated, current: null });
	}
	for (const [idx, hid] of headers.entries()) {
		try {
			const r = await ensureSupplierRefs({ companyDb, schema, headerId: hid });
			if (r && !r.skipped) totalUpdated += (r.updated || 0);
		} catch (e) {
			logger.error && logger.error('backfillSupplierRefs: failed for header', { headerId: hid, err: e && e.stack ? e.stack : e });
		}
		if (typeof onProgress === 'function') {
			onProgress({ processed: idx + 1, total: headers.length, updated: totalUpdated, current: hid });
		}
	}
	// logger.info && logger.info('backfillSupplierRefs completed', { schema, checked: headers.length, updated: totalUpdated });
	return { checked: headers.length, updated: totalUpdated };
}

async function addRunItem({ companyDb, schema, runId, docType, source, sourceId, docDate, status, message }) {
	const createdAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
	await tenantQuery(companyDb,
		`INSERT INTO ${schema}.gl_backfill_run_items (run_id, doc_type, source, source_id, doc_date, status, message, created_at) VALUES (?,?,?,?,?,?,?,?)`,
		[runId, docType, source, String(sourceId), docDate, status, message || null, createdAt]
	);
}

async function updateRunSummary({ companyDb, schema, runId, summary, status }) {
	await tenantQuery(companyDb,
		`UPDATE ${schema}.gl_backfill_runs SET summary_json = ?, status = ?, finished_at = ? WHERE id = ?`,
		[JSON.stringify(summary || {}), status || 'DONE', new Date().toISOString().slice(0, 19).replace('T', ' '), runId]
	);
}

async function updateRunProgress({ companyDb, schema, runId, summary }) {
	await tenantQuery(companyDb,
		`UPDATE ${schema}.gl_backfill_runs SET summary_json = ?, status = 'RUNNING' WHERE id = ?`,
		[JSON.stringify(summary || {}), runId]
	);
}

function normalizeItemStatuses(itemStatuses) {
	const allowed = new Set(['POSTED', 'EXISTS', 'FAILED', 'SKIPPED']);
	const arr = Array.isArray(itemStatuses) ? itemStatuses : [];
	const normalized = Array.from(new Set(arr.map(s => String(s || '').toUpperCase()).filter(s => allowed.has(s))));
	return normalized.length ? normalized : ['FAILED'];
}

async function getRunStatus({ companyDb, schema, runId, itemStatuses, itemLimit }) {
	const [run] = await tenantQuery(companyDb, `SELECT * FROM ${schema}.gl_backfill_runs WHERE id = ?`, [runId]);
	const statuses = normalizeItemStatuses(itemStatuses);
	const limit = Math.max(1, Math.min(1000, Number(itemLimit || 200)));
	const statusPh = statuses.map(() => '?').join(',');
	const itemParams = [runId, ...statuses, limit];
	const items = await tenantQuery(companyDb, `SELECT * FROM ${schema}.gl_backfill_run_items WHERE run_id = ? AND status IN (${statusPh}) ORDER BY id DESC LIMIT ?`, itemParams);
	const normalizedItems = (items || []).map(it => ({ ...it, doc_type: String(it.doc_type || '').toUpperCase() }));

	// Enrich recent items with invoice-centric reference + deep links for troubleshooting.
	const debtorInvoiceIds = Array.from(new Set(normalizedItems.filter(it => it.doc_type === 'DEBTOR_INVOICE').map(it => String(it.source_id || '')).filter(Boolean)));
	const debtorPaymentIds = Array.from(new Set(normalizedItems.filter(it => it.doc_type === 'DEBTOR_PAYMENT').map(it => Number(it.source_id || 0)).filter(Boolean)));
	const creditorInvoiceIds = Array.from(new Set(normalizedItems.filter(it => it.doc_type === 'CREDITOR_INVOICE').map(it => String(it.source_id || '')).filter(Boolean)));
	const creditorPaymentIds = Array.from(new Set(normalizedItems.filter(it => it.doc_type === 'CREDITOR_PAYMENT').map(it => Number(it.source_id || 0)).filter(Boolean)));

	const debtorInvoiceMap = new Map();
	if (debtorInvoiceIds.length) {
		const ph = debtorInvoiceIds.map(() => '?').join(',');
		const rows = await tenantQuery(companyDb, `SELECT invoice_nr, cid FROM ${schema}.invoices WHERE invoice_nr IN (${ph})`, debtorInvoiceIds);
		for (const r of rows || []) debtorInvoiceMap.set(String(r.invoice_nr), { invoice_nr: r.invoice_nr, cid: r.cid });
	}

	const debtorPaymentMap = new Map();
	if (debtorPaymentIds.length) {
		const ph = debtorPaymentIds.map(() => '?').join(',');
		const rows = await tenantQuery(companyDb, `SELECT payid, invoice_nr, cid FROM ${schema}.payments WHERE payid IN (${ph})`, debtorPaymentIds);
		for (const r of rows || []) debtorPaymentMap.set(Number(r.payid), { payid: r.payid, invoice_nr: r.invoice_nr, cid: r.cid });
	}

	const creditorInvoiceMap = new Map();
	if (creditorInvoiceIds.length) {
		const ph = creditorInvoiceIds.map(() => '?').join(',');
		const rows = await tenantQuery(companyDb, `SELECT invoice_nr, suppid FROM ${schema}.invoices_supplier WHERE invoice_nr IN (${ph})`, creditorInvoiceIds);
		for (const r of rows || []) creditorInvoiceMap.set(String(r.invoice_nr), { invoice_nr: r.invoice_nr, suppid: r.suppid });
	}

	const creditorPaymentMap = new Map();
	if (creditorPaymentIds.length) {
		const hasSupplierPayments = await tableExists(companyDb, schema, 'payments_suppliers');
		if (hasSupplierPayments) {
			const ph = creditorPaymentIds.map(() => '?').join(',');
			const rows = await tenantQuery(companyDb, `SELECT payid, invoice_nr, suppid FROM ${schema}.payments_suppliers WHERE payid IN (${ph})`, creditorPaymentIds);
			for (const r of rows || []) creditorPaymentMap.set(Number(r.payid), { payid: r.payid, invoice_nr: r.invoice_nr, suppid: r.suppid });
		}
	}

	const enrichedItems = normalizedItems.map(it => {
		const out = { ...it, source_ref: String(it.source_id || ''), source_url: null };
		if (it.doc_type === 'DEBTOR_INVOICE') {
			const m = debtorInvoiceMap.get(String(it.source_id || ''));
			if (m) {
				out.source_ref = String(m.invoice_nr || it.source_id || '');
				if (m.cid) out.source_url = `/customer/${m.cid}/invoice/recall/${m.invoice_nr}`;
			}
			return out;
		}
		if (it.doc_type === 'DEBTOR_PAYMENT') {
			const m = debtorPaymentMap.get(Number(it.source_id || 0));
			if (m) {
				out.source_ref = String(m.invoice_nr || it.source_id || '');
				if (m.cid && m.invoice_nr) out.source_url = `/customer/${m.cid}/invoice/recall/${m.invoice_nr}`;
			}
			return out;
		}
		if (it.doc_type === 'CREDITOR_INVOICE') {
			const m = creditorInvoiceMap.get(String(it.source_id || ''));
			if (m) {
				out.source_ref = String(m.invoice_nr || it.source_id || '');
				if (m.suppid) out.source_url = `/suppliers/${m.suppid}/invoices`;
			}
			return out;
		}
		if (it.doc_type === 'CREDITOR_PAYMENT') {
			const m = creditorPaymentMap.get(Number(it.source_id || 0));
			if (m) {
				out.source_ref = String(m.invoice_nr || it.source_id || '');
				if (m.suppid) out.source_url = `/suppliers/${m.suppid}/invoices`;
			}
			return out;
		}
		return out;
	});
	const countRows = await tenantQuery(companyDb, `SELECT doc_type, status, COUNT(*) AS cnt FROM ${schema}.gl_backfill_run_items WHERE run_id = ? GROUP BY doc_type, status`, [runId]);
	const counts = { posted: 0, exists: 0, failed: 0, skipped: 0 };
	const processedByType = {};
	for (const row of countRows || []) {
		const field = { POSTED: 'posted', EXISTS: 'exists', FAILED: 'failed', SKIPPED: 'skipped' }[String(row.status || '').toUpperCase()];
		if (!field) continue;
		const cnt = Number(row.cnt || 0);
		counts[field] += cnt;
		processedByType[row.doc_type] = (processedByType[row.doc_type] || 0) + cnt;
	}
	const processedDocs = counts.posted + counts.exists + counts.failed + counts.skipped;
	let runSummary = {};
	if (run && run.summary_json) {
		try {
			runSummary = typeof run.summary_json === 'string' ? JSON.parse(run.summary_json) : run.summary_json;
		} catch (_) {
			runSummary = {};
		}
	}
	// Each type's total is the run's own count; its progress is its items so far.
	const byType = {};
	for (const [type, entry] of Object.entries(runSummary.byType || {})) {
		byType[type] = { total: Number(entry && entry.total) || 0, processed: processedByType[type] || 0 };
	}
	const summary = {
		...runSummary,
		...counts,
		processedDocs: processedDocs,
		totalDocs: Number(runSummary.totalDocs || 0) || 0,
		byType
	};
	return { run: run || null, items: enrichedItems || [], summary, itemFilter: statuses };
}

async function tableExists(companyDb, schema, tableName) {
	const rows = await tenantQuery(
		companyDb,
		`SELECT 1 FROM information_schema.tables WHERE table_schema = ? AND table_name = ? LIMIT 1`,
		[schema, tableName]
	);
	return Array.isArray(rows) && rows.length > 0;
}

async function truncateGlBackfillTables(companyDb, schema) {
	// find all tables in this schema that start with gl_backfill
	const rows = await tenantQuery(companyDb,
		`SELECT table_name FROM information_schema.tables WHERE table_schema = ? AND table_name LIKE 'gl_backfill%';`,
		[schema]
	);
	const truncated = [];
	// disable foreign key checks so truncation won't fail due to FK order
	let fkDisabled = false;
	try {
		await tenantQuery(companyDb, `SET FOREIGN_KEY_CHECKS=0`);
		fkDisabled = true;
		for (const r of rows || []) {
			// mysql may return column names in different casing; be resilient
			const t = r.table_name || r.TABLE_NAME || (Object.keys(r).length ? r[Object.keys(r)[0]] : null);
			if (!t) {
				logger.error && logger.error('Unexpected information_schema row when truncating gl_backfill tables', { row: r });
				continue;
			}
			// qualify identifiers with backticks to avoid issues with special names
			const qual = `\`${schema}\`.\`${t}\``;
			try {
				await tenantQuery(companyDb, `TRUNCATE TABLE ${qual}`);
				truncated.push(t);
			} catch (err) {
				logger.error && logger.error('Failed to truncate table', { table: t, err: err && err.stack ? err.stack : err });
				throw new Error(`Failed to truncate ${t}: ${err && err.message ? err.message : String(err)}`);
			}
		}
	} finally {
		if (fkDisabled) {
			try { await tenantQuery(companyDb, `SET FOREIGN_KEY_CHECKS=1`); } catch (e) { logger.error && logger.error('Failed to re-enable FK checks after truncation', e); }
		}
	}
	return truncated;
}

function getAffectedRows(result) {
	if (!result) return 0;
	return Number(result.affectedRows || result.affected_rows || result.changedRows || 0);
}

// A run the user stopped. runBackfillJob records its message as the run's last error.
function backfillStopped(message) {
	return Object.assign(new Error(message), { code: 'BACKFILL_STOPPED' });
}

// Journals deleted per statement; their lines go with them (fk_gl_journal_lines_header cascades).
const CLEAR_BATCH = 500;

/**
 * Deletes the journals a live run is about to post again. Finds them first,
 * then deletes them by id in batches, so a caller can show progress and stop
 * between batches. Each lookup starts from the documents and reaches their
 * journals through uk_gl_journal_headers_source; a correlated EXISTS from the
 * journals re-scanned every document for each journal (15,566 customer invoice
 * journals: 265 s to find, against 1 s this way).
 *
 * onProgress({ deleted, total }) follows each batch; shouldStop() is checked
 * before each one. Journals deleted before a stop stay deleted.
 */
async function clearPreviousBackfillScope({ companyDb, schema, fromDate, toDate, types }, { onProgress = null, shouldStop = null } = {}) {
	const selected = new Set((types || []).map(t => String(t || '').toUpperCase()));
	const cleared = { totalDeleted: 0, byType: {} };

	if (selected.has('CREDITOR_INVOICE')) {
		// Redo posts job-linked supplier lines to WIP and fails without it. Check
		// before deleting anything, so Clear Previous never leaves those invoices
		// with no journal at all.
		const jobLinkedRows = await tenantQuery(companyDb,
			`SELECT ii.job_number
			 FROM ${schema}.invoice_items ii
			 JOIN ${schema}.invoices_supplier s
			   ON s.suppid = ii.suppid
			  AND s.invoice_nr = ii.invoice_nr
			 WHERE s.inv_date BETWEEN ? AND ?
			   AND UPPER(TRIM(COALESCE(s.purchasetype, ''))) <> 'GENERAL'
			   AND TRIM(COALESCE(CAST(ii.job_number AS CHAR), '')) NOT IN ('', '0')
			 LIMIT 1`,
			[fromDate, toDate]
		);
		if (jobLinkedRows && jobLinkedRows[0]) {
			requireSupplierWipAccount(await resolveSupplierAssetControls(schema), normalizeJobNumber(jobLinkedRows[0].job_number));
		}
	}

	const scopes = [];
	async function findJournals(docType, sql, params) {
		const rows = await tenantQuery(companyDb, sql, params || []);
		scopes.push({ docType, ids: (rows || []).map(row => Number(row.id)) });
	}

	if (selected.has('CREDITOR_INVOICE')) {
		// Supplier invoice journals are keyed suppid:invoice_nr
		// (buildCreditorInvoiceSourceId); older ones by the bare invoice number.
		// A migrated legacy return is keyed by its supplier RFC (legacyRfcJournalIdentity).
		await findJournals(
			'CREDITOR_INVOICE',
			`SELECT h.id
			 FROM ${schema}.invoices_supplier s
			 JOIN ${schema}.gl_journal_headers h
			   ON h.source IN ('CREDITOR_INVOICE', 'CREDITOR_RFC')
			  AND h.source_id = CAST(s.invoice_nr AS CHAR)
			 WHERE s.inv_date BETWEEN ? AND ?
			 UNION
			 SELECT h.id
			 FROM ${schema}.invoices_supplier s
			 JOIN ${schema}.gl_journal_headers h
			   ON h.source = 'CREDITOR_INVOICE'
			  AND h.source_id = CONCAT(s.suppid, ':', s.invoice_nr)
			 WHERE s.inv_date BETWEEN ? AND ?
			 UNION
			 SELECT h.id
			 FROM ${schema}.invoices_supplier s
			 JOIN ${schema}.gl_journal_headers h
			   ON h.source = 'CREDITOR_RFC'
			  AND h.source_id = CAST(${legacyRfcIdSql(schema, 's')} AS CHAR)
			 WHERE s.inv_date BETWEEN ? AND ?
			   AND s.invoice_nr LIKE '%-RFC'`,
			[fromDate, toDate, fromDate, toDate, fromDate, toDate]
		);
	}

	if (selected.has('DEBTOR_INVOICE')) {
		await findJournals(
			'DEBTOR_INVOICE',
			`SELECT DISTINCT h.id
			 FROM ${schema}.invoices i
			 JOIN ${schema}.gl_journal_headers h
			   ON h.source = 'DEBTOR_INVOICE'
			  AND h.source_id = CAST(i.invoice_nr AS CHAR)
			  AND h.source_id REGEXP '^[0-9]+$'
			 WHERE i.invoice_date BETWEEN ? AND ?
			   AND ${buildDebtorInvoiceBackfillEligibilitySql(schema, 'i')}`,
			[fromDate, toDate]
		);
	}

	if (selected.has('DEBTOR_PAYMENT')) {
		await findJournals(
			'DEBTOR_PAYMENT',
			`SELECT DISTINCT h.id
			 FROM ${schema}.payments p
			 JOIN ${schema}.gl_journal_headers h
			   ON h.source = 'DEBTOR_PAYMENT'
			  AND h.source_id = CAST(p.payid AS CHAR)
			  AND h.source_id REGEXP '^[0-9]+$'
			 WHERE p.paydate BETWEEN ? AND ?
			   AND ${DEBTOR_PAYMENT_BACKFILL_SQL}`,
			[fromDate, toDate]
		);
		await findJournals(
			'DEBTOR_PAYMENT_ADJUSTMENTS',
			`SELECT DISTINCT h.id
			 FROM ${schema}.payments p
			 JOIN ${schema}.gl_journal_headers h
			   ON h.source IN ('INVOICE_DISCOUNT', 'INVOICE_WRITE_OFF', 'DEBTOR_INVOICE_CREDIT')
			  AND h.source_id = CONCAT('PAYMENT-', p.payid)
			 WHERE p.paydate BETWEEN ? AND ?
			   AND ${LEGACY_PAYMENT_ADJUSTMENT_SQL}`,
			[fromDate, toDate]
		);
	}

	if (selected.has('CREDITOR_PAYMENT')) {
		if (!(await tableExists(companyDb, schema, 'payments_suppliers'))) {
			cleared.byType.CREDITOR_PAYMENT = 0;
		} else {
			// Not limited to SUPPLIER_PAYMENT_BACKFILL_SQL: this also clears journals
			// posted earlier for REVERSED payments, which the backfill no longer posts.
			await findJournals(
				'CREDITOR_PAYMENT',
				`SELECT DISTINCT h.id
				 FROM ${schema}.payments_suppliers p
				 JOIN ${schema}.gl_journal_headers h
				   ON h.source = 'CREDITOR_PAYMENT'
				  AND h.source_id = CAST(p.payid AS CHAR)
				  AND h.source_id REGEXP '^[0-9]+$'
				 WHERE p.paydate BETWEEN ? AND ?
				   AND ${PAYMENT_BACKFILL_EXCLUSION_SQL}`,
				[fromDate, toDate]
			);
		}
	}

	const total = scopes.reduce((sum, scope) => sum + scope.ids.length, 0);
	let done = 0;
	const report = () => { if (onProgress) onProgress({ deleted: done, total }); };
	report();
	for (const { docType, ids } of scopes) {
		cleared.byType[docType] = 0;
		for (let at = 0; at < ids.length; at += CLEAR_BATCH) {
			if (shouldStop && shouldStop()) {
				throw backfillStopped(`Stopped while deleting existing journals: ${done} of ${total} deleted. ` +
					'Start it again with Delete existing journals on to delete the rest.');
			}
			const batch = ids.slice(at, at + CLEAR_BATCH);
			const res = await tenantQuery(companyDb, `DELETE FROM ${schema}.gl_journal_headers WHERE id IN (${batch.map(() => '?').join(', ')})`, batch);
			const deleted = getAffectedRows(res);
			cleared.byType[docType] += deleted;
			cleared.totalDeleted += deleted;
			done += batch.length;
			report();
		}
	}

	if (selected.has('REBUILD_STOCK')) {
		if (!(await tableExists(companyDb, schema, 'stock_rebuild_jobs'))) {
			cleared.byType.REBUILD_STOCK = 0;
		} else {
			// Only the CURRENT capitalisation version of each rebuild in scope is
			// removed. Earlier versions and their REBUILD_STOCK_CAPITALISATION_REVERSAL
			// journals are the reopen history and stay untouched. The version itself
			// is kept so the rerun posts the same source id again.
			const deleted = await runInCompanyTx(companyDb, async (tx) => {
				const currentJournalJoinSql = `JOIN (
						SELECT r.job_number, r.gl_capitalisation_version
						FROM ${rebuildStockBackfillTablesSql(schema)}
						WHERE ${REBUILD_STOCK_BACKFILL_WHERE_SQL}
						  AND r.gl_capitalisation_version > 0
					) current_rebuild
					  ON h.source = ?
					 AND h.source_id = CONCAT(current_rebuild.job_number, ':', current_rebuild.gl_capitalisation_version)`;
				await tx.query(
					`DELETE l
					 FROM ${schema}.gl_journal_lines l
					 JOIN ${schema}.gl_journal_headers h ON h.id = l.header_id
					 ${currentJournalJoinSql}`,
					[fromDate, toDate, rebuildStockAccounting.CAPITALISATION_SOURCE]
				);
				const res = await tx.query(
					`DELETE h
					 FROM ${schema}.gl_journal_headers h
					 ${currentJournalJoinSql}`,
					[fromDate, toDate, rebuildStockAccounting.CAPITALISATION_SOURCE]
				);
				await tx.query(
					`UPDATE ${rebuildStockBackfillTablesSql(schema)}
					 SET r.gl_capitalisation_journal_id = NULL,
					     r.gl_capitalised_at = NULL
					 WHERE ${REBUILD_STOCK_BACKFILL_WHERE_SQL}`,
					[fromDate, toDate]
				);
				return getAffectedRows(res);
			}, { maxRetries: 0 });
			cleared.byType.REBUILD_STOCK = deleted;
			cleared.totalDeleted += deleted;
		}
	}

	return cleared;
}

function formatDateToSql(d) {
	if (!d) return null;
	const dt = new Date(d);
	if (Number.isNaN(dt.getTime())) return null;
	return dt.toISOString().slice(0, 10);
}

// Returns a Set of accnrs that exist and are active in gl_accounts. Used to validate
// legacy acc/accasset values before trusting them for GL posting.
async function resolveValidAccnrs(companyDb, schema, accnrs) {
	const nums = Array.from(new Set((accnrs || []).map(n => Number(n)).filter(n => n > 0)));
	if (!nums.length) return new Set();
	const ph = nums.map(() => '?').join(',');
	const rows = await tenantQuery(companyDb, `SELECT accnr FROM ${schema}.gl_accounts WHERE accnr IN (${ph}) AND active = 1`, nums).catch(() => []);
	return new Set((rows || []).map(r => Number(r.accnr)));
}

// The excess a receipt was overpaid by, held as a linked INVOICE_OVERPAYMENT
// customer credit. It is the other half of the receipt's own DEBTOR_PAYMENT
// journal, so rebuilding that journal has to include it. A tenant without
// migration 261 (or without customer_credits at all) simply reports nothing,
// which reproduces the historical two-line receipt.
async function findOverpaymentCreditAmount(companyDb, schema, payid) {
	const paymentId = Number(payid);
	if (!Number.isFinite(paymentId) || paymentId <= 0) return 0;
	try {
		const rows = await tenantQuery(companyDb,
			`SELECT amount FROM ${schema}.customer_credits
			 WHERE origin_payment_id = ? AND source_type = 'INVOICE_OVERPAYMENT' AND status <> 'REVERSED'
			 LIMIT 1`,
			[paymentId]
		);
		return rows && rows.length ? Number(rows[0].amount) || 0 : 0;
	} catch (err) {
		if (err && (err.code === 'ER_BAD_FIELD_ERROR' || err.code === 'ER_NO_SUCH_TABLE')) return 0;
		throw err;
	}
}

async function ensureAccountsExist(companyDb, schema, accnrs) {
	const accs = Array.from(new Set((accnrs || []).map(n => Number(n))));
	if (accs.length === 0) return;
	const placeholders = accs.map(() => '?').join(',');
	const rows = await tenantQuery(companyDb, `SELECT accnr, active FROM ${schema}.gl_accounts WHERE accnr IN (${placeholders})`, accs);
	const found = new Map(rows.map(r => [Number(r.accnr), Number(r.active || 0)]));
	for (const a of accs) {
		if (!found.has(a)) throw new Error(`Account ${a} not found`);
		if (found.get(a) === 0) throw new Error(`Account ${a} is inactive`);
	}
}

function formatLineValidationDetails(lines) {
	const arr = Array.isArray(lines) ? lines : [];
	const bad = [];
	for (let i = 0; i < arr.length; i++) {
		const ln = arr[i] || {};
		const debit = Number(ln.debit || 0);
		const credit = Number(ln.credit || 0);
		const hasDebit = debit > 0.0001;
		const hasCredit = credit > 0.0001;
		if ((hasDebit && hasCredit) || (!hasDebit && !hasCredit)) {
			bad.push(`#${i + 1} acc=${ln.accnr || '?'} dr=${debit.toFixed(2)} cr=${credit.toFixed(2)} inv=${ln.invoice_nr || ''}`);
		}
		if (bad.length >= 3) break;
	}
	if (!bad.length) return '';
	return `Invalid lines: ${bad.join(' | ')}`;
}

function countExpectedDebtorInvoicePartLines(lines, controls) {
	const arr = Array.isArray(lines) ? lines : [];
	let count = 0;
	for (const ln of arr) {
		// Labour is not a missing stock leg. In particular, adding this feature
		// must never make the legacy part-line repair rewrite an old journal.
		if (ln && [LABOUR_COS_REF, LABOUR_OFFSET_REF].includes(ln.ref1)) continue;
		const accnr = Number(ln && ln.accnr);
		if (!accnr) continue;
		if (accnr === Number(controls.AR) || accnr === Number(controls.SALES) || accnr === Number(controls.VAT_OUTPUT)) continue;
		const debit = Number(ln && ln.debit ? ln.debit : 0);
		const credit = Number(ln && ln.credit ? ln.credit : 0);
		if (debit > 0.0001 || credit > 0.0001) count++;
	}
	return count;
}

function countExistingDebtorInvoicePartLines(lines, controls) {
	const arr = Array.isArray(lines) ? lines : [];
	let count = 0;
	for (const ln of arr) {
		if (ln && [LABOUR_COS_REF, LABOUR_OFFSET_REF].includes(ln.ref1)) continue;
		const accnr = Number(ln && ln.accnr);
		if (!accnr) continue;
		if (accnr === Number(controls.AR) || accnr === Number(controls.SALES) || accnr === Number(controls.VAT_OUTPUT)) continue;
		const debit = Number(ln && ln.debit ? ln.debit : 0);
		const credit = Number(ln && ln.credit ? ln.credit : 0);
		if (debit > 0.0001 || credit > 0.0001) count++;
	}
	return count;
}

function scoreForVatInput(name, typeCode) {
	const n = String(name || '').toUpperCase();
	const t = String(typeCode || '').toUpperCase();
	let score = t === 'ASSET' ? 30 : (t === 'LIABILITY' ? 20 : 0);
	if (n.includes('VAT')) score += 30;
	if (n.includes('INPUT')) score += 50;
	if (n.includes('PURCHASE')) score += 20;
	if (n.includes('SALES') || n.includes('OUTPUT')) score -= 40;
	return score;
}

async function ensureVatInputAccount({ companyDb, schema }) {
	// Load all active accounts with their type codes
	const accounts = await tenantQuery(companyDb,
		`SELECT a.accnr, a.name, t.code AS type_code
		 FROM ${schema}.gl_accounts a
		 LEFT JOIN ${schema}.gl_account_types t ON t.id = a.type_id
		 WHERE a.active = 1`
	);

	// Check if the current control mapping already points to a valid account
	const ctrlRows = await tenantQuery(companyDb,
		`SELECT c.accnr, a.name, t.code AS type_code
		 FROM ${schema}.gl_control_accounts c
		 LEFT JOIN ${schema}.gl_accounts a ON a.accnr = c.accnr
		 LEFT JOIN ${schema}.gl_account_types t ON t.id = a.type_id
		 WHERE c.control_key = 'VAT_INPUT' AND c.active = 1`
	);
	if (ctrlRows && ctrlRows[0] && scoreForVatInput(ctrlRows[0].name, ctrlRows[0].type_code) >= 50) {
		return { action: 'none', accnr: ctrlRows[0].accnr };
	}

	// Scan existing accounts for one that already passes scoring
	for (const acc of accounts || []) {
		if (scoreForVatInput(acc.name, acc.type_code) >= 50) {
			await tenantQuery(companyDb,
				`INSERT INTO ${schema}.gl_control_accounts (control_key, transaction_type, accnr, active)
				 VALUES ('VAT_INPUT', 'GENERIC', ?, 1)
				 ON DUPLICATE KEY UPDATE accnr = VALUES(accnr), active = 1`,
				[acc.accnr]
			);
			logger.info && logger.info('ensureVatInputAccount: remapped to existing account', { schema, accnr: acc.accnr, name: acc.name });
			return { action: 'remapped', accnr: acc.accnr };
		}
	}

	// No suitable account exists — create one with a safe unused accnr
	const existingAccnrs = new Set((accounts || []).map(a => Number(a.accnr)));
	let newAccnr = 3350;
	while (existingAccnrs.has(newAccnr)) newAccnr += 10;

	const typeRows = await tenantQuery(companyDb,
		`SELECT id FROM ${schema}.gl_account_types WHERE code = 'ASSET'`
	);
	const assetTypeId = typeRows && typeRows[0] ? typeRows[0].id : null;
	if (!assetTypeId) throw new Error('Cannot auto-create VAT Input account: ASSET type not found in gl_account_types');

	await tenantQuery(companyDb,
		`INSERT INTO ${schema}.gl_accounts (accnr, name, type_id, category, active)
		 VALUES (?, 'VAT INPUT TAX', ?, 'Asset', 1)`,
		[newAccnr, assetTypeId]
	);
	await tenantQuery(companyDb,
		`INSERT INTO ${schema}.gl_control_accounts (control_key, transaction_type, accnr, active)
		 VALUES ('VAT_INPUT', 'GENERIC', ?, 1)
		 ON DUPLICATE KEY UPDATE accnr = VALUES(accnr), active = 1`,
		[newAccnr]
	);

	logger.info && logger.info('ensureVatInputAccount: auto-created VAT Input Tax account', { schema, accnr: newAccnr });
	return { action: 'created', accnr: newAccnr, name: 'VAT INPUT TAX' };
}

function normalizeRebuildTargetIds(targetIds) {
	return Array.from(new Set((targetIds || [])
		.map((id) => Number.parseInt(String(id).split(':')[0], 10))
		.filter((id) => Number.isInteger(id) && id > 0)));
}

async function loadRebuildStockBackfillRows({ companyDb, schema, fromDate, toDate, targetIds = null }) {
	if (!(await tableExists(companyDb, schema, 'stock_rebuild_jobs'))) return [];
	const jobNumbers = targetIds ? normalizeRebuildTargetIds(targetIds) : null;
	if (jobNumbers && jobNumbers.length === 0) return [];
	const rows = await tenantQuery(companyDb,
		`SELECT r.id, r.job_number, COALESCE(r.master_stock_id, u.master_stock_id) AS master_stock_id,
		        r.parts_cost, r.labour_cost, r.other_cost, r.total_cost,
		        r.gl_capitalisation_version, r.gl_capitalisation_journal_id,
		        DATE_FORMAT(r.completed_at, '%Y-%m-%d') AS doc_date
		 FROM ${rebuildStockBackfillTablesSql(schema)}
		 WHERE ${jobNumbers
			? `r.status = 'STOCKED' AND u.origin_type = 'AUTONEER_REBUILD' AND r.completed_at IS NOT NULL
			   AND r.job_number IN (${jobNumbers.map(() => '?').join(',')})`
			: REBUILD_STOCK_BACKFILL_WHERE_SQL}
		 ORDER BY r.completed_at, r.job_number`,
		jobNumbers || [fromDate, toDate]
	);
	return rows || [];
}

function describeRebuildCapitalisation(journal) {
	const s = journal.summary || {};
	const parts = [`Dr ${s.debitAssetAccnr} ${round2(s.totalCapitalised).toFixed(2)}`];
	if (s.wipCredited > 0.009) parts.push(`Cr WIP ${s.wipAccnr} ${round2(s.wipCredited).toFixed(2)}`);
	for (const credit of s.inventoryCredits || []) parts.push(`Cr Inventory ${credit.accnr} ${round2(credit.amount).toFixed(2)}`);
	if (s.recoveryCredited > 0.009) parts.push(`Cr Recovery ${s.recoveryAccnr} ${round2(s.recoveryCredited).toFixed(2)}`);
	return parts.join('; ');
}

function closedPeriodBackfillMessage(docDate, sourceId) {
	return `Accounting period for ${docDate} is closed. Rebuild capitalisation ${sourceId} was not posted; reopen that period to backfill it (the posting is never moved into the current period).`;
}

/**
 * REBUILD_STOCK backfill. Each stocked rebuild is capitalised on
 * DATE(completed_at) from its stored cost snapshot, using the same journal
 * builder as live completion. Legacy rows (version 0) post version 1.
 *
 * Live posting and the rebuild row's GL metadata are written in one
 * transaction. A dry run validates and reports without touching the row.
 */
async function backfillRebuildStockCapitalisations({
	companyDb, schema, runId, rows, dryRun, staffId, summary, onProcessed, deps = {}
}) {
	const d = {
		getOpenPeriodId,
		prepareRebuildGlContext: rebuildStockAccounting.prepareRebuildGlContext,
		...deps
	};
	const accountingDeps = deps.accountingDeps || undefined;
	const poolQuery = (sql, params) => tenantQuery(companyDb, sql, params);
	const context = await d.prepareRebuildGlContext({ schema, deps: accountingDeps });

	for (const row of rows || []) {
		const storedVersion = Number(row.gl_capitalisation_version) || 0;
		const version = storedVersion > 0 ? storedVersion : 1;
		const sourceId = rebuildStockAccounting.capitalisationSourceId(row.job_number, version);
		const docDate = rebuildStockAccounting.toSqlDate(row.doc_date);
		const item = { companyDb, schema, runId, docType: 'REBUILD_STOCK', source: rebuildStockAccounting.CAPITALISATION_SOURCE, sourceId, docDate };
		const record = async (status, message = null) => {
			await addRunItem({ ...item, status, message });
			summary[String(status).toLowerCase()]++;
		};

		try {
			const existing = await tenantQuery(companyDb,
				`SELECT id FROM ${schema}.gl_journal_headers WHERE source = ? AND source_id = ? LIMIT 1`,
				[rebuildStockAccounting.CAPITALISATION_SOURCE, sourceId]
			);
			if (existing && existing[0]) {
				const journalId = Number(existing[0].id);
				if (!dryRun && Number(row.gl_capitalisation_journal_id) !== journalId) {
					await tenantQuery(companyDb,
						`UPDATE ${schema}.stock_rebuild_jobs
						 SET gl_capitalisation_version = ?, gl_capitalisation_journal_id = ?,
						     gl_capitalised_at = COALESCE(gl_capitalised_at, NOW())
						 WHERE id = ? AND status = 'STOCKED'`,
						[version, journalId, row.id]
					);
				}
				await record('EXISTS');
				continue;
			}

			if (dryRun) {
				const journal = await rebuildStockAccounting.buildRebuildCapitalisationJournal({
					queryFn: poolQuery, schema, rebuild: row, version, trxdate: docDate, asAt: docDate, context, deps: accountingDeps
				});
				if (journal.skipped) {
					await record('SKIPPED', journal.reason);
					continue;
				}
				try {
					// Read-only period check: the pool query stops getOpenPeriodId from
					// bootstrapping a missing period during a dry run.
					await d.getOpenPeriodId(schema, rebuildStockAccounting.toJournalDate(docDate), poolQuery);
				} catch (periodErr) {
					if (periodErr && periodErr.code === 'PERIOD_CLOSED') {
						await record('FAILED', closedPeriodBackfillMessage(docDate, sourceId));
						continue;
					}
					if (!periodErr || periodErr.code !== 'PERIOD_NOT_DEFINED') throw periodErr;
				}
				validateLines(journal.lines);
				await ensureAccountsExist(companyDb, schema, journal.lines.map((line) => line.accnr));
				await record('SKIPPED', `Dry run - would post: ${describeRebuildCapitalisation(journal)}`);
				continue;
			}

			if (Number(row.total_cost) > 0.009) {
				try {
					// Bootstraps a missing period on a pooled connection, like the other
					// backfill types, but a CLOSED period is reported, never worked around.
					await d.getOpenPeriodId(schema, rebuildStockAccounting.toJournalDate(docDate));
				} catch (periodErr) {
					if (periodErr && periodErr.code === 'PERIOD_CLOSED') {
						await record('FAILED', closedPeriodBackfillMessage(docDate, sourceId));
						continue;
					}
					throw periodErr;
				}
			}

			const outcome = await runInCompanyTx(companyDb, async (tx) => {
				const lockedRows = await tx.query(
					`SELECT id, job_number, master_stock_id, status, parts_cost, labour_cost, other_cost, total_cost,
					        gl_capitalisation_version, DATE_FORMAT(completed_at, '%Y-%m-%d') AS doc_date
					 FROM ${schema}.stock_rebuild_jobs WHERE id = ? LIMIT 1 FOR UPDATE`,
					[row.id]
				);
				const locked = lockedRows && lockedRows[0];
				const lockedVersion = locked ? (Number(locked.gl_capitalisation_version) || 0) : 0;
				if (!locked
					|| String(locked.status || '').toUpperCase() !== 'STOCKED'
					|| (lockedVersion > 0 ? lockedVersion : 1) !== version
					|| rebuildStockAccounting.toSqlDate(locked.doc_date) !== docDate) {
					return { status: 'changed' };
				}
				const posted = await rebuildStockAccounting.postRebuildCapitalisation({
					queryFn: tx.query,
					schema,
					rebuild: { ...locked, master_stock_id: locked.master_stock_id || row.master_stock_id },
					version,
					trxdate: docDate,
					asAt: docDate,
					userId: staffId || null,
					context,
					postedAt: rebuildStockAccounting.toJournalDate(docDate),
					createdAt: rebuildStockAccounting.toJournalDate(docDate),
					deps: accountingDeps
				});
				if (posted.status === 'posted') {
					await tx.query(
						`UPDATE ${schema}.stock_rebuild_jobs
						 SET gl_capitalisation_version = ?, gl_capitalisation_journal_id = ?, gl_capitalised_at = NOW()
						 WHERE id = ?`,
						[version, posted.journalId, locked.id]
					);
				}
				return posted;
			}, { maxRetries: 0 });

			if (outcome.status === 'posted') await record('POSTED');
			else if (outcome.status === 'exists') await record('EXISTS');
			else if (outcome.status === 'skipped') await record('SKIPPED', outcome.journal && outcome.journal.reason);
			else await record('SKIPPED', 'Rebuild job changed during the run (reopened or recompleted). Rerun to pick up its current state.');
		} catch (err) {
			const message = err && err.code === 'PERIOD_CLOSED'
				? closedPeriodBackfillMessage(docDate, sourceId)
				: ((err && err.message) || String(err));
			await record('FAILED', message);
			logger.error && logger.error('Rebuild stock capitalisation backfill item failed', {
				runId, job_number: row.job_number, sourceId, err: err && err.stack ? err.stack : err
			});
		} finally {
			if (typeof onProcessed === 'function') await onProcessed();
		}
	}
}

// shouldStop() is checked before each document; a stop ends the run as FAILED with a message saying so.
async function runBackfillJob({ companyDb, schema, runId, fromDate, toDate, types, dryRun, staffId, targetedSourceIds = null, shouldStop = null }) {
	// logger.info && logger.info('Starting GL backfill', { runId, fromDate, toDate, types, dryRun });
	const summary = { posted: 0, exists: 0, failed: 0, skipped: 0, totalDocs: 0, processedDocs: 0, byType: {} };
	const touchedCids = new Set();
	const touchedSuppids = new Set();
	let lastProgressUpdateAt = 0;

	const publishProgress = async (force = false) => {
		const now = Date.now();
		if (!force && now - lastProgressUpdateAt < 250) return;
		lastProgressUpdateAt = now;
		try {
			await updateRunProgress({ companyDb, schema, runId, summary });
		} catch (e) {
			logger.warn && logger.warn('Failed to update backfill run progress', { runId, err: e && e.message });
		}
	};
	// Each selected type's share of the workload, so its progress shows on its own.
	const countDocs = (type, n) => {
		summary.totalDocs += n;
		summary.byType[type].total += n;
	};

	try {
		// Validate seed & period availability (ensure seeds and default periods exist)
		await ensureGlSchemaSeed(schema);
		await ensureDefaultPeriods(schema, fromDate);
		await ensureVatInputAccount({ companyDb, schema });
		const controls = await resolveControlAccounts(schema, ['AP', 'INVENTORY', 'COS', 'VAT_INPUT', 'AR', 'SALES', 'VAT_OUTPUT', 'BANK', 'BAD_DEBTS', 'DISCOUNT', 'CUSTOMER_DEPOSITS'], { refresh: true });
		// quick check: ensure at least one open period in range by trying getOpenPeriodId for fromDate
		try { await getOpenPeriodId(schema, fromDate); } catch (e) {
			throw new Error('Open GL period not found for backfill start date');
		}

		const typeOrder = BACKFILL_TYPE_ORDER;
		const selected = new Set(types || []);

		// Helper to process a list of docs
		async function processDocs(docs, docType, buildFn) {
			for (const d of docs) {
				if (shouldStop && shouldStop()) {
					throw backfillStopped(`Stopped after ${summary.processedDocs} of ${summary.totalDocs} documents. Start it again; nothing is posted twice.`);
				}
				const src = d.source;
				const sid = d.source_id;
				const docDate = formatDateToSql(d.doc_date || d.inv_date || d.paydate || d.inv_date);
				try {
					const journal = await buildFn(d);
					const lines = Array.isArray(journal.lines) ? journal.lines : [];
					const postableLines = lines.filter(ln => {
						const debit = Number(ln && ln.debit ? ln.debit : 0);
						const credit = Number(ln && ln.credit ? ln.credit : 0);
						return debit > 0.0001 || credit > 0.0001;
					});

					// Zero-value docs (common for deposits/unfinalized invoices) are not postable yet.
					if (postableLines.length === 0) {
						await addRunItem({
							companyDb,
							schema,
							runId,
							docType,
							source: journal.source,
							sourceId: journal.sourceId,
							docDate,
							status: 'SKIPPED',
							message: 'No postable amount yet (all journal lines are zero). Likely deposit-only or invoice not finalized.'
						});
						summary.skipped++;
						continue;
					}
					journal.lines = postableLines;

					// validate
					try { validateLines(journal.lines); } catch (vErr) {
						const detail = formatLineValidationDetails(journal.lines);
						const message = detail ? `Validation: ${vErr.message}. ${detail}` : `Validation: ${vErr.message}`;
						await addRunItem({ companyDb, schema, runId, docType, source: journal.source, sourceId: journal.sourceId, docDate, status: 'FAILED', message });
						summary.failed++;
						continue;
					}

					// ensure accounts exist (dry-run also checks)
					const accnrs = journal.lines.map(l => l.accnr);
					try { await ensureAccountsExist(companyDb, schema, accnrs); } catch (aErr) {
						await addRunItem({ companyDb, schema, runId, docType, source: journal.source, sourceId: journal.sourceId, docDate, status: 'FAILED', message: `Account error: ${aErr.message}` });
						summary.failed++;
						continue;
					}

					if (dryRun) {
						// check existence
						try {
							await getJournalBySource(schema, journal.source, journal.sourceId);
							await addRunItem({ companyDb, schema, runId, docType, source: journal.source, sourceId: journal.sourceId, docDate, status: 'EXISTS', message: null });
							summary.exists++;
						} catch (notFoundErr) {
							await addRunItem({ companyDb, schema, runId, docType, source: journal.source, sourceId: journal.sourceId, docDate, status: 'SKIPPED', message: 'Dry run - would post' });
							summary.skipped++;
						}
						continue;
					}

					if (docType === 'DEBTOR_INVOICE') {
						const expectedPartLineCount = countExpectedDebtorInvoicePartLines(journal.lines, controls);
						if (expectedPartLineCount > 0) {
							try {
								const existingJournal = await getJournalBySource(schema, journal.source, journal.sourceId);
								const existingPartLineCount = countExistingDebtorInvoicePartLines(existingJournal.lines, controls);
								if (existingPartLineCount < expectedPartLineCount) {
									await deleteGlJournalBySource(schema, journal.source, journal.sourceId);
								}
							} catch (existingErr) {
								if (!(existingErr && existingErr.code === 'JOURNAL_NOT_FOUND')) throw existingErr;
							}
						}
					}

					// perform post
					const res = await postJournal({ schema, source: journal.source, sourceId: journal.sourceId, trxdate: journal.trxdate, description: journal.description, lines: journal.lines, userId: staffId, extraRefs: journal.extraRefs || {}, postedAt: journal.trxdate, createdAt: journal.trxdate });
					if (res && res.status === 'exists') {
						await addRunItem({ companyDb, schema, runId, docType, source: journal.source, sourceId: journal.sourceId, docDate, status: 'EXISTS', message: null });
						summary.exists++;
						if (journal.extraRefs?.cid) touchedCids.add(Number(journal.extraRefs.cid));
						if (journal.extraRefs?.suppid) touchedSuppids.add(Number(journal.extraRefs.suppid));
						// If the journal already exists (was previously posted), ensure the source invoice
						// record is marked as POSTED so the source tables reflect the posted state.
						try {
							if (journal && journal.source === 'DEBTOR_INVOICE') {
								await tenantQuery(companyDb, `UPDATE ${schema}.invoices i LEFT JOIN ${schema}.job_information j ON j.job_number = i.job_number SET i.status = 'POSTED', i.posted_at = COALESCE(i.posted_at, ?) WHERE i.invoice_nr = ? AND UPPER(COALESCE(i.status, '')) <> 'QUOTE' AND UPPER(COALESCE(j.status, '')) <> 'QUOTE' AND (i.status IS NULL OR i.status != 'POSTED')`, [docDate, journal.sourceId]).catch(() => { });
							} else if (journal && !journal.skipSourceStatus && (journal.source === 'CREDITOR_INVOICE' || journal.source === 'CREDITOR_RFC')) {
								const supplierInvoiceNr = journal.extraRefs?.invoice_nr || journal.sourceId;
								const supplierId = journal.extraRefs?.suppid || null;
								if (supplierId) {
									await tenantQuery(companyDb, `UPDATE ${schema}.invoices_supplier SET status = 'POSTED', posted_at = COALESCE(posted_at, ?) WHERE suppid = ? AND invoice_nr = ? AND (status IS NULL OR status != 'POSTED')`, [docDate, supplierId, supplierInvoiceNr]).catch(() => { });
								} else {
									await tenantQuery(companyDb, `UPDATE ${schema}.invoices_supplier SET status = 'POSTED', posted_at = COALESCE(posted_at, ?) WHERE invoice_nr = ? AND (status IS NULL OR status != 'POSTED')`, [docDate, supplierInvoiceNr]).catch(() => { });
								}
							} else if (journal && journal.source === 'DEBTOR_PAYMENT') {
								await tenantQuery(companyDb, `UPDATE ${schema}.payments SET capturedate = COALESCE(capturedate, ?) WHERE payid = ?`, [docDate, journal.sourceId]).catch(() => { });
							} else if (journal && ['INVOICE_DISCOUNT', 'INVOICE_WRITE_OFF', 'DEBTOR_INVOICE_CREDIT'].includes(journal.source) && String(journal.sourceId || '').startsWith('PAYMENT-')) {
								await tenantQuery(companyDb, `UPDATE ${schema}.payments SET capturedate = COALESCE(capturedate, ?) WHERE payid = ?`, [docDate, String(journal.sourceId).slice(8)]).catch(() => { });
							} else if (journal && journal.source === 'CREDITOR_PAYMENT') {
								await tenantQuery(companyDb, `UPDATE ${schema}.payments_suppliers SET status = 'POSTED' WHERE payid = ? AND (status IS NULL OR status != 'POSTED')`, [journal.sourceId]).catch(() => { });
							}
						} catch (e) { /* ignore source status update failures */ }
					} else {
						await addRunItem({ companyDb, schema, runId, docType, source: journal.source, sourceId: journal.sourceId, docDate, status: 'POSTED', message: null });
						summary.posted++;
						if (journal.extraRefs?.cid) touchedCids.add(Number(journal.extraRefs.cid));
						if (journal.extraRefs?.suppid) touchedSuppids.add(Number(journal.extraRefs.suppid));
						// mark source record as posted when applicable
						try {
							if (journal && journal.source === 'DEBTOR_INVOICE') {
								await tenantQuery(companyDb, `UPDATE ${schema}.invoices i LEFT JOIN ${schema}.job_information j ON j.job_number = i.job_number SET i.status = 'POSTED', i.posted_at = COALESCE(i.posted_at, ?) WHERE i.invoice_nr = ? AND UPPER(COALESCE(i.status, '')) <> 'QUOTE' AND UPPER(COALESCE(j.status, '')) <> 'QUOTE'`, [docDate, journal.sourceId]).catch(() => { });
							} else if (journal && !journal.skipSourceStatus && (journal.source === 'CREDITOR_INVOICE' || journal.source === 'CREDITOR_RFC')) {
								const supplierInvoiceNr = journal.extraRefs?.invoice_nr || journal.sourceId;
								const supplierId = journal.extraRefs?.suppid || null;
								if (supplierId) {
									await tenantQuery(companyDb, `UPDATE ${schema}.invoices_supplier SET status = 'POSTED', posted_at = COALESCE(posted_at, ?) WHERE suppid = ? AND invoice_nr = ?`, [docDate, supplierId, supplierInvoiceNr]).catch(() => { });
								} else {
									await tenantQuery(companyDb, `UPDATE ${schema}.invoices_supplier SET status = 'POSTED', posted_at = COALESCE(posted_at, ?) WHERE invoice_nr = ?`, [docDate, supplierInvoiceNr]).catch(() => { });
								}
							} else if (journal && journal.source === 'DEBTOR_PAYMENT') {
								await tenantQuery(companyDb, `UPDATE ${schema}.payments SET capturedate = COALESCE(capturedate, ?) WHERE payid = ?`, [docDate, journal.sourceId]).catch(() => { });
							} else if (journal && ['INVOICE_DISCOUNT', 'INVOICE_WRITE_OFF', 'DEBTOR_INVOICE_CREDIT'].includes(journal.source) && String(journal.sourceId || '').startsWith('PAYMENT-')) {
								await tenantQuery(companyDb, `UPDATE ${schema}.payments SET capturedate = COALESCE(capturedate, ?) WHERE payid = ?`, [docDate, String(journal.sourceId).slice(8)]).catch(() => { });
							} else if (journal && journal.source === 'CREDITOR_PAYMENT') {
								await tenantQuery(companyDb, `UPDATE ${schema}.payments_suppliers SET status = 'POSTED' WHERE payid = ?`, [journal.sourceId]).catch(() => { });
							}
						} catch (e) { /* ignore source status update failures */ }
					}
				} catch (err) {
					await addRunItem({ companyDb, schema, runId, docType, source: d.source || docType, sourceId: d.source_id || d.payid || d.invoice_nr, docDate, status: 'FAILED', message: (err && err.message) || String(err) });
					summary.failed++;
					logger.error && logger.error('Backfill item failed', { runId, docType, source: d.source, source_id: d.source_id, err: err && err.stack ? err.stack : err });
				} finally {
					summary.processedDocs++;
					await publishProgress(summary.processedDocs === summary.totalDocs);
				}
			}
		}

		// Calculate total workload up-front so UI can render real progress.
		for (const t of typeOrder) {
			if (!selected.has(t)) continue;
			summary.byType[t] = { total: 0 };
			// In targeted mode, count is just the number of specific IDs for this type
			if (targetedSourceIds && Array.isArray(targetedSourceIds[t])) {
				const targetIds = targetedSourceIds[t];
				if (t === 'DEBTOR_INVOICE') {
					const numericIds = targetIds.map(Number).filter(id => Number.isInteger(id) && id > 0);
					if (numericIds.length > 0) {
						const ph = numericIds.map(() => '?').join(',');
						const debtorInvoiceEligibilitySql = buildDebtorInvoiceBackfillEligibilitySql(schema, 'i');
						const [r] = await tenantQuery(companyDb,
							`SELECT COUNT(*) AS cnt
							 FROM ${schema}.invoices i
							 WHERE i.invoice_nr IN (${ph})
							   AND ${debtorInvoiceEligibilitySql}`,
							numericIds
						);
						countDocs(t, Number(r && r.cnt ? r.cnt : 0));
					}
					continue;
				}
				if (t === 'DEBTOR_PAYMENT') {
					const numericIds = targetIds.map(Number).filter(Boolean);
					if (numericIds.length > 0) {
						const ph = numericIds.map(() => '?').join(',');
						const [r] = await tenantQuery(companyDb, `SELECT COUNT(*) AS cnt FROM ${schema}.payments p WHERE p.payid IN (${ph}) AND ${DEBTOR_PAYMENT_BACKFILL_SQL}`, numericIds);
						countDocs(t, Number(r && r.cnt ? r.cnt : 0));
					}
					continue;
				}
				if (t === 'REBUILD_STOCK') {
					const rebuildRows = await loadRebuildStockBackfillRows({ companyDb, schema, fromDate, toDate, targetIds });
					countDocs(t, rebuildRows.length);
					continue;
				}
				if (t === 'CREDITOR_PAYMENT') {
					const exists = await tableExists(companyDb, schema, 'payments_suppliers');
					const numericIds = targetIds.map(Number).filter(Boolean);
					if (exists && numericIds.length > 0) {
						const ph = numericIds.map(() => '?').join(',');
						const [r] = await tenantQuery(companyDb, `SELECT COUNT(*) AS cnt FROM ${schema}.payments_suppliers p WHERE p.payid IN (${ph}) AND ${SUPPLIER_PAYMENT_BACKFILL_SQL}`, numericIds);
						countDocs(t, Number(r && r.cnt ? r.cnt : 0));
					}
					continue;
				}
				countDocs(t, targetIds.length);
				continue;
			}
			if (t === 'CREDITOR_INVOICE') {
				// The headers the run selects below; each one ends as a run item.
				const [r] = await tenantQuery(companyDb,
					`SELECT COUNT(*) AS cnt FROM ${schema}.invoices_supplier si
					 WHERE si.inv_date BETWEEN ? AND ?
					   AND (UPPER(TRIM(COALESCE(si.status, ''))) IN ('DONE', 'POSTED', 'CREDIT') OR ${legacyRfcIdSql(schema, 'si')} IS NOT NULL)
					   AND si.voided_at IS NULL`,
					[fromDate, toDate]
				);
				countDocs(t, Number(r && r.cnt ? r.cnt : 0));
				continue;
			}
			if (t === 'REBUILD_STOCK') {
				if (!(await tableExists(companyDb, schema, 'stock_rebuild_jobs'))) continue;
				const [r] = await tenantQuery(companyDb,
					`SELECT COUNT(*) AS cnt FROM ${rebuildStockBackfillTablesSql(schema)} WHERE ${REBUILD_STOCK_BACKFILL_WHERE_SQL}`,
					[fromDate, toDate]
				);
				countDocs(t, Number(r && r.cnt ? r.cnt : 0));
				continue;
			}
			if (t === 'DEBTOR_INVOICE') {
				const debtorInvoiceEligibilitySql = buildDebtorInvoiceBackfillEligibilitySql(schema, 'i');
				const [r] = await tenantQuery(companyDb,
					`SELECT COUNT(*) AS cnt
					 FROM ${schema}.invoices i
					 WHERE i.invoice_date BETWEEN ? AND ?
					   AND ${debtorInvoiceEligibilitySql}`,
					[fromDate, toDate]
				);
				countDocs(t, Number(r && r.cnt ? r.cnt : 0));
				continue;
			}
			if (t === 'DEBTOR_PAYMENT') {
				const [r] = await tenantQuery(companyDb, `SELECT COUNT(*) AS cnt FROM ${schema}.payments p WHERE p.paydate BETWEEN ? AND ? AND ${DEBTOR_PAYMENT_BACKFILL_SQL}`, [fromDate, toDate]);
				countDocs(t, Number(r && r.cnt ? r.cnt : 0));
				continue;
			}
			if (t === 'CREDITOR_PAYMENT') {
				const exists = await tableExists(companyDb, schema, 'payments_suppliers');
				if (!exists) continue;
				const [r] = await tenantQuery(companyDb, `SELECT COUNT(*) AS cnt FROM ${schema}.payments_suppliers p WHERE p.paydate BETWEEN ? AND ? AND ${SUPPLIER_PAYMENT_BACKFILL_SQL}`, [fromDate, toDate]);
				countDocs(t, Number(r && r.cnt ? r.cnt : 0));
			}
		}
		await publishProgress(true);

		// For each type in order
		for (const t of typeOrder) {
			if (!selected.has(t)) continue;
			summary.currentType = t;
			await publishProgress(true);
			// load docs for this type
			if (t === 'CREDITOR_INVOICE') {
				let rows;
				const targetIds = targetedSourceIds && Array.isArray(targetedSourceIds.CREDITOR_INVOICE) ? targetedSourceIds.CREDITOR_INVOICE : null;
				// Posted supplier invoices, plus migrated legacy returns in their legacy status.
				const legacyRfcId = legacyRfcIdSql(schema, 'si');
				const creditorRowsSql = (where) => `SELECT sinvid AS id, inv_date AS doc_date, invoice_nr AS invoice_nr, suppid, status, amount, amountexvat, vat, purchasetype, ${legacyRfcId} AS legacy_rfc_id FROM ${schema}.invoices_supplier si WHERE ${where} AND (UPPER(TRIM(COALESCE(status, ''))) IN ('DONE', 'POSTED', 'CREDIT') OR ${legacyRfcId} IS NOT NULL) AND voided_at IS NULL`;
				if (targetIds && targetIds.length > 0) {
						const target = buildCreditorInvoiceTargetFilter(targetIds);
						rows = await tenantQuery(companyDb, creditorRowsSql(`(${target.sql})`), target.params);
				} else if (targetIds) {
					rows = []; // empty target list — nothing to post
				} else {
						rows = await tenantQuery(companyDb, creditorRowsSql('inv_date BETWEEN ? AND ?'), [fromDate, toDate]);
				}
				// The AP / VAT Input / Inventory / WIP controls live supplier posting uses.
				const supplierControls = await resolveSupplierAssetControls(schema);
				// Whether a job had a WIP-relieving customer invoice (the same
				// invoices the DEBTOR_INVOICE backfill posts) on or before a date.
				const debtorInvoiceEligibilitySqlForRfc = buildDebtorInvoiceBackfillEligibilitySql(schema, 'i');
				const jobFinalisedByDate = new Map();
				const isJobFinalisedByDate = async (jobNumber, docDate) => {
					// Local calendar day: mysql2 returns DATE columns as local midnight.
					const date = rebuildStockAccounting.toSqlDate(docDate);
					const key = `${jobNumber}|${date}`;
					if (!jobFinalisedByDate.has(key)) {
						// The eligible statuses already exclude VOID invoices.
						const finalisedRows = await tenantQuery(companyDb,
							`SELECT i.invoice_nr
							 FROM ${schema}.invoices i
							 WHERE i.job_number = ?
							   AND i.invoice_date <= ?
							   AND ${debtorInvoiceEligibilitySqlForRfc}
							 LIMIT 1`,
							[jobNumber, date]
						);
						jobFinalisedByDate.set(key, Boolean(finalisedRows && finalisedRows[0]));
					}
					return jobFinalisedByDate.get(key);
				};
				// buildCreditorJournal for supplier invoice — per-stock-item GL resolution
				const buildCreditorJournal = async (row) => {
					if (row.duplicateHeaderCount > 1) {
						const err = new Error('Multiple supplier invoice headers share one supplier and invoice number. Review the source records before posting a GL journal.');
						err.code = 'SUPPLIER_INVOICE_SOURCE_COLLISION';
						throw err;
					}
					const isRfc = String(row.invoice_nr || '').toUpperCase().endsWith('-RFC')
						|| Number(row.amount || 0) < -0.009
						|| Number(row.amountexvat || 0) < -0.009;
					const isGeneral = String(row.purchasetype || '').trim().toUpperCase() === 'GENERAL';
					const suppid = row.suppid || null;
					const creditorInvoiceSourceId = await resolveCreditorInvoiceSourceId(companyDb, schema, suppid, row.invoice_nr);
					if (isGeneral) {
						// A failed read must fail the item, not post the header gap to COS.
						const generalLines = await tenantQuery(companyDb,
							`SELECT ig.amountexvat, ig.vat, ig.accnr
							 FROM ${schema}.invoice_general ig
							 WHERE ig.suppid = ? AND ig.invoice_nr = ?`,
							[suppid, row.invoice_nr]
						);
						let totalVat = 0;
						let expenseDebitTotal = 0;
						const headerTotal = Math.abs(Number(row.amount || 0));
						const candidateLines = [isRfc
							? { accnr: controls.AP, debit: headerTotal, credit: 0, suppid, invoice_nr: row.invoice_nr }
							: { accnr: controls.AP, debit: 0, credit: headerTotal, suppid, invoice_nr: row.invoice_nr }];

						for (const ln of generalLines || []) {
							const lineExVat = Math.abs(Number(ln.amountexvat || 0));
							totalVat += Math.abs(Number(ln.vat || 0));
							if (lineExVat <= 0.009 || !ln.accnr) continue;
							expenseDebitTotal += lineExVat;
							candidateLines.unshift({
								accnr: Number(ln.accnr),
								debit: isRfc ? 0 : Math.round(lineExVat * 100) / 100,
								credit: isRfc ? Math.round(lineExVat * 100) / 100 : 0,
								suppid,
								invoice_nr: row.invoice_nr
							});
						}

						totalVat = Math.round(totalVat * 100) / 100;
						if (totalVat > 0.009) {
							expenseDebitTotal += totalVat;
							candidateLines.splice(candidateLines.length - 1, 0, {
								accnr: controls.VAT_INPUT,
								debit: isRfc ? 0 : totalVat,
								credit: isRfc ? totalVat : 0,
								suppid,
								invoice_nr: row.invoice_nr
							});
						}

						const gap = Math.round((headerTotal - expenseDebitTotal) * 100) / 100;
						if (gap > 0.009) {
							candidateLines.unshift({
								accnr: controls.COS,
								debit: isRfc ? 0 : gap,
								credit: isRfc ? gap : 0,
								suppid,
								invoice_nr: row.invoice_nr
							});
						}

						return {
							source: isRfc ? 'CREDITOR_RFC' : 'CREDITOR_INVOICE',
							sourceId: isRfc ? row.invoice_nr : creditorInvoiceSourceId,
							trxdate: row.doc_date,
							description: isRfc ? `RFC ${row.invoice_nr}` : `Supplier expense invoice ${row.invoice_nr}`,
							lines: candidateLines.filter(ln => (ln.debit || 0) > 0.0001 || (ln.credit || 0) > 0.0001),
							extraRefs: { suppid, invoice_nr: row.invoice_nr }
						};
					}
					// Load invoice lines with stock_id for per-item GL resolution.
					// Never swallow a failed read: an empty result means "no lines",
					// which posts the whole header to Cost of Sales below — the wrong
					// journal for job-linked (WIP) and stock (Inventory) lines. A read
					// error fails this document's backfill item instead.
					const items = await tenantQuery(companyDb,
						`SELECT ii.amount, ii.amountexvat, ii.discount, ii.vat, ii.quantity,
						        ii.job_number, ii.partnr, ii.stock_id, ii.siid, ii.accasset,
						        s.stocktype
						 FROM ${schema}.invoice_items ii
						 LEFT JOIN ${schema}.stock s ON s.stock_id = ii.stock_id
						 WHERE ii.suppid = ?
						   AND ii.invoice_nr = ?`,
						[suppid, row.invoice_nr]
					);
					const headerTotal = Math.round(Math.abs(Number(row.amount || 0)) * 100) / 100;
					let totalAmount = 0; let totalVat = 0;
					for (const ln of items || []) {
						const lineAmounts = getCreditorInvoiceLinePostingAmounts(ln);
						totalAmount += lineAmounts.amountIncVat;
						if (lineAmounts.amountExVat > 0.009) totalVat += lineAmounts.vat;
					}

					// Header-level fallback: no invoice_items rows — synthesize from header totals
					const isHeaderFallback = (items || []).length === 0 && Math.abs(Number(row.amount || 0)) > 0.009;
					if (isHeaderFallback) {
						totalAmount = headerTotal;
						totalVat = Math.round(Math.abs(Number(row.vat || 0)) * 100) / 100;
					} else {
						totalVat = getCreditorInvoiceVatToPost({
							headerAmount: row.amount,
							headerVat: row.vat,
							lineExVat: (items || []).reduce((sum, ln) => sum + getCreditorInvoiceLinePostingAmounts(ln).amountExVat, 0),
							lineVat: totalVat
						});
					}
					const apTotal = headerTotal > 0.009 ? headerTotal : Math.round(totalAmount * 100) / 100;

					const candidateLines = [isRfc
						? { accnr: controls.AP, debit: apTotal, credit: 0, suppid, invoice_nr: row.invoice_nr }
						: { accnr: controls.AP, debit: 0, credit: apTotal, suppid, invoice_nr: row.invoice_nr }];

					// Validate siid/accasset values from invoice_items against gl_accounts (legacy data may contain stale accnrs)
					const itemRawAccnrs = (items || []).flatMap(ln => [ln.siid, ln.accasset]).filter(Boolean).map(Number);
					const validItemAccnrs = await resolveValidAccnrs(companyDb, schema, itemRawAccnrs);

					// Per-item GL resolution for WIP/Inventory accounts
					for (const ln of items || []) {
						const hasJob = !!(ln.job_number || '').toString().trim();
						const { amountExVat: lineExVat } = getCreditorInvoiceLinePostingAmounts(ln);
						if (lineExVat <= 0.009) continue;
						const rfcJobNumber = isRfc ? normalizeJobNumber(ln.job_number) : null;
						if (rfcJobNumber) {
							// Legacy RFC of job-linked cost, resolved like live processSupplierRfc:
							// while the job was unfinalised the cost sat in WIP, so the return
							// credits that WIP with its job and never strands it there. Once the
							// job was finalised on or before the RFC date, finalise had already
							// relieved WIP to Cost of Sales, so the return credits COS.
							let rfcAccnr;
							if (!(await isJobFinalisedByDate(rfcJobNumber, row.doc_date))) {
								rfcAccnr = requireSupplierWipAccount(supplierControls, rfcJobNumber);
							} else {
								try {
									rfcAccnr = (await resolveStockGlAccounts({
										schema,
										stockId: ln.stock_id || null,
										partnr: ln.partnr || null,
										txnType: 'PARTS'
									})).cosAccnr;
								} catch (resolveErr) {
									rfcAccnr = null;
								}
								rfcAccnr = rfcAccnr || controls.COS;
							}
							candidateLines.unshift({
								accnr: rfcAccnr,
								debit: 0,
								credit: Math.round(lineExVat * 100) / 100,
								suppid,
								job_number: rfcJobNumber,
								invoice_nr: row.invoice_nr
							});
							continue;
						}
						if (!isRfc) {
							// Supplier invoices resolve their debit exactly like live posting
							// (resolveCreditorInvoiceLineAccount): job-linked cost is Work in
							// Progress, tagged with its job so finalise and rebuild
							// capitalisation can relieve it. A stock line keeps a valid legacy
							// asset snapshot, otherwise the item's asset account.
							const jobNumber = normalizeJobNumber(ln.job_number);
							const lineAccAsset = (ln.accasset && validItemAccnrs.has(Number(ln.accasset))) ? Number(ln.accasset) : null;
							if (isWorkshopAsset(ln) && !lineAccAsset) {
								throw new Error(`Asset/Tool ${ln.partnr || ln.stock_id || 'line'} has no valid original Fixed Asset account snapshot; accounting repair cannot use Inventory.`);
							}
							candidateLines.unshift({
								accnr: (!jobNumber && lineAccAsset) || await resolveCreditorInvoiceLineAccount(schema, ln, supplierControls),
								debit: Math.round(lineExVat * 100) / 100,
								credit: 0,
								suppid,
								job_number: jobNumber,
								invoice_nr: row.invoice_nr
							});
							continue;
						}
						// Prefer legacy snapshot accounts captured at transaction time.
						// For job-linked creditor lines, some tenants store a holding/asset
						// account in accasset (for example sublets) and the sale-side COS
						// is only recognised later on the debtor invoice.
						const lineAccCos = (ln.siid && validItemAccnrs.has(Number(ln.siid))) ? Number(ln.siid) : null;
						const lineAccAsset = (ln.accasset && validItemAccnrs.has(Number(ln.accasset))) ? Number(ln.accasset) : null;
						const lineAccnr = hasJob ? (lineAccAsset || lineAccCos) : lineAccAsset;
						if (lineAccnr) {
							candidateLines.unshift({
								accnr: lineAccnr,
								debit: isRfc ? 0 : Math.round(lineExVat * 100) / 100,
								credit: isRfc ? Math.round(lineExVat * 100) / 100 : 0,
								suppid,
								invoice_nr: row.invoice_nr
							});
						} else {
							if (isWorkshopAsset(ln)) {
								throw new Error(`Asset/Tool ${ln.partnr || ln.stock_id || 'line'} has no valid original Fixed Asset account snapshot; accounting repair cannot use Inventory.`);
							}
							try {
								const itemAccounts = await resolveStockGlAccounts({
									schema,
									stockId: ln.stock_id || null,
									partnr: ln.partnr || null,
									txnType: 'PARTS'
								});
								candidateLines.unshift({
									accnr: hasJob ? itemAccounts.cosAccnr : itemAccounts.assetAccnr,
									debit: isRfc ? 0 : Math.round(lineExVat * 100) / 100,
									credit: isRfc ? Math.round(lineExVat * 100) / 100 : 0,
									suppid,
									invoice_nr: row.invoice_nr
								});
							} catch (resolveErr) {
								// Fallback to system defaults
								candidateLines.unshift({
									accnr: hasJob ? controls.COS : controls.INVENTORY,
									debit: isRfc ? 0 : Math.round(lineExVat * 100) / 100,
									credit: isRfc ? Math.round(lineExVat * 100) / 100 : 0,
									suppid,
									invoice_nr: row.invoice_nr
								});
							}
						}
					}

					const itemExVatTotal = round2((items || []).reduce(
						(sum, ln) => sum + getCreditorInvoiceLinePostingAmounts(ln).amountExVat,
						0
					));
					const settled = isHeaderFallback
						? { vat: totalVat, gap: 0 }
						: settleCreditorLineGap({ apTotal, vatToPost: totalVat, headerVat: row.vat, itemExVatTotal });
					totalVat = settled.vat;
					if (Math.abs(settled.gap) > 0.009) {
						// A header above its lines debits the difference to Cost of Sales; a
						// header below them credits it.
						const cosDebit = (settled.gap > 0) !== isRfc;
						candidateLines.unshift({
							accnr: controls.COS,
							debit: cosDebit ? Math.abs(settled.gap) : 0,
							credit: cosDebit ? 0 : Math.abs(settled.gap),
							suppid,
							invoice_nr: row.invoice_nr
						});
					}

					// Header fallback expense line (no invoice_items — use COS as default account)
					if (isHeaderFallback) {
						const rawExVat = Math.abs(Number(row.amountexvat || 0));
						const headerExVat = rawExVat > 0.009 ? Math.round(rawExVat * 100) / 100 : Math.round((totalAmount - totalVat) * 100) / 100;
						if (headerExVat > 0.009) {
							candidateLines.unshift({
								accnr: controls.COS,
								debit: isRfc ? 0 : headerExVat,
								credit: isRfc ? headerExVat : 0,
								suppid,
								invoice_nr: row.invoice_nr
							});
						}
					}

					if (totalVat > 0.009) candidateLines.splice(candidateLines.length - 1, 0, {
						accnr: controls.VAT_INPUT,
						debit: isRfc ? 0 : totalVat,
						credit: isRfc ? totalVat : 0,
						suppid,
						invoice_nr: row.invoice_nr
					});
					const lines = candidateLines.filter(ln => (ln.debit || 0) > 0.0001 || (ln.credit || 0) > 0.0001);
					return {
						source: isRfc ? 'CREDITOR_RFC' : 'CREDITOR_INVOICE',
						sourceId: isRfc ? row.invoice_nr : creditorInvoiceSourceId,
						trxdate: row.doc_date,
						description: isRfc ? `RFC ${row.invoice_nr}` : `Supplier invoice ${row.invoice_nr}`,
						lines,
						extraRefs: { suppid, invoice_nr: row.invoice_nr }
					};
				};
				const buildFn = async (row) => {
					const journal = await buildCreditorJournal(row);
					if (journal.source === 'CREDITOR_RFC' && row.legacy_rfc_id) {
						Object.assign(journal, await legacyRfcJournalIdentity(companyDb, schema, row));
					}
					return journal;
				};
				// A journal source is keyed by supplier and invoice number, so headers
				// sharing that identity post at most one journal. Legacy duplicates
				// repeat a header over the lines they share: the header whose total
				// matches those lines posts them and each other one is skipped as its
				// duplicate. With no matching header, every one of them fails for review.
				const groupedRows = new Map();
				for (const r of rows) {
					const key = `${r.suppid}::${String(r.invoice_nr || '')}`;
					if (!groupedRows.has(key)) groupedRows.set(key, []);
					groupedRows.get(key).push(r);
				}
				const findMatchingHeader = async (headers) => {
					if (headers.some((h) => String(h.purchasetype || '').trim().toUpperCase() === 'GENERAL')) return null;
					const items = await tenantQuery(companyDb,
						`SELECT amount, amountexvat, discount, vat, quantity FROM ${schema}.invoice_items WHERE suppid = ? AND invoice_nr = ?`,
						[headers[0].suppid, headers[0].invoice_nr]
					);
					if (!items.length) return null;
					const linesTotal = round2(items.reduce((sum, ln) => sum + getCreditorInvoiceLinePostingAmounts(ln).amountIncVat, 0));
					return headers.slice().sort((a, b) => Number(a.id) - Number(b.id))
						.find((h) => Math.abs(round2(Math.abs(Number(h.amount) || 0)) - linesTotal) <= 0.05) || null;
				};
				const docsToPost = [];
				for (const headers of groupedRows.values()) {
					const keeper = headers.length > 1 ? await findMatchingHeader(headers) : headers[0];
					docsToPost.push({ ...(keeper || headers[0]), duplicateHeaderCount: keeper ? 1 : headers.length });
					for (const h of headers.filter((x) => x !== (keeper || headers[0]))) {
						const status = keeper ? 'SKIPPED' : 'FAILED';
						await addRunItem({
							companyDb, schema, runId, docType: 'CREDITOR_INVOICE', source: 'CREDITOR_INVOICE', sourceId: h.invoice_nr,
							docDate: formatDateToSql(h.doc_date), status,
							message: keeper
								? `Duplicate of supplier invoice header ${keeper.id}, which has the same supplier and invoice number and posts their lines.`
								: 'Multiple supplier invoice headers share one supplier and invoice number. Review the source records before posting a GL journal.'
						});
						summary[keeper ? 'skipped' : 'failed']++;
						summary.processedDocs++;
						await publishProgress();
					}
				}
				await processDocs(docsToPost.map(r => ({ source: 'CREDITOR_INVOICE', source_id: r.invoice_nr, doc_date: r.doc_date, invoice_nr: r.invoice_nr, suppid: r.suppid, status: r.status, amount: r.amount, amountexvat: r.amountexvat, vat: r.vat, purchasetype: r.purchasetype, legacy_rfc_id: r.legacy_rfc_id || null, duplicateHeaderCount: r.duplicateHeaderCount })), 'CREDITOR_INVOICE', async (d) => buildFn(d));
			}

			if (t === 'REBUILD_STOCK') {
				const targetIds = targetedSourceIds && Array.isArray(targetedSourceIds.REBUILD_STOCK) ? targetedSourceIds.REBUILD_STOCK : null;
				const rows = await loadRebuildStockBackfillRows({ companyDb, schema, fromDate, toDate, targetIds });
				await backfillRebuildStockCapitalisations({
					companyDb,
					schema,
					runId,
					rows,
					dryRun,
					staffId,
					summary,
					onProcessed: async () => {
						summary.processedDocs++;
						await publishProgress(summary.processedDocs === summary.totalDocs);
					}
				});
			}

			if (t === 'DEBTOR_INVOICE') {
				let rows;
				const debtorInvoiceEligibilitySql = buildDebtorInvoiceBackfillEligibilitySql(schema, 'i');
				const targetIds = targetedSourceIds && Array.isArray(targetedSourceIds.DEBTOR_INVOICE) ? targetedSourceIds.DEBTOR_INVOICE : null;
				if (targetIds && targetIds.length > 0) {
					const ph = targetIds.map(() => '?').join(',');
					rows = await tenantQuery(companyDb,
						`SELECT i.invoice_nr, i.invoice_date AS doc_date, i.job_number, i.cid
						 FROM ${schema}.invoices i
						 WHERE i.invoice_nr IN (${ph})
						   AND ${debtorInvoiceEligibilitySql}`,
						targetIds
					);
				} else if (targetIds) {
					rows = [];
				} else {
					rows = await tenantQuery(companyDb,
						`SELECT i.invoice_nr, i.invoice_date AS doc_date, i.job_number, i.cid
						 FROM ${schema}.invoices i
						 WHERE i.invoice_date BETWEEN ? AND ?
						   AND ${debtorInvoiceEligibilitySql}`,
						[fromDate, toDate]
					);
				}
				const excludedLinesCosted = await areExcludedLinesCosted(companyDb, schema);
				const buildFn = async (row) => {
					// Re-check eligibility immediately before posting. Selection and
					// posting are separate operations, so a reopened/draft invoice must
					// not slip through if its state changes while the run is active.
					const headerRows = await tenantQuery(companyDb,
						`SELECT i.inv_totalexlvat AS ex, i.inv_totalinclvat AS inc, i.inv_totalvat AS vat
						 FROM ${schema}.invoices i
						 WHERE i.invoice_nr = ?
						   AND ${debtorInvoiceEligibilitySql}
						 LIMIT 1`,
						[row.invoice_nr]
					);
					if (!headerRows || !headerRows[0]) {
						throw new Error(`Invoice ${row.invoice_nr} is not eligible for debtor GL backfill: a final status and invoice-linked lines are required.`);
					}
					const h = headerRows && headerRows[0] ? headerRows[0] : {};
					const { totalIncVat, postedVat, revenueTotal } = getBalancedDebtorInvoiceTotals(h);
					const isCreditNote = totalIncVat < 0;
					const invoiceAmount = Math.abs(totalIncVat);
					const lines = [];
					if (invoiceAmount > 0.009) {
						lines.push({
							accnr: controls.AR,
							debit: isCreditNote ? 0 : invoiceAmount,
							credit: isCreditNote ? invoiceAmount : 0,
							job_number: row.job_number,
							cid: row.cid,
							invoice_nr: row.invoice_nr
						});
					}
					if (Math.abs(postedVat) > 0.009) {
						lines.push({
							accnr: controls.VAT_OUTPUT,
							debit: postedVat < 0 ? Math.abs(postedVat) : 0,
							credit: postedVat > 0 ? postedVat : 0,
							job_number: row.job_number,
							cid: row.cid,
							invoice_nr: row.invoice_nr
						});
					}

					// Per-line revenue reconstruction from job detail tables.
					// Parts relieve inventory; labour uses its explicitly configured
					// cost source/control offset, matching live finalisation.
					if (row.job_number) {
						try {
							// Finalise leaves excluded lines unstamped, so costed excluded
							// lines are reached by job. A credit note never takes them.
							const partScopeSql = isCreditNote
								? 'invoice_nr = ?'
								: '(invoice_nr = ? OR (invoice_nr IS NULL AND COALESCE(is_excluded_from_quote, 0) = 1))';
							const partSaleSql = 'CAST(COALESCE(sales_price, 0) AS DECIMAL(18,2)) - CAST(COALESCE(discountamount, 0) AS DECIMAL(18,2))';
							const partCostSql = 'CAST(cost_price AS DECIMAL(18,6)) * CAST(COALESCE(quantity, 1) AS DECIMAL(18,6))';
							const partsSql = (accountColumns) => `SELECT stock_id, partnr, ${accountColumns} status,
								        CASE WHEN invoice_nr IS NULL THEN 0 ELSE ROUND(${partSaleSql}, 2) END AS item_sale,
								        CASE WHEN ${costedLineSql(excludedLinesCosted, 'PARTS')} THEN ROUND(${partCostSql}, 2) ELSE 0 END AS item_cost
								 FROM ${schema}.spares_used
								 WHERE job_number = ?
								   AND ${partScopeSql}
								   AND UPPER(COALESCE(status, '')) <> 'AWAITING_QUOTE'
								   AND (
								        (invoice_nr IS NOT NULL AND (${partSaleSql}) > 0.009)
								        OR (
										(status IS NULL OR UPPER(status) NOT IN ('AWAITING_QUOTE','ORDER','ORDERED'))
								        	AND ${partCostSql} > 0.009
								        )
								   )`;
							let partsRows = await tenantQuery(companyDb, partsSql('acc, siid, accasset,'), [row.job_number, row.invoice_nr]).catch(() => null);
							if (!Array.isArray(partsRows)) {
								partsRows = await tenantQuery(companyDb, partsSql(''), [row.job_number, row.invoice_nr]).catch(() => []);
							}
							// Validate acc/siid/accasset values from spares_used against gl_accounts (legacy data may contain stale accnrs)
							const partsRawAccnrs = (partsRows || []).flatMap(p => [p.acc, p.siid, p.accasset]).filter(Boolean).map(Number);
							const validPartsAccnrs = await resolveValidAccnrs(companyDb, schema, partsRawAccnrs);
							const lineRefs = { job_number: row.job_number, cid: row.cid, invoice_nr: row.invoice_nr };
							let mappedRevenueTotal = 0;
							const costedParts = [];
							for (const part of partsRows || []) {
								const sale = round2(part.item_sale);
								const cost = round2(part.item_cost);
								const isOrdered = ['AWAITING_QUOTE', 'ORDER', 'ORDERED'].includes(String(part.status || '').toUpperCase());
								const partAccRevenue = (part.acc && validPartsAccnrs.has(Number(part.acc))) ? Number(part.acc) : null;
								if (sale > 0.009) {
									lines.push({ accnr: partAccRevenue || controls.SALES, credit: sale, ...lineRefs });
									mappedRevenueTotal += sale;
								}
								if (isOrdered || cost <= 0.009) continue;
								costedParts.push({ ...part, cost });
							}
							// Supplier WIP is relieved by the original invoice, never by its credit note.
							const { wipAccnr, total: wipBalance } = isCreditNote
								? { wipAccnr: null, total: 0 }
								: await getJobWipDebitedTotal((sql, params) => tenantQuery(companyDb, sql, params), schema, row.job_number);
							lines.push(...await buildDebtorInvoicePartCostLines({
								parts: costedParts,
								wipBalance,
								wipAccnr,
								refs: lineRefs,
								// Prefer siid/accasset captured at transaction time; fall back to resolveStockGlAccounts
								resolveAccounts: async (part) => {
									const partAccCos = (part.siid && validPartsAccnrs.has(Number(part.siid))) ? Number(part.siid) : null;
									const partAccAsset = (part.accasset && validPartsAccnrs.has(Number(part.accasset))) ? Number(part.accasset) : null;
									if (partAccCos && partAccAsset) return { cosAccnr: partAccCos, assetAccnr: partAccAsset };
									try {
										const itemAccounts = await resolveStockGlAccounts({
											schema,
											stockId: part.stock_id || null,
											partnr: part.partnr || null,
											txnType: 'PARTS'
										});
										return { cosAccnr: partAccCos || itemAccounts.cosAccnr, assetAccnr: partAccAsset || itemAccounts.assetAccnr };
									} catch (_resolveErr) {
										return { cosAccnr: partAccCos || controls.COS, assetAccnr: partAccAsset || controls.INVENTORY };
									}
								}
							}));

							const workRows = await tenantQuery(companyDb,
								`SELECT acc, siid,
								        ROUND(CAST(COALESCE(workprice, 0) AS DECIMAL(18,2)) - CAST(COALESCE(discountamount, 0) AS DECIMAL(18,2)), 2) AS work_sale,
								        ROUND(CAST(COALESCE(workcost, 0) AS DECIMAL(18,2)), 2) AS work_cost
								 FROM ${schema}.work_done
								 WHERE job_number = ?
								   AND invoice_nr = ?
								   AND (
								        CAST(COALESCE(workprice, 0) AS DECIMAL(18,2)) - CAST(COALESCE(discountamount, 0) AS DECIMAL(18,2)) > 0.009
								        OR CAST(COALESCE(workcost, 0) AS DECIMAL(18,2)) > 0.009
								   )`,
								[row.job_number, row.invoice_nr]
							).catch(() => []);
							const workRawAccnrs = (workRows || []).flatMap(w => [w.acc, w.siid]).filter(Boolean).map(Number);
							const validWorkAccnrs = await resolveValidAccnrs(companyDb, schema, workRawAccnrs);
							for (const work of workRows || []) {
								const sale = Math.round((Number(work.work_sale) || 0) * 100) / 100;
								const workAccRevenue = (work.acc && validWorkAccnrs.has(Number(work.acc))) ? Number(work.acc) : null;
								if (sale > 0.009) {
									lines.push(
										{ accnr: workAccRevenue || controls.SALES, credit: sale, job_number: row.job_number, cid: row.cid, invoice_nr: row.invoice_nr }
									);
									mappedRevenueTotal += sale;
								}
							}

							const residualRevenue = round2(revenueTotal - mappedRevenueTotal);
							if (Math.abs(residualRevenue) > 0.009) {
								lines.push({
									accnr: controls.SALES,
									debit: residualRevenue < 0 ? Math.abs(residualRevenue) : 0,
									credit: residualRevenue > 0 ? residualRevenue : 0,
									job_number: row.job_number,
									cid: row.cid,
									invoice_nr: row.invoice_nr
								});
							}
						} catch (_cosErr) {
							// Non-fatal: fall back to generic sales if spares_used query fails.
							if (Math.abs(revenueTotal) > 0.009) {
								lines.push({
									accnr: controls.SALES,
									debit: revenueTotal < 0 ? Math.abs(revenueTotal) : 0,
									credit: revenueTotal > 0 ? revenueTotal : 0,
									job_number: row.job_number,
									cid: row.cid,
									invoice_nr: row.invoice_nr
								});
							}
						}
					} else if (Math.abs(revenueTotal) > 0.009) {
						lines.push({
							accnr: controls.SALES,
							debit: revenueTotal < 0 ? Math.abs(revenueTotal) : 0,
							credit: revenueTotal > 0 ? revenueTotal : 0,
							job_number: row.job_number,
							cid: row.cid,
							invoice_nr: row.invoice_nr
						});
					}

					// Outside the legacy revenue fallback catch: missing labour setup
					// must not produce an apparently successful incomplete journal.
					if (row.job_number && !isCreditNote) {
						lines.push(...await buildWorkshopLabourCostLines({
							queryFn: (sql, params) => tenantQuery(companyDb, sql, params),
							schema, jobNumber: row.job_number, cid: row.cid,
							invoiceNr: row.invoice_nr, includeExcludedCost: excludedLinesCosted
						}));
					} else if (row.job_number && isCreditNote) {
						// Full credits mirror the stored original labour posting. Partial
						// and remainder credits do not reverse costs. Never recompute a
						// credit from today's job costs or current account mappings.
						const originalLabour = await tenantQuery(companyDb, `
							SELECT l.accnr, l.debit, l.credit, l.ref1, l.job_number, l.cid
							FROM ${schema}.invoices credit
							JOIN ${schema}.invoices original ON original.invoice_nr = credit.credit_for_invoice_nr
							JOIN ${schema}.gl_journal_headers gh ON gh.source = 'DEBTOR_INVOICE'
							  AND gh.source_id = CAST(original.invoice_nr AS CHAR) COLLATE utf8mb4_unicode_ci AND gh.status = 'POSTED'
							JOIN ${schema}.gl_journal_headers cost_header ON cost_header.status = 'POSTED'
							  AND (cost_header.id = gh.id OR (cost_header.source = 'WORKSHOP_LABOUR_COST'
							    AND cost_header.source_id = CAST(gh.id AS CHAR) COLLATE utf8mb4_unicode_ci))
							JOIN ${schema}.gl_journal_lines l ON l.header_id = cost_header.id
							WHERE credit.invoice_nr = ?
							  AND ABS(COALESCE(credit.inv_totalinclvat, 0) + COALESCE(original.inv_totalinclvat, 0)) < 0.005
							  AND l.ref1 IN (?, ?)
							  AND NOT EXISTS (SELECT 1 FROM ${schema}.invoice_adjustments adjustment
							    WHERE adjustment.gl_source = 'DEBTOR_INVOICE_CREDIT'
							      AND adjustment.gl_source_id = CAST(credit.invoice_nr AS CHAR) COLLATE utf8mb4_unicode_ci)`,
							[row.invoice_nr, LABOUR_COS_REF, LABOUR_OFFSET_REF]);
						lines.push(...(originalLabour || []).map(line => ({ ...line,
							debit: Number(line.credit) || 0, credit: Number(line.debit) || 0, invoice_nr: row.invoice_nr
						})));
					}
					return {
						source: isCreditNote ? 'DEBTOR_INVOICE_CREDIT' : 'DEBTOR_INVOICE',
						sourceId: row.invoice_nr,
						trxdate: row.doc_date,
						description: `${isCreditNote ? 'Credit note' : 'Invoice'} ${row.invoice_nr} job ${row.job_number}`,
						lines,
						extraRefs: { cid: row.cid, job_number: row.job_number }
					};
				};
				await processDocs(rows.map(r => ({ source: 'DEBTOR_INVOICE', source_id: r.invoice_nr, doc_date: r.doc_date, invoice_nr: r.invoice_nr, job_number: r.job_number, cid: r.cid })), 'DEBTOR_INVOICE', async (d) => buildFn(d));
			}

			if (t === 'DEBTOR_PAYMENT') {
				let rows;
				const targetIds = targetedSourceIds && Array.isArray(targetedSourceIds.DEBTOR_PAYMENT) ? targetedSourceIds.DEBTOR_PAYMENT.map(Number).filter(Boolean) : null;
				if (targetIds && targetIds.length > 0) {
					const ph = targetIds.map(() => '?').join(',');
					rows = await tenantQuery(companyDb, `SELECT p.payid, p.paydate, p.paymethod, p.amount, p.vat, p.cid, p.invoice_nr, p.job_number, p.acc FROM ${schema}.payments p WHERE p.payid IN (${ph}) AND ${DEBTOR_PAYMENT_BACKFILL_SQL}`, targetIds);
				} else if (targetIds) {
					rows = [];
				} else {
					rows = await tenantQuery(companyDb, `SELECT p.payid, p.paydate, p.paymethod, p.amount, p.vat, p.cid, p.invoice_nr, p.job_number, p.acc FROM ${schema}.payments p WHERE p.paydate BETWEEN ? AND ? AND ${DEBTOR_PAYMENT_BACKFILL_SQL}`, [fromDate, toDate]);
				}
				const splitLegacyAdjustmentAmount = async (row) => {
					const amount = Math.abs(round2(row.amount));
					const rowVat = Math.abs(round2(row.vat));
					if (rowVat > 0.009 && rowVat < amount) return { amount, amountExVat: round2(amount - rowVat), vatAmount: rowVat };
					try {
						const [invoice] = await tenantQuery(companyDb,
							`SELECT inv_totalinclvat, inv_totalvat FROM ${schema}.invoices WHERE invoice_nr = ? AND cid = ? LIMIT 1`,
							[row.invoice_nr, row.cid]
						);
						const invoiceTotal = Math.abs(Number(invoice && invoice.inv_totalinclvat) || 0);
						const invoiceVat = Math.abs(Number(invoice && invoice.inv_totalvat) || 0);
						const vatAmount = invoiceTotal > 0 && invoiceVat > 0 ? round2(amount * (invoiceVat / invoiceTotal)) : 0;
						return { amount, amountExVat: round2(amount - vatAmount), vatAmount };
					} catch (_) {
						return { amount, amountExVat: amount, vatAmount: 0 };
					}
				};
				const buildFn = async (row) => {
					const adjustmentType = legacyAdjustmentType(row.paymethod);
					if (adjustmentType) {
						const { amount, amountExVat, vatAmount } = await splitLegacyAdjustmentAmount(row);
						const sourceId = legacyPaymentSourceId(row.payid);
						if (adjustmentType === 'WRITE_OFF') {
							return {
								source: 'INVOICE_WRITE_OFF',
								sourceId,
								trxdate: row.doc_date,
								description: `Legacy bad debt R${amount.toFixed(2)} on invoice ${row.invoice_nr}`,
								lines: [
									{ accnr: controls.BAD_DEBTS, debit: amount, credit: 0, cid: row.cid, invoice_nr: row.invoice_nr },
									{ accnr: controls.AR, debit: 0, credit: amount, cid: row.cid, invoice_nr: row.invoice_nr }
								],
								extraRefs: { cid: row.cid, invoice_nr: row.invoice_nr, job_number: row.job_number }
							};
						}
						if (adjustmentType === 'DISCOUNT') {
							const lines = vatAmount > 0
								? [
									{ accnr: controls.DISCOUNT, debit: amountExVat, credit: 0, cid: row.cid, invoice_nr: row.invoice_nr },
									{ accnr: controls.VAT_OUTPUT, debit: vatAmount, credit: 0, cid: row.cid, invoice_nr: row.invoice_nr },
									{ accnr: controls.AR, debit: 0, credit: amount, cid: row.cid, invoice_nr: row.invoice_nr }
								]
								: [
									{ accnr: controls.DISCOUNT, debit: amount, credit: 0, cid: row.cid, invoice_nr: row.invoice_nr },
									{ accnr: controls.AR, debit: 0, credit: amount, cid: row.cid, invoice_nr: row.invoice_nr }
								];
							return {
								source: 'INVOICE_DISCOUNT',
								sourceId,
								trxdate: row.doc_date,
								description: `Legacy discount R${amount.toFixed(2)} on invoice ${row.invoice_nr}`,
								lines,
								extraRefs: { cid: row.cid, invoice_nr: row.invoice_nr, job_number: row.job_number }
							};
						}
						const lines = vatAmount > 0
							? [
								{ accnr: controls.SALES, debit: amountExVat, credit: 0, cid: row.cid, invoice_nr: row.invoice_nr },
								{ accnr: controls.VAT_OUTPUT, debit: vatAmount, credit: 0, cid: row.cid, invoice_nr: row.invoice_nr },
								{ accnr: controls.AR, debit: 0, credit: amount, cid: row.cid, invoice_nr: row.invoice_nr }
							]
							: [
								{ accnr: controls.SALES, debit: amount, credit: 0, cid: row.cid, invoice_nr: row.invoice_nr },
								{ accnr: controls.AR, debit: 0, credit: amount, cid: row.cid, invoice_nr: row.invoice_nr }
							];
						return {
							source: 'DEBTOR_INVOICE_CREDIT',
							sourceId,
							trxdate: row.doc_date,
							description: `Legacy credit note R${amount.toFixed(2)} for invoice ${row.invoice_nr}`,
							lines,
							extraRefs: { cid: row.cid, invoice_nr: row.invoice_nr, job_number: row.job_number }
						};
					}
					const settlementType = legacySettlementType(row.paymethod);
					if (settlementType) {
						const validAccnrs = settlementType === 'ACCOUNT' ? await resolveValidAccnrs(companyDb, schema, [row.acc]) : new Set();
						const lines = buildLegacySettlementLines({
							type: settlementType,
							amount: row.amount,
							rowAccnr: validAccnrs.has(Number(row.acc)) ? Number(row.acc) : null,
							controls,
							cid: row.cid,
							invoiceNr: row.invoice_nr
						});
						const method = normalizeLegacyPaymentMethod(row.paymethod).toLowerCase();
						return { source: 'DEBTOR_PAYMENT', sourceId: row.payid, trxdate: row.doc_date, description: `Legacy ${method} R${Math.abs(round2(row.amount)).toFixed(2)} for invoice ${row.invoice_nr}`, lines, extraRefs: { cid: row.cid, invoice_nr: row.invoice_nr, job_number: row.job_number } };
					}
					const validPaymentAccnrs = await resolveValidAccnrs(companyDb, schema, [row.acc]);
					const paymentAccnr = validPaymentAccnrs.has(Number(row.acc)) ? Number(row.acc) : controls.BANK;
					const appliedAmount = round2(row.amount || 0);
					// payments.amount is only the invoice-applied portion. A receipt
					// that overpaid its invoice kept the excess in a linked
					// INVOICE_OVERPAYMENT customer credit, so the rebuilt journal must
					// debit the bank with the full money received and credit the excess
					// to Customer Deposits — otherwise the bank comes back short.
					const overpaymentAmount = round2(await findOverpaymentCreditAmount(companyDb, schema, row.payid));
					const receivedAmount = round2(appliedAmount + overpaymentAmount);
					const lines = [
						{ accnr: paymentAccnr, debit: receivedAmount, cid: row.cid, invoice_nr: row.invoice_nr },
						{ accnr: controls.AR, credit: appliedAmount, cid: row.cid, invoice_nr: row.invoice_nr },
						...(overpaymentAmount > 0.009
							? [{ accnr: controls.CUSTOMER_DEPOSITS, credit: overpaymentAmount, cid: row.cid, invoice_nr: row.invoice_nr }]
							: [])
					];
					return { source: 'DEBTOR_PAYMENT', sourceId: row.payid, trxdate: row.doc_date, description: `Receipt for invoice ${row.invoice_nr}${overpaymentAmount > 0.009 ? ` incl. R ${overpaymentAmount.toFixed(2)} customer credit` : ''}`, lines, extraRefs: { cid: row.cid, invoice_nr: row.invoice_nr, job_number: row.job_number } };
				};
				await processDocs(rows.map(r => ({ source: 'DEBTOR_PAYMENT', source_id: r.payid, doc_date: r.paydate, payid: r.payid, paymethod: r.paymethod, amount: r.amount, vat: r.vat, cid: r.cid, invoice_nr: r.invoice_nr, job_number: r.job_number, acc: r.acc })), 'DEBTOR_PAYMENT', async (d) => buildFn(d));
			}

			if (t === 'CREDITOR_PAYMENT') {
				// Check if payments_suppliers exists
				const exists = await tableExists(companyDb, schema, 'payments_suppliers');
				if (!exists) {
					logger.info && logger.info('Supplier payments table not found; skipping CREDITOR_PAYMENT');
					continue;
				}
				let rows;
				const targetIds = targetedSourceIds && Array.isArray(targetedSourceIds.CREDITOR_PAYMENT) ? targetedSourceIds.CREDITOR_PAYMENT.map(Number).filter(Boolean) : null;
				if (targetIds && targetIds.length > 0) {
					const ph = targetIds.map(() => '?').join(',');
					rows = await tenantQuery(companyDb, `SELECT p.payid, p.paydate, p.amount, p.suppid, p.invoice_nr, p.acc, p.accnr FROM ${schema}.payments_suppliers p WHERE p.payid IN (${ph}) AND ${SUPPLIER_PAYMENT_BACKFILL_SQL}`, targetIds);
				} else if (targetIds) {
					rows = [];
				} else {
					rows = await tenantQuery(companyDb, `SELECT p.payid, p.paydate, p.amount, p.suppid, p.invoice_nr, p.acc, p.accnr FROM ${schema}.payments_suppliers p WHERE p.paydate BETWEEN ? AND ? AND ${SUPPLIER_PAYMENT_BACKFILL_SQL}`, [fromDate, toDate]);
				}
				const buildFn = async (row) => {
					const preferredAccnr = Number(row.acc || 0) || Number(row.accnr || 0) || 0;
					const validPaymentAccnrs = await resolveValidAccnrs(companyDb, schema, [preferredAccnr]);
					const paymentAccnr = validPaymentAccnrs.has(preferredAccnr) ? preferredAccnr : controls.BANK;
					const lines = [
						{ accnr: controls.AP, debit: Number(row.amount || 0), suppid: row.suppid, invoice_nr: row.invoice_nr },
						{ accnr: paymentAccnr, credit: Number(row.amount || 0), suppid: row.suppid, invoice_nr: row.invoice_nr }
					];
					return { source: 'CREDITOR_PAYMENT', sourceId: row.payid, trxdate: row.doc_date, description: `Payment to supplier ${row.suppid} for invoice ${row.invoice_nr}`, lines, extraRefs: { suppid: row.suppid, invoice_nr: row.invoice_nr } };
				};
				await processDocs(rows.map(r => ({ source: 'CREDITOR_PAYMENT', source_id: r.payid, doc_date: r.paydate, payid: r.payid, amount: r.amount, suppid: r.suppid, invoice_nr: r.invoice_nr, acc: r.acc, accnr: r.accnr })), 'CREDITOR_PAYMENT', async (d) => buildFn(d));
			}
		}

		// finished
		await updateRunSummary({ companyDb, schema, runId, summary, status: 'DONE' });
		// logger.info && logger.info('GL backfill finished', { runId, summary });

		// Resync balances for all GL-touched customers and suppliers
		try {
			for (const cid of touchedCids) {
				try {
					await recalculateCustomerBalance(companyDb, cid);
				} catch (e) {
					logger.error && logger.error('Backfill: failed to resync customer balance', { cid, err: e?.message });
				}
			}
			for (const suppid of touchedSuppids) {
				try {
					const bal = await getSupplierBalance(companyDb, suppid);
					await saveSupplierBalance(companyDb, suppid, bal);
				} catch (e) {
					logger.error && logger.error('Backfill: failed to resync supplier balance', { suppid, err: e?.message });
				}
			}
		} catch (e) {
			logger.error && logger.error('Backfill: balance resync pass failed', { err: e?.message });
		}
	} catch (err) {
		// logger.error && logger.error('GL backfill failed', { runId, err: err && err.stack ? err.stack : err });
		// The job runs detached (setImmediate), so a rejection here would be
		// unhandled and crash the process — e.g. when the DB itself went away.
		// A run left RUNNING is auto-healed to FAILED by the start-run routes.
		try {
			await updateRunSummary({ companyDb, schema, runId, summary: { ...summary, lastError: err && err.message }, status: 'FAILED' });
		} catch (summaryErr) {
			logger.error && logger.error('Backfill: failed to record FAILED run status', { runId, err: err && err.message, summaryErr: summaryErr && summaryErr.message });
		}

		// Resync balances for any GL-touched entities from partially completed backfill
		try {
			for (const cid of touchedCids) {
				try {
					await recalculateCustomerBalance(companyDb, cid);
				} catch (e) {
					logger.error && logger.error('Backfill: failed to resync customer balance', { cid, err: e?.message });
				}
			}
			for (const suppid of touchedSuppids) {
				try {
					const bal = await getSupplierBalance(companyDb, suppid);
					await saveSupplierBalance(companyDb, suppid, bal);
				} catch (e) {
					logger.error && logger.error('Backfill: failed to resync supplier balance', { suppid, err: e?.message });
				}
			}
		} catch (e) {
			logger.error && logger.error('Backfill: balance resync pass failed', { err: e?.message });
		}
	}
}

async function rewriteLegacyRfcGlSourceIds({ companyDb, schema, dryRun = false, onProgress = null }) {
	const result = { checked: 0, rewritten: 0, skipped: 0, details: [] };

	const headers = await tenantQuery(companyDb,
		`SELECT h.rfc_id, h.rfc_number, h.suppid, h.original_inv_nr
		 FROM ${schema}.supplier_rfc_headers h
		 WHERE h.reason = 'LEGACY_MIGRATION'`
	);

	result.checked = headers.length;
	if (typeof onProgress === 'function') {
		onProgress({ processed: 0, total: headers.length, rewritten: result.rewritten, skipped: result.skipped, current: null });
	}

	for (const [idx, h] of headers.entries()) {
		const legacySourceId = `${h.original_inv_nr}-RFC`;
		const glRows = await tenantQuery(companyDb,
			`SELECT id FROM ${schema}.gl_journal_headers WHERE source = 'CREDITOR_RFC' AND source_id = ?`,
			[legacySourceId]
		);
		if (!glRows || glRows.length === 0) {
			result.skipped++;
			result.details.push({ rfc_id: h.rfc_id, original_inv_nr: h.original_inv_nr, status: 'SKIPPED', message: 'No GL journal with string source_id found' });
			if (typeof onProgress === 'function') {
				onProgress({ processed: idx + 1, total: headers.length, rewritten: result.rewritten, skipped: result.skipped, current: h.original_inv_nr });
			}
			continue;
		}
		for (const gl of glRows) {
			// Check if the correct integer source_id already exists (GL backfill ran after RFC migration)
			const existing = await tenantQuery(companyDb,
				`SELECT id FROM ${schema}.gl_journal_headers WHERE source = 'CREDITOR_RFC' AND source_id = ? AND id <> ?`,
				[String(h.rfc_id), gl.id]
			);
			if (existing && existing.length > 0) {
				// New correct journal already exists — delete the stale string-source one
				if (!dryRun) {
					await tenantQuery(companyDb, `DELETE FROM ${schema}.gl_journal_lines WHERE header_id = ?`, [gl.id]);
					await tenantQuery(companyDb, `DELETE FROM ${schema}.gl_journal_headers WHERE id = ?`, [gl.id]);
				}
				result.rewritten++;
				result.details.push({ rfc_id: h.rfc_id, original_inv_nr: h.original_inv_nr, status: dryRun ? 'DRY_RUN' : 'REWRITTEN', message: `GL header ${gl.id}: duplicate removed (integer journal ${existing[0].id} already exists)` });
				continue;
			}
			if (!dryRun) {
				await tenantQuery(companyDb,
					`UPDATE ${schema}.gl_journal_headers SET source_id = ?, description = ? WHERE id = ?`,
					[String(h.rfc_id), `RFC ${h.rfc_number} — Reversal of supplier invoice ${h.original_inv_nr} (legacy)`, gl.id]
				);
				const numericPart = /^\d+$/.test(h.original_inv_nr) ? h.original_inv_nr : null;
				await tenantQuery(companyDb,
					`UPDATE ${schema}.gl_journal_lines SET invoice_nr = ?, ref2 = COALESCE(ref2, ?) WHERE header_id = ?`,
					[numericPart, legacySourceId, gl.id]
				);
			}
			result.rewritten++;
			result.details.push({ rfc_id: h.rfc_id, original_inv_nr: h.original_inv_nr, status: dryRun ? 'DRY_RUN' : 'REWRITTEN', message: `GL header ${gl.id}: source_id '${legacySourceId}' → ${h.rfc_id}` });
		}
		if (typeof onProgress === 'function') {
			onProgress({ processed: idx + 1, total: headers.length, rewritten: result.rewritten, skipped: result.skipped, current: h.original_inv_nr });
		}
	}
	return result;
}

async function migrateLegacyRfcs({
	companyDb,
	schema,
	staffId = 0,
	limit = 500,
	dryRun = false,
	parkLegacyRfcRow = false,
	rewriteGlSourceId = true,
	onProgress = null
}) {
	const result = { checked: 0, migrated: 0, released: 0, skipped: 0, failed: 0, warnings: 0, details: [] };

	const candidates = await tenantQuery(companyDb,
		`SELECT
			rfc.sinvid AS rfc_sinvid,
			rfc.invoice_nr AS rfc_invoice_nr,
			rfc.inv_date AS rfc_inv_date,
			rfc.payreff AS rfc_payreff,
			rfc.posted_at AS rfc_posted_at,
			rfc.amount AS rfc_amount,
			rfc.amountexvat AS rfc_amountexvat,
			rfc.vat AS rfc_vat,
			orig.sinvid AS orig_sinvid,
			orig.invoice_nr AS orig_invoice_nr,
			orig.status AS orig_status,
			orig.suppid
		 FROM ${schema}.invoices_supplier rfc
		 JOIN ${schema}.invoices_supplier orig
		   ON orig.suppid = rfc.suppid
		  AND orig.invoice_nr = REPLACE(rfc.invoice_nr, '-RFC', '')
		  AND orig.status IN ('RFC-ORIGINAL', 'POSTED')
		 LEFT JOIN ${schema}.supplier_rfc_headers h ON h.original_sinvid = orig.sinvid
		 WHERE rfc.invoice_nr LIKE '%-RFC'
		   AND rfc.status IN ('RFC-DONE', 'POSTED')
		   AND h.rfc_id IS NULL
		   -- A return with nothing in it only matters while its original waits in
		   -- RFC-ORIGINAL, to be released; after that there is nothing left to do.
		   AND (
		     orig.status = 'RFC-ORIGINAL'
		     OR ABS(COALESCE(rfc.amount, 0)) > 0.01
		     OR EXISTS (
		       SELECT 1 FROM ${schema}.invoice_items rfc_line
		       WHERE rfc_line.invoice_nr = rfc.invoice_nr AND rfc_line.suppid = rfc.suppid
		         AND COALESCE(rfc_line.quantity, 0) <> 0
		         AND ABS(COALESCE(rfc_line.amountexvat, 0)) + ABS(COALESCE(rfc_line.vat, 0)) > 0.01
		     )
		   )
		 ORDER BY orig.inv_date ASC, orig.sinvid ASC
		 LIMIT ?`,
		[limit]
	);

	result.checked = candidates.length;

	for (const pair of candidates) {
		const { rfc_sinvid, rfc_invoice_nr, rfc_inv_date, rfc_payreff, rfc_posted_at,
			rfc_amount, rfc_amountexvat, rfc_vat,
			orig_sinvid, orig_invoice_nr, orig_status, suppid } = pair;

		let tx = null;
		try {
			tx = await companyTransaction();

			// Lock both rows
			await tx.query(`SELECT sinvid FROM ${schema}.invoices_supplier WHERE sinvid = ? FOR UPDATE`, [orig_sinvid]);
			await tx.query(`SELECT sinvid FROM ${schema}.invoices_supplier WHERE sinvid = ? FOR UPDATE`, [rfc_sinvid]);

			// Race guard
			const existing = await tx.query(
				`SELECT rfc_id FROM ${schema}.supplier_rfc_headers WHERE original_sinvid = ? LIMIT 1`,
				[orig_sinvid]
			);
			if (existing && existing.length > 0) {
				await tx.rollback(); tx = null;
				result.skipped++;
				result.details.push({ sinvid: orig_sinvid, invoice_nr: orig_invoice_nr, status: 'SKIPPED', rfcId: null, rfcNumber: null, message: 'Already migrated' });
				continue;
			}

			// Allocate rfc_number
			const maxNrRows = await tx.query(
				`SELECT MAX(CAST(rfc_number AS UNSIGNED)) AS max_nr FROM ${schema}.supplier_rfc_headers WHERE suppid = ?`,
				[suppid]
			);
			const rfcNumber = ((maxNrRows && maxNrRows[0] && maxNrRows[0].max_nr) ? Number(maxNrRows[0].max_nr) : 0) + 1;

			const rfcPostedAtRaw = rfc_posted_at || rfc_inv_date || new Date();
			const rfcPostedAtStr = rfcPostedAtRaw instanceof Date
				? rfcPostedAtRaw.toISOString().slice(0, 19).replace('T', ' ')
				: String(rfcPostedAtRaw).slice(0, 19);

			let rfcId = 0; // placeholder for dry run
			if (!dryRun) {
				const ins = await tx.query(
					`INSERT INTO ${schema}.supplier_rfc_headers
					   (rfc_number, suppid, original_sinvid, original_inv_nr, rfc_date, reason, supplier_ref, status, created_by, posted_at)
					 VALUES (?, ?, ?, ?, ?, 'LEGACY_MIGRATION', ?, 'DONE', ?, ?)`,
					[rfcNumber, suppid, orig_sinvid, orig_invoice_nr, rfc_inv_date,
						rfc_payreff || null, staffId || null, rfcPostedAtStr]
				);
				rfcId = ins && ins.insertId ? ins.insertId : null;
				if (!rfcId) {
					await tx.rollback(); tx = null;
					result.failed++;
					result.details.push({ sinvid: orig_sinvid, invoice_nr: orig_invoice_nr, status: 'FAILED', rfcId: null, rfcNumber, message: 'Header insert returned no insertId' });
					continue;
				}
			}

			// Fetch RFC invoice items
			const items = await tx.query(
				`SELECT partnr, stock_id, description, quantity, amountexvat, vat, job_number
				 FROM ${schema}.invoice_items
				 WHERE invoice_nr = ? AND suppid = ?`,
				[rfc_invoice_nr, suppid]
			);

			// RFC lines are written once their total is known: a legacy return can
			// carry its amount on the header alone, with lines of no value.
			let totalRfcIncVat = 0;
			const rfcLines = [];

			for (const item of items) {
				const qtyReturned = Math.round(Math.abs(Number(item.quantity || 0)) * 10000) / 10000;
				if (qtyReturned === 0) continue;

				const lineCostExvat = Math.round(Math.abs(Number(item.amountexvat || 0)) * 100) / 100;
				const lineVat = Math.round(Math.abs(Number(item.vat || 0)) * 100) / 100;
				const lineCostIncvat = Math.round((lineCostExvat + lineVat) * 100) / 100;
				const unitCostExvat = Math.round((lineCostExvat / qtyReturned) * 100) / 100;

				let linkedOrdernr = null;
				const jobNumber = (item.job_number || '').toString().trim();
				if (jobNumber) {
					const orderRows = await tx.query(
						`SELECT ordernr FROM ${schema}.orders WHERE job_number = ? AND suppid = ? LIMIT 1`,
						[jobNumber, suppid]
					);
					linkedOrdernr = orderRows && orderRows[0] ? (orderRows[0].ordernr || null) : null;
				}

				rfcLines.push({ values: [rfcId, item.partnr || null, item.stock_id || null, item.description || null,
					qtyReturned, unitCostExvat, lineVat, lineCostExvat, lineCostIncvat,
					jobNumber || null, linkedOrdernr] });
				totalRfcIncVat += lineCostIncvat;
			}

			// Fallback: no invoice_items rows, or rows with no value — synthesize one line from header totals
			if (Math.round(totalRfcIncVat * 100) / 100 <= 0.01) {
				rfcLines.length = 0;
				totalRfcIncVat = 0;
				const headerIncVat = Math.round(Math.abs(Number(rfc_amount || 0)) * 100) / 100;
				const headerVat = Math.round(Math.abs(Number(rfc_vat || 0)) * 100) / 100;
				let headerExVat = Math.round(Math.abs(Number(rfc_amountexvat || 0)) * 100) / 100;
				if (headerExVat < 0.01) headerExVat = Math.round((headerIncVat - headerVat) * 100) / 100;
				if (headerIncVat > 0.01) {
					rfcLines.push({ headerLevel: true, values: [rfcId, headerExVat, headerVat, headerExVat, headerIncVat] });
					totalRfcIncVat = headerIncVat;
				}
			}

			totalRfcIncVat = Math.round(totalRfcIncVat * 100) / 100;
			const linesInserted = rfcLines.length;

			if (linesInserted === 0 || totalRfcIncVat <= 0.01) {
				await tx.rollback(); tx = null;
				if (String(orig_status || '').toUpperCase() !== 'RFC-ORIGINAL') {
					result.skipped++;
					result.details.push({ sinvid: orig_sinvid, invoice_nr: orig_invoice_nr, status: 'SKIPPED', rfcId: null, rfcNumber, message: 'No postable RFC lines' });
					continue;
				}
				// Nothing was returned, but the original is still a real invoice:
				// release it from RFC-ORIGINAL, without an RFC, so the backfill posts it.
				// A negative legacy rfcamount recorded this empty return; payable stands.
				if (!dryRun) {
					await tenantQuery(companyDb,
						`UPDATE ${schema}.invoices_supplier
						    SET rfcamount = GREATEST(COALESCE(rfcamount, 0), 0),
						        status    = 'DONE',
						        posted_at = COALESCE(posted_at, inv_date)
						  WHERE sinvid = ? AND status = 'RFC-ORIGINAL'`,
						[orig_sinvid]
					);
					if (parkLegacyRfcRow) {
						await tenantQuery(companyDb, `UPDATE ${schema}.invoices_supplier SET status = 'RFC-LEGACY' WHERE sinvid = ?`, [rfc_sinvid]);
					}
				}
				result.released++;
				result.details.push({
					sinvid: orig_sinvid, invoice_nr: orig_invoice_nr, status: dryRun ? 'DRY_RUN' : 'RELEASED', rfcId: null, rfcNumber: null,
					message: `${dryRun ? 'Would release' : 'Released'} to DONE: nothing was returned`
				});
				if (onProgress) onProgress({ processed: result.migrated + result.skipped + result.failed + result.released, of: result.checked, migrated: result.migrated, skipped: result.skipped, failed: result.failed, current: rfc_invoice_nr });
				continue;
			}

			if (!dryRun) {
				for (const line of rfcLines) {
					await tx.query(line.headerLevel
						? `INSERT INTO ${schema}.supplier_rfc_lines
						   (rfc_id, partnr, stock_id, description, qty_returned,
						    unit_cost_exvat, line_vat, line_cost_exvat, line_cost_incvat,
						    job_number, ordernr)
						 VALUES (?, '', NULL, 'Legacy RFC (header-level)', 1, ?, ?, ?, ?, NULL, NULL)`
						: `INSERT INTO ${schema}.supplier_rfc_lines
						   (rfc_id, partnr, stock_id, description, qty_returned,
						    unit_cost_exvat, line_vat, line_cost_exvat, line_cost_incvat,
						    job_number, ordernr)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						line.values
					);
				}
			}

			if (!dryRun) {
				// Normalize original header. A negative legacy rfcamount is the legacy
				// system's own record of these returns, already taken off payable: it is
				// replaced by the positive RFC total, and payable is left as it is.
				// MySQL applies the assignments in order, so payable reads the legacy value.
				await tx.query(
					`UPDATE ${schema}.invoices_supplier
					    SET payable   = CASE WHEN COALESCE(rfcamount, 0) < 0 THEN payable
					                         ELSE GREATEST(0, ROUND(COALESCE(payable, 0) - ?, 2)) END,
					        rfcamount = ROUND(GREATEST(COALESCE(rfcamount, 0), 0) + ?, 2),
					        status    = 'DONE',
					        posted_at = COALESCE(posted_at, inv_date)
					  WHERE sinvid = ?`,
					[totalRfcIncVat, totalRfcIncVat, orig_sinvid]
				);

				if (parkLegacyRfcRow) {
					await tx.query(
						`UPDATE ${schema}.invoices_supplier SET status = 'RFC-LEGACY' WHERE sinvid = ?`,
						[rfc_sinvid]
					);
				}

				if (rewriteGlSourceId) {
					const glHeaders = await tx.query(
						`SELECT id FROM ${schema}.gl_journal_headers WHERE source = 'CREDITOR_RFC' AND source_id = ? LIMIT 1`,
						[rfc_invoice_nr]
					);
					if (glHeaders && glHeaders.length > 0) {
						const glHeaderId = glHeaders[0].id;
						await tx.query(
							`UPDATE ${schema}.gl_journal_headers
							    SET source_id   = ?,
							        description = ?
							  WHERE id = ?`,
							[String(rfcId), `RFC ${rfcNumber} — Reversal of supplier invoice ${orig_invoice_nr} (legacy)`, glHeaderId]
						);
						const numericPart = /^\d+$/.test(orig_invoice_nr) ? orig_invoice_nr : null;
						await tx.query(
							`UPDATE ${schema}.gl_journal_lines
							    SET invoice_nr = ?,
							        ref2 = COALESCE(ref2, ?)
							  WHERE header_id = ?`,
							[numericPart, rfc_invoice_nr, glHeaderId]
						);
					} else {
						result.warnings++;
						result.details.push({ sinvid: orig_sinvid, invoice_nr: orig_invoice_nr, status: 'WARNING', rfcId, rfcNumber, message: 'No legacy CREDITOR_RFC journal found' });
					}
				} else {
					result.warnings++;
					result.details.push({ sinvid: orig_sinvid, invoice_nr: orig_invoice_nr, status: 'WARNING', rfcId, rfcNumber, message: 'GL source_id rewrite skipped (flag off)' });
				}
			}

			await tx.commit(); tx = null;
			result.migrated++;
			result.details.push({
				sinvid: orig_sinvid, invoice_nr: orig_invoice_nr,
				status: dryRun ? 'DRY_RUN' : 'MIGRATED',
				rfcId: dryRun ? null : rfcId,
				rfcNumber,
				message: `${dryRun ? 'Would migrate' : 'Migrated'} (${linesInserted} lines, total ${totalRfcIncVat})`
			});

			if (!dryRun) {
				try {
					const bal = await getSupplierBalance(companyDb, suppid);
					await saveSupplierBalance(companyDb, suppid, bal);
				} catch (balErr) {
					logger.warn && logger.warn('migrateLegacyRfcs: balance resync failed', { suppid, err: balErr && balErr.message });
				}
			}
		} catch (pairErr) {
			if (tx) { try { await tx.rollback(); } catch (_) { } tx = null; }
			result.failed++;
			result.details.push({ sinvid: orig_sinvid, invoice_nr: orig_invoice_nr, status: 'FAILED', rfcId: null, rfcNumber: null, message: pairErr && pairErr.message ? pairErr.message : String(pairErr) });
		}
		if (onProgress) onProgress({ processed: result.migrated + result.skipped + result.failed + result.released, of: result.checked, migrated: result.migrated, skipped: result.skipped, failed: result.failed, current: rfc_invoice_nr });
	}

	return result;
}

/**
 * Bulk-assign a GL account to legacy GENERAL supplier invoices that have no invoice_general record.
 *
 * The GL backfill reads invoice_general for GENERAL invoices. Legacy-migrated invoices never had
 * these rows created, so the backfill fell back to COS. This function creates the missing rows
 * using the caller-supplied accnr, making the invoices properly editable and correctly postable.
 *
 * Options:
 *   accnr       {number}  Required. GL account number to assign to all matched invoices.
 *   description {string}  Optional. Line description. Defaults to the invoice_nr value.
 *   suppid      {number}  Optional. Limit to a single supplier. Omit for all suppliers.
 *   dryRun      {boolean} If true, count matches without writing.
 *   staffId     {number}  Staff id recorded on inserted rows.
 *   onProgress  {fn}      Optional callback({ processed, total, inserted, skipped }).
 *
 * Returns { checked, inserted, skipped, failed, details[] }
 */
async function backfillGeneralInvoiceGlLines({
	companyDb,
	schema,
	accnr,
	description = null,
	suppid = null,
	dryRun = false,
	staffId = 0,
	onProgress = null
}) {
	if (!accnr || Number(accnr) <= 0) throw new Error('accnr is required and must be a positive integer');

	const result = { checked: 0, inserted: 0, skipped: 0, failed: 0, details: [] };

	// Validate the account exists and is active
	await ensureAccountsExist(companyDb, schema, [Number(accnr)]);

	// Find all GENERAL invoices in invoices_supplier that have no invoice_general row
	const params = [];
	let suppFilter = '';
	if (suppid) {
		suppFilter = 'AND si.suppid = ?';
		params.push(Number(suppid));
	}

	const rows = await tenantQuery(companyDb,
		`SELECT si.sinvid, si.invoice_nr, si.suppid, si.inv_date,
		        si.amount, si.amountexvat, si.vat, si.comments,
		        s.supplier AS supplier_name
		 FROM ${schema}.invoices_supplier si
		 JOIN ${schema}.suppliers s ON s.suppid = si.suppid
		 WHERE si.purchasetype = 'GENERAL'
		   ${suppFilter}
		   AND NOT EXISTS (
		       SELECT 1 FROM ${schema}.invoice_general ig
		       WHERE ig.suppid = si.suppid AND ig.invoice_nr = si.invoice_nr
		   )
		 ORDER BY si.suppid, si.inv_date ASC`,
		params
	);

	result.checked = rows.length;
	if (typeof onProgress === 'function') {
		onProgress({ processed: 0, total: result.checked, inserted: 0, skipped: 0 });
	}

	for (const [idx, row] of rows.entries()) {
		const invNr = String(row.invoice_nr || '');
		const lineDescription = description || invNr;
		const amountIncVat = round2(Math.abs(Number(row.amount || 0)));
		const amountExVat = round2(Math.abs(Number(row.amountexvat || 0)));
		const vatAmount = round2(Math.abs(Number(row.vat || 0)));
		const purchdate = row.inv_date ? new Date(row.inv_date).toISOString().slice(0, 10) : null;

		if (amountIncVat <= 0.009) {
			result.skipped++;
			result.details.push({ invoice_nr: invNr, suppid: row.suppid, status: 'SKIPPED', message: 'Zero-value invoice' });
			if (typeof onProgress === 'function') {
				onProgress({ processed: idx + 1, total: result.checked, inserted: result.inserted, skipped: result.skipped });
			}
			continue;
		}

		try {
			if (!dryRun) {
				await tenantQuery(companyDb,
					`INSERT INTO ${schema}.invoice_general
					    (invoice_nr, staff_id, purchdate, suppid, status, amount, amountexvat, paid, vat, comments, accnr, supplier, ptype)
					 VALUES (?, ?, ?, ?, 'POSTED', ?, ?, ?, ?, ?, ?, ?, 'GENERAL')`,
					[
						invNr,
						Number(staffId || 0),
						purchdate,
						Number(row.suppid),
						amountIncVat,
						amountExVat,
						amountIncVat,   // paid = full amount (invoice is already settled in legacy)
						vatAmount,
						lineDescription,
						Number(accnr),
						String(row.supplier_name || '')
					]
				);
			}
			result.inserted++;
			result.details.push({ invoice_nr: invNr, suppid: row.suppid, status: dryRun ? 'DRY_RUN' : 'INSERTED', accnr: Number(accnr), amount: amountIncVat });
		} catch (err) {
			result.failed++;
			result.details.push({ invoice_nr: invNr, suppid: row.suppid, status: 'FAILED', message: err && err.message ? err.message : String(err) });
			logger.error && logger.error('backfillGeneralInvoiceGlLines: insert failed', { schema, invoice_nr: invNr, suppid: row.suppid, err: err && err.stack ? err.stack : err });
		}

		if (typeof onProgress === 'function') {
			onProgress({ processed: idx + 1, total: result.checked, inserted: result.inserted, skipped: result.skipped });
		}
	}

	return result;
}

/**
 * Returns the list of GENERAL invoices that are missing invoice_general records,
 * grouped by supplier. Used by the UI to let the user review scope before running
 * backfillGeneralInvoiceGlLines.
 */
async function getGeneralInvoicesWithoutGlLines({ companyDb, schema, suppid = null }) {
	const params = [];
	let suppFilter = '';
	if (suppid) {
		suppFilter = 'AND si.suppid = ?';
		params.push(Number(suppid));
	}

	const rows = await tenantQuery(companyDb,
		`SELECT si.suppid, s.supplier AS supplier_name,
		        COUNT(*) AS invoice_count,
		        SUM(si.amount) AS total_amount
		 FROM ${schema}.invoices_supplier si
		 JOIN ${schema}.suppliers s ON s.suppid = si.suppid
		 WHERE si.purchasetype = 'GENERAL'
		   ${suppFilter}
		   AND NOT EXISTS (
		       SELECT 1 FROM ${schema}.invoice_general ig
		       WHERE ig.suppid = si.suppid AND ig.invoice_nr = si.invoice_nr
		   )
		 GROUP BY si.suppid, s.supplier
		 ORDER BY s.supplier ASC`,
		params
	);

	return rows || [];
}

module.exports = {
	BACKFILL_TYPE_ORDER,
	buildCreditorInvoiceTargetFilter,
	legacyRfcIdSql,
	legacyRfcJournalIdentity,
	backfillRebuildStockCapitalisations,
	loadRebuildStockBackfillRows,
	getBalancedDebtorInvoiceTotals,
	buildDebtorInvoicePartCostLines,
	getCreditorInvoiceLinePostingAmounts,
	getCreditorInvoiceVatToPost,
	settleCreditorLineGap,
	isDebtorInvoiceBackfillStatus,
	buildDebtorInvoiceBackfillEligibilitySql,
	createRun,
	runBackfillJob,
	updateRunSummary,
	getRunStatus,
	truncateGlBackfillTables,
	clearPreviousBackfillScope,
	ensureSupplierRefs,
	backfillSupplierRefs,
	migrateLegacyRfcs,
	rewriteLegacyRfcGlSourceIds,
	backfillGeneralInvoiceGlLines,
	getGeneralInvoicesWithoutGlLines
};
