const { escape } = require('mysql2');

// Job zero is a valid general invoice's no-job sentinel. Keep the existing
// generated expression for real jobs, including all application-owned rules.
async function ensureInvoiceActiveJobSchema(pool, { dryRun = false } = {}) {
	const [[column]] = await pool.query(`
		SELECT COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable,
			EXTRA AS extra, GENERATION_EXPRESSION AS expression, COLUMN_COMMENT AS comment
		FROM information_schema.columns
		WHERE table_schema = DATABASE() AND table_name = 'invoices'
			AND column_name = 'job_number_active'
	`);
	if (!column) return { status: 'skipped', reason: 'no_active_job_column' };

	const [index] = await pool.query(`
		SELECT NON_UNIQUE AS nonUnique, COLUMN_NAME AS columnName, SUB_PART AS prefixLength
		FROM information_schema.statistics
		WHERE table_schema = DATABASE() AND table_name = 'invoices'
			AND index_name = 'uq_invoices_active_job' ORDER BY SEQ_IN_INDEX
	`);
	if (!index.length) return { status: 'skipped', reason: 'no_active_job_key' };
	if (index.length !== 1 || Number(index[0].nonUnique) !== 0
		|| index[0].columnName !== 'job_number_active' || index[0].prefixLength != null) {
		throw new Error('Cannot repair invoices: uq_invoices_active_job must be unique on job_number_active only.');
	}
	const storage = /\b(STORED|VIRTUAL) GENERATED\b/i.exec(column.extra || '')?.[1]?.toUpperCase();
	if (!storage || !column.expression || column.isNullable !== 'YES'
		|| !/^(tinyint|smallint|mediumint|int|bigint)(\(\d+\))?( unsigned)?$/i.test(column.columnType)) {
		throw new Error('Cannot repair invoices: job_number_active must be a nullable generated integer column.');
	}
	// MySQL normalizes expressions with additional parentheses and backticks.
	const normalized = column.expression.replace(/[\s`()]/g, '').toLowerCase();
	if (normalized.startsWith('casewhenjob_number=0thennullelse')) {
		return { status: 'unchanged' };
	}
	if (dryRun) return { status: 'pending', reason: 'dry_run' };

	await pool.query(`ALTER TABLE \`invoices\`
		MODIFY COLUMN \`job_number_active\` ${column.columnType} GENERATED ALWAYS AS (
			CASE WHEN \`job_number\` = 0 THEN NULL ELSE (${column.expression}) END
		) ${storage} COMMENT ${escape(column.comment || '')}${/\bINVISIBLE\b/i.test(column.extra) ? ' INVISIBLE' : ''}`);
	return { status: 'updated' };
}

module.exports = { ensureInvoiceActiveJobSchema };
