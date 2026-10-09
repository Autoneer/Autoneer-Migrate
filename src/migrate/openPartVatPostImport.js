// Post-import VAT state for imported job lines.
//
// Legacy SPARES_USED rows have no vat_rate snapshot and often a stale VAT amount.
// This mirrors AUTONEER-PWA's open-line rule (src/services/finalise/
// openJobPartVat.service.js and scripts/audit/repair_open_job_part_vat.js)
// without running or writing anything in the PWA checkout. Keep it in step with
// that rule; tests/openPartVatPostImport.test.js checks parity against it.
// Lines attached to an invoice are never written.

const OPEN_LINE_SQL = "(su.invoice_nr is null or su.invoice_nr = 0)";
const ACTIVE_INVOICE_SQL = `exists (
	select 1 from invoices inv
	where inv.job_number = su.job_number
	  and inv.voided_at is null
	  and upper(coalesce(inv.status, '')) <> 'VOID'
)`;

function roundMoney(value) {
	const number = Number(value);
	return Math.round(((Number.isFinite(number) ? number : 0) + Number.EPSILON) * 100) / 100;
}

function isCustomVatPartLine(partnr) {
	const normalized = String(partnr || "").trim().toUpperCase();
	return normalized === "GENERIC" ||
		normalized.startsWith("GEN-") ||
		normalized === "SUNDRY" ||
		normalized.startsWith("SUNDRY-");
}

/**
 * Rate for one open line, in order of authority:
 *   1. the rate already captured on the line;
 *   2. the linked stock item's taxable flag × the tenant rate;
 *   3. for generic/sundry lines and lines with no linked stock item, the rate
 *      implied by the stored VAT;
 *   4. otherwise zero-rated.
 */
function resolveOpenPartVatRate(row, companyVatRate) {
	const exclusive = Number(row.sales_price) || 0;
	let rate = row.vat_rate == null ? null : Number(row.vat_rate);
	if (!Number.isFinite(rate) || rate < 0) rate = null;
	if (rate == null && row.stock_vat != null) {
		rate = String(row.stock_vat).trim().toUpperCase() === "YES" ? companyVatRate : 0;
	}
	if (rate == null && exclusive > 0 && (isCustomVatPartLine(row.partnr) || row.stock_vat == null)) {
		rate = Math.max(0, (Number(row.vat) || 0) / exclusive);
	}
	return rate == null ? 0 : rate;
}

function planOpenPartVatLine(row, companyVatRate) {
	const resolved = resolveOpenPartVatRate(row, companyVatRate);
	const vatRate = resolved > 0 ? resolved : 0;
	const exclusive = roundMoney(Number(row.sales_price) || 0);
	const vat = roundMoney(exclusive * vatRate);
	return { spares_id: row.spares_id, vatRate, vat, salesPriceIncVat: roundMoney(exclusive + vat) };
}

async function readTenantVatRate(db) {
	const [tables] = await db.query(
		"select lower(table_name) as name from information_schema.tables where table_schema = database() and lower(table_name) in ('stock', 'company_prefferences')"
	);
	const present = new Set(tables.map((t) => t.name));
	for (const table of ["stock", "company_prefferences"]) {
		if (!present.has(table)) throw new Error(`target table ${table} is missing`);
	}
	// AUTONEER falls back to 15% when the tenant rate is unreadable; an import
	// must not snapshot that guess.
	const [rows] = await db.query("select taxpercent from company_prefferences limit 1");
	const percent = Number.parseFloat(rows[0]?.taxpercent);
	if (!Number.isFinite(percent) || percent === 0) {
		throw new Error("company_prefferences has no taxpercent. Import COMPANY_PREFFERENCES before SPARES_USED");
	}
	return percent / 100;
}

// Same scope as the PWA repair script: open lines of jobs that have no header
// invoice number, are not cancelled, have no active invoice, and still carry at
// least one open line without a VAT snapshot.
async function loadOpenPartLines(db, { forUpdate = false } = {}) {
	const [rows] = await db.query(
		`select su.job_number, su.spares_id, su.partnr, su.spare, su.stock_id, su.sales_price,
		        su.vat, su.vat_rate, su.sales_priceincvat, s.vat as stock_vat
		 from spares_used su
		 left join stock s on s.stock_id = su.stock_id
		 where ${OPEN_LINE_SQL}
		   and coalesce(su.is_excluded_from_quote, 0) = 0
		   and su.job_number in (
		     select ji.job_number from job_information ji
		     where coalesce(ji.invoice_nr, 0) = 0
		       and upper(trim(coalesce(ji.status, ''))) <> 'CANCELLED'
		       and not exists (
		         select 1 from invoices inv
		         where inv.job_number = ji.job_number
		           and inv.voided_at is null
		           and upper(coalesce(inv.status, '')) <> 'VOID'
		       )
		       and exists (
		         select 1 from spares_used pending
		         where pending.job_number = ji.job_number
		           and pending.vat_rate is null
		           and (pending.invoice_nr is null or pending.invoice_nr = 0)
		           and coalesce(pending.is_excluded_from_quote, 0) = 0
		       )
		   )
		 order by su.job_number, su.spares_id${forUpdate ? " for update" : ""}`
	);
	return rows;
}

