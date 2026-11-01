// Declarations copied verbatim from AUTONEER-PWA src/services/finalise/finalise.service.js,
// only those the GL backfill uses. scripts/sync_pwa_gl_backfill.js keeps them in step.

const { resolveControlAccounts } = require('../../lib/finance/postingEngine');

const INCLUDED_LINE_SQL = 'COALESCE(is_excluded_from_quote, 0) = 0';

const COSTED_PART_LINE_SQL =
	`(${INCLUDED_LINE_SQL} OR COALESCE(excluded_stock_returned, 0) = 0)`;

function costedLineSql(includeExcludedCost, lineType = 'PARTS') {
	if (!includeExcludedCost) return INCLUDED_LINE_SQL;
	return String(lineType).toUpperCase() === 'LABOUR' ? '1 = 1' : COSTED_PART_LINE_SQL;
}

function round2(value) {
	return Math.round((Number(value) || 0) * 100) / 100;
}

function toSqlDateOnly(value) {
	if (typeof value === 'string') {
		const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
		if (match) return match[1];
	}
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return null;
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

const SUPPLIER_WIP_SOURCES = [
	'CREDITOR_INVOICE',
	'SUPPLIER_INVOICE',
	'SUPPLIER_INVOICE_RECALL',
	'SUPPLIER_INVOICE_REPOST',
	'SUPPLIER_INVOICE_VOID',
	'SUPPLIER_JOB_COST_RECLASS',
	'CREDITOR_RFC',
	'JOB_PART_WIP_REALLOC'
];

const INFERABLE_UNSCOPED_WIP_SOURCES = [
	'CREDITOR_INVOICE',
	'SUPPLIER_INVOICE',
	'SUPPLIER_INVOICE_RECALL',
	'SUPPLIER_INVOICE_REPOST',
	'SUPPLIER_INVOICE_VOID',
	'SUPPLIER_JOB_COST_RECLASS'
];

async function getJobWipDebitedTotal(queryFn, schema, jobNumber, options = {}) {
	const resolveControlAccountsFn = options.resolveControlAccountsFn || resolveControlAccounts;
	const controls = await resolveControlAccountsFn(schema, ['WIP']).catch(() => null);
	const wipAccnr = controls && controls.WIP ? Number(controls.WIP) : null;
	if (!wipAccnr) return { wipAccnr: null, total: 0 };

	const asAt = options.asAt ? toSqlDateOnly(options.asAt) : null;
	if (options.asAt && !asAt) throw new Error('Invalid asAt date for the job WIP balance');
	const sourcePlaceholders = SUPPLIER_WIP_SOURCES.map(() => '?').join(',');
	const inferablePlaceholders = INFERABLE_UNSCOPED_WIP_SOURCES.map(() => '?').join(',');
	const wipRows = await queryFn(
		`SELECT COALESCE(SUM(l.debit - l.credit), 0) AS total
		 FROM ${schema}.gl_journal_lines l
		 JOIN ${schema}.gl_journal_headers h ON h.id = l.header_id
		 WHERE h.status = 'POSTED' AND h.source IN (${sourcePlaceholders})
		   AND l.accnr = ?
		   AND (
		     l.job_number = ?
		     OR (
		       l.job_number IS NULL
		       AND h.source IN (${inferablePlaceholders})
		       AND l.suppid IS NOT NULL
		       AND EXISTS (
		         SELECT 1
		         FROM ${schema}.invoice_items ii
		         WHERE ii.suppid = l.suppid
		           AND CAST(ii.invoice_nr AS CHAR) = COALESCE(
		             NULLIF(TRIM(CAST(l.ref2 AS CHAR)), ''),
		             NULLIF(TRIM(CAST(l.invoice_nr AS CHAR)), ''),
		             SUBSTRING_INDEX(CAST(h.source_id AS CHAR), ':', -1)
		           )
		           AND ii.job_number = ?
		       )
		       AND NOT EXISTS (
		         SELECT 1
		         FROM ${schema}.invoice_items ii_other
		         WHERE ii_other.suppid = l.suppid
		           AND CAST(ii_other.invoice_nr AS CHAR) = COALESCE(
		             NULLIF(TRIM(CAST(l.ref2 AS CHAR)), ''),
		             NULLIF(TRIM(CAST(l.invoice_nr AS CHAR)), ''),
		             SUBSTRING_INDEX(CAST(h.source_id AS CHAR), ':', -1)
		           )
		           AND (ii_other.job_number IS NULL OR ii_other.job_number <> ?)
		       )
		     )
		   )${asAt ? `
		   AND h.trxdate <= ?` : ''}`,
		[
			...SUPPLIER_WIP_SOURCES,
			wipAccnr,
			jobNumber,
			...INFERABLE_UNSCOPED_WIP_SOURCES,
			jobNumber,
			jobNumber,
			...(asAt ? [asAt] : [])
		]
	);
	const total = round2(wipRows && wipRows[0] && wipRows[0].total);
	if (options.requireNonNegative && total < -0.009) {
		throw Object.assign(new Error('Supplier WIP for this job has a negative balance. Reconcile it before invoicing.'), { code: 'JOB_WIP_MISMATCH', statusCode: 409 });
	}
	return { wipAccnr, total: Math.max(0, total) };
}

module.exports = {
	INCLUDED_LINE_SQL,
	costedLineSql,
	getJobWipDebitedTotal
};