function summarizePlans(rows, companyVatRate) {
	const jobs = new Set();
	const changed = [];
	const review = [];
	for (const row of rows) {
		jobs.add(row.job_number);
		const plan = planOpenPartVatLine(row, companyVatRate);
		const vatBefore = roundMoney(row.vat);
		const incBefore = roundMoney(row.sales_priceincvat);
		if (Math.abs(vatBefore - plan.vat) >= 0.005 || Math.abs(incBefore - plan.salesPriceIncVat) >= 0.005) {
			changed.push({ job: row.job_number, spares_id: row.spares_id, spare: row.spare || row.partnr || "", salesPrice: Number(row.sales_price) || 0, vatBefore, vatAfter: plan.vat, incBefore, incAfter: plan.salesPriceIncVat });
		}
		// No stock flag to consult: the stored VAT ratio is kept, so a ratio that
		// is not the tenant rate is listed for a person to confirm.
		const noStockFlag = row.vat_rate == null && row.stock_vat == null && !isCustomVatPartLine(row.partnr);
		if (noStockFlag && Number(row.sales_price) > 0 && Math.abs(plan.vatRate - companyVatRate) > 0.0005) {
			review.push({ job: row.job_number, spares_id: row.spares_id, spare: row.spare || row.partnr || "", vatRate: plan.vatRate });
		}
	}
	const netVatChange = roundMoney(changed.reduce((sum, c) => sum + (c.vatAfter - c.vatBefore), 0));
	return { jobs: jobs.size, lines: rows.length, changed, review, netVatChange };
}

async function applyOpenPartVat(pool, companyVatRate, logRun) {
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const rows = await loadOpenPartLines(conn, { forUpdate: true });
		logRun({
			level: "info", phase: "post_import_open_part_vat", step: "snapshot",
			lines: rows.map(({ job_number, spares_id, vat, vat_rate, sales_priceincvat }) => ({ job_number, spares_id, vat, vat_rate, sales_priceincvat }))
		});
		for (const row of rows) {
			const plan = planOpenPartVatLine(row, companyVatRate);
			await conn.query(
				`update spares_used su set su.vat_rate = ?, su.vat = ?, su.sales_priceincvat = ?
				 where su.spares_id = ? and ${OPEN_LINE_SQL}`,
				[plan.vatRate, plan.vat, plan.salesPriceIncVat, row.spares_id]
			);
		}
		await conn.commit();
		return rows.length;
	} catch (err) {
		try { await conn.rollback(); } catch (e) { /* ignore */ }
		throw err;
	} finally {
		conn.release();
	}
}

async function collectVerificationWarnings(pool, importedTables) {
	const warnings = [];
	if (importedTables.has("spares_used")) {
		// The repair also leaves cancelled jobs and jobs whose header carries an
		// invoice number alone; count those separately so the warning is actionable.
		const [[row]] = await pool.query(
			`select count(*) as total,
			        coalesce(sum(ji.job_number is null
			          or upper(trim(coalesce(ji.status, ''))) = 'CANCELLED'
			          or coalesce(ji.invoice_nr, 0) <> 0), 0) as outside_repair
			 from spares_used su
			 left join job_information ji on ji.job_number = su.job_number
			 where su.vat_rate is null
			   and ${OPEN_LINE_SQL}
			   and coalesce(su.is_excluded_from_quote, 0) = 0
			   and not ${ACTIVE_INVOICE_SQL}`
		);
		const total = Number(row.total || 0);
		if (total > 0) {
			const outside = Number(row.outside_repair || 0);
			warnings.push({
				code: "OPEN_PART_VAT_RATE_NULL",
				table: "spares_used",
				count: total,
				message: `${total} open part line(s) still have no vat_rate` +
					(outside ? ` (${outside} on cancelled jobs, jobs with a header invoice number, or without a job record)` : "")
			});
		}
	}
	for (const table of ["spares_used", "work_done"]) {
		if (!importedTables.has(table)) continue;
		const [[row]] = await pool.query(`select count(*) as total from ${table} where invoice_nr = 0`);
		const total = Number(row.total || 0);
		if (total > 0) {
			warnings.push({
				code: "INVOICE_NR_ZERO",
				table,
				count: total,
				message: `${total} ${table} line(s) have invoice_nr = 0 instead of NULL`
			});
		}
	}
	return warnings;
}

/**
 * Run after a completed import. Returns { error, warnings }; never throws.
 * `repair` is false for partial runs, which are verified but not repaired.
 */
async function runOpenPartVatPostImport({ pool, importedTables, repair = true, logRun = () => { } }) {
	const result = { error: null, warnings: [] };
	if (repair && importedTables.has("spares_used")) {
		try {
			const companyVatRate = await readTenantVatRate(pool);
			const dry = summarizePlans(await loadOpenPartLines(pool), companyVatRate);
			logRun({
				level: "info", phase: "post_import_open_part_vat", step: "dry_run", tenantVatRate: companyVatRate,
				jobsWithoutSnapshot: dry.jobs, openLines: dry.lines, linesToRestate: dry.changed.length,
				netVatChange: dry.netVatChange, changed: dry.changed, review: dry.review
			});
			if (dry.lines > 0) {
				const written = await applyOpenPartVat(pool, companyVatRate, logRun);
				logRun({ level: "info", phase: "post_import_open_part_vat", step: "apply", linesSnapshotted: written });
			}
		} catch (err) {
			result.error = `Open part VAT repair failed: ${err.message}`;
			logRun({ level: "error", phase: "post_import_open_part_vat", status: "failed", error: result.error });
		}
	}
	if (importedTables.has("spares_used") || importedTables.has("work_done")) {
		try {
			result.warnings = await collectVerificationWarnings(pool, importedTables);
		} catch (err) {
			result.warnings = [{ code: "POST_IMPORT_CHECK_FAILED", table: null, count: 0, message: `Post-import VAT verification could not run: ${err.message}` }];
		}
		for (const warning of result.warnings) {
			logRun({ level: "warn", phase: "post_import_verification", ...warning });
		}
	}
	return result;
}

module.exports = {
	collectVerificationWarnings,
	planOpenPartVatLine,
	resolveOpenPartVatRate,
	runOpenPartVatPostImport
};
