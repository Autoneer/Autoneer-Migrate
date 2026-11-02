"use strict";

// Post-migration job clean-up for the Clean Up page's WIP Cleanup card.
//
// Legacy workshops invoiced and settled jobs under the old process and never
// moved them to RELEASED, so the PWA's Pulse card shows thousands of "Ready for
// Collection" jobs and Service Due hides their vehicles as still on the floor.
// This reads the jobs the Pulse card counts (COMPLETED or READY FOR COLLECTION,
// not a historical import, not a rebuild, with a finalised invoice), works out
// each one's balance owing the way the release gate does (invoice total less
// paid, per invoice) and releases the settled ones completed on or before a
// cut-off, exactly as the PWA's Release Vehicle action does: status, WIP status
// and location change, every date stays. Each release is logged in
// migrate_job_releases so it can be undone. Every function runs inside
// withPool(), like the backfill mirror.

const { query, companyTransaction } = require("../gl/glBackfill/mirror/database/database");
const openingStock = require("../gl/glBackfill/openingStock");
const wipWriteOff = require("../gl/glBackfill/wipWriteOff");
const { round2 } = require("../gl/glBackfill/openingStockPlan");

const REQUIRED_TABLES = ["job_information", "invoices"];
const LOG_TABLE = "migrate_job_releases";
// The PWA's job timeline. The release row is dated on the job's completion
// date, so the job history shows the release when the work was done, and is
// marked as a migration clean-up by its actor, route and values.
const AUDIT_TABLE = "job_audit_log";
const AUDIT_ACTOR = "Autoneer-Migrate";
const AUDIT_ROUTE = "/tools/cleanup/wip/release";
const AUDIT_METHOD = "MIGRATE";
const AWAITING_RELEASE_STATUSES = ["COMPLETED", "READY FOR COLLECTION"];
const DEFAULT_CUTOFF_DAYS = 30;
const CHUNK = 500;
const GL_LIST_LIMIT = 2000;
const BUCKETS = {
	SETTLED: "Invoice amount > 0, settled",
	OWING: "Invoice amount > 0, balance owing",
	ZERO: "Invoice amount = 0"
};
// The buckets a run may release; OWING never is.
const RELEASABLE_BUCKETS = ["SETTLED", "ZERO"];
const KEEP_REASONS = {
	OWING: "Balance owing",
	BUCKET: "Bucket not selected",
	NO_DATE: "No completion date",
	RECENT: "Completed after the cut-off",
	YEAR: "Year not selected"
};
const GL_STATUS_LABELS = { NO_JOB: "No job on the line", NOT_IN_TENANT: "Job not in the tenant", BLANK: "(no status)" };

function httpError(statusCode, code, message) {
	return Object.assign(new Error(message), { statusCode, code });
}

function flag(value, fallback = false) {
	if (value == null || value === "") return fallback;
	return value === true || ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function daysBefore(ymd, days) {
	const date = new Date(`${ymd}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() - days);
	return date.toISOString().slice(0, 10);
}

function todayYmd() {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function chunks(list, size = CHUNK) {
	const out = [];
	for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
	return out;
}

/** The options a preview or release runs with. */
function readOptions(input = {}) {
	const defaultCutoff = daysBefore(todayYmd(), DEFAULT_CUTOFF_DAYS);
	const cutoffDate = input.cutoffDate == null || input.cutoffDate === "" ? defaultCutoff : String(input.cutoffDate);
	if (!openingStock.isYmd(cutoffDate)) throw httpError(400, "invalid_date", "Enter the cut-off date as YYYY-MM-DD.");
	const expectedJobs = input.expectedJobs == null || input.expectedJobs === "" ? null : Number(input.expectedJobs);
	if (expectedJobs != null && !Number.isInteger(expectedJobs)) throw httpError(400, "invalid_count", "expectedJobs must be a whole number.");
	return {
		cutoffDate, defaultCutoff, buckets: readBuckets(input), years: readYears(input.years),
		expectedJobs, dryRun: flag(input.dryRun, false)
	};
}

function listInput(value) {
	if (Array.isArray(value)) return value;
	if (value == null || value === "") return null;
	return String(value).split(",");
}

// The buckets to release: both unless the request names some. An older
// request's includeZero=false means the settled bucket only.
function readBuckets(input) {
	const list = listInput(input.buckets);
	if (list == null) return flag(input.includeZero, true) ? [...RELEASABLE_BUCKETS] : ["SETTLED"];
	const buckets = [...new Set(list.map((b) => String(b).trim().toUpperCase()))];
	const bad = buckets.filter((b) => !RELEASABLE_BUCKETS.includes(b));
	if (bad.length) throw httpError(400, "invalid_bucket", `Only the ${RELEASABLE_BUCKETS.join(" and ")} buckets can be released, not ${bad.join(", ")}.`);
	return RELEASABLE_BUCKETS.filter((b) => buckets.includes(b));
}

// The completion years to release, or null for every year.
function readYears(value) {
	const list = listInput(value);
	if (list == null) return null;
	const years = [...new Set(list.map((y) => String(y).trim()))].filter(Boolean).sort();
	const bad = years.filter((y) => !/^\d{4}$/.test(y));
	if (bad.length) throw httpError(400, "invalid_year", `Enter completion years as YYYY, not ${bad.join(", ")}.`);
	return years;
}

/** One line saying what a run covers, for the confirm dialog and the batch log. */
function scopeNote({ cutoffDate, buckets, years }) {
	const bucketText = buckets.length === RELEASABLE_BUCKETS.length ? "Settled and zero-amount" : buckets.includes("ZERO") ? "Zero-amount only" : "Settled only";
	const yearText = !years ? "every year" : !years.length ? "no years" : years.length === 1 ? years[0] : `${years.length} years: ${years.join(", ")}`;
	return `${bucketText} · ${yearText} · completed on or before ${cutoffDate}`;
}

/**
 * The job_audit_log row the PWA's Release Vehicle action would have written,
 * as the column list [job_number, cid, event_type, event_action, entity_type,
 * entity_id, title, description, old_values_json, new_values_json,
 * changed_fields_json, staff_id, staff_name, source_route, source_method,
 * created_at]. created_at is the job's status date (the completion date when
 * there is none), so the PWA shows the release on that date (the storyboard
 * reads the JOB/RELEASED row) and the Pulse card's Released Today never
 * counts it.
 */
function auditRow(job, batchId, releasedAt) {
	const releasedOn = releasedAt instanceof Date ? releasedAt.toISOString().slice(0, 10) : String(releasedAt);
	const datedOn = releaseDateOf(job);
	const oldValues = { status: job.status, wipstatus: job.wipstatus, location: job.location };
	const newValues = {
		status: "RELEASED", wipstatus: "RELEASED", location: "WITH OWNER",
		migration_cleanup: true, cleanup_batch: batchId, cleanup_run_on: releasedOn, release_dated_on: datedOn
	};
	return [
		job.job_number, job.cid, "JOB", "RELEASED", "job_information", String(job.job_number),
		"Vehicle released (migration clean-up)",
		`Job status changed from ${job.status || "UNKNOWN"} to RELEASED by the Autoneer-Migrate clean-up run on ${releasedOn}. ` +
		`The job was invoiced and settled under the old process and never released; the release is dated on its ${job.status_date ? "status date" : "completion date"}, ${datedOn}.`,
		JSON.stringify(oldValues), JSON.stringify(newValues), JSON.stringify(["status", "wipstatus", "location"]),
		null, AUDIT_ACTOR, AUDIT_ROUTE, AUDIT_METHOD, `${datedOn} 00:00:00`
	];
}

// The PWA's financially-finalised invoice rule (lib/finance/jobInvoiceLock.js).
function finalisedInvoiceSql(alias) {
	return `${alias}.voided_at IS NULL AND UPPER(COALESCE(${alias}.status, '')) <> 'VOID'
		AND (${alias}.posted_at IS NOT NULL OR UPPER(COALESCE(${alias}.status, '')) IN ('POSTED', 'FINAL', 'CREDIT', 'SPLIT'))`;
}

/**
 * The jobs the Pulse card counts as Ready for Collection, each with its
 * finalised invoices' total, paid and balance owing (credit notes and SPLIT
 * parents carry no amount) and the completion date the Pulse card sorts by.
 */
async function readAwaitingJobs(schema, queryFn = query) {
	const s = `\`${schema}\``;
	return queryFn(
		`SELECT J.job_number, J.cid, J.regnr, J.status, J.wipstatus, J.location,
		        DATE_FORMAT(COALESCE(J.date_finished, J.status_date, J.date_received), '%Y-%m-%d') AS completed_on,
		        DATE_FORMAT(J.status_date, '%Y-%m-%d') AS status_date,
		        COALESCE(inv.invoices, 0) AS invoices, COALESCE(inv.total, 0) AS total,
		        COALESCE(inv.paid, 0) AS paid, COALESCE(inv.owing, 0) AS owing
		 FROM ${s}.job_information J
		 LEFT JOIN (
		   SELECT i.job_number, COUNT(*) AS invoices,
		          ROUND(SUM(COALESCE(i.inv_totalinclvat, 0)), 2) AS total,
		          ROUND(SUM(COALESCE(i.paid, 0)), 2) AS paid,
		          ROUND(SUM(GREATEST(0, COALESCE(i.inv_totalinclvat, 0) - COALESCE(i.paid, 0))), 2) AS owing
		   FROM ${s}.invoices i
		   WHERE ${finalisedInvoiceSql("i")}
		     AND i.credit_for_invoice_nr IS NULL AND UPPER(COALESCE(i.status, '')) <> 'SPLIT'
		   GROUP BY i.job_number
		 ) inv ON inv.job_number = J.job_number
		 WHERE UPPER(TRIM(COALESCE(J.status, ''))) IN (${AWAITING_RELEASE_STATUSES.map(() => "?").join(", ")})
		   AND COALESCE(J.is_historical_import, 0) = 0
		   AND UPPER(TRIM(COALESCE(J.jobtype, ''))) <> 'REBUILD'
		   AND EXISTS (SELECT 1 FROM ${s}.invoices f WHERE f.job_number = J.job_number AND ${finalisedInvoiceSql("f")})
		 ORDER BY completed_on, J.job_number`,
		AWAITING_RELEASE_STATUSES
	);
}

/**
 * Sorts each job into a bucket and decides whether this run releases it: a
 * job in a selected bucket (settled, or zero-amount), completed on or before
 * the cut-off, in a selected year. Anything else is kept, with the reason.
 */
function planJobs(rows, { cutoffDate, buckets = RELEASABLE_BUCKETS, years = null }) {
	const yearSet = years ? new Set(years) : null;
	return rows.map((row) => {
		const total = round2(row.total);
		const paid = round2(row.paid);
		const owing = round2(row.owing);
		const bucket = total > 0.005 ? (owing > 0.005 ? "OWING" : "SETTLED") : "ZERO";
		const completedOn = row.completed_on || null;
		const keep = bucket === "OWING" ? "OWING"
			: !buckets.includes(bucket) ? "BUCKET"
				: !completedOn ? "NO_DATE"
					: completedOn > cutoffDate ? "RECENT"
						: yearSet && !yearSet.has(completedOn.slice(0, 4)) ? "YEAR" : null;
		return {
			job_number: Number(row.job_number), cid: row.cid == null ? null : Number(row.cid), regnr: row.regnr || null,
			status: String(row.status || "").trim().toUpperCase(), wipstatus: row.wipstatus || null, location: row.location || null,
			completed_on: completedOn, status_date: row.status_date || null,
			invoices: Number(row.invoices) || 0, total, paid, owing, bucket, release: !keep, keep
		};
	});
}

function sumJobs(list) {
	const dates = list.map((job) => job.completed_on).filter(Boolean).sort();
	return {
		jobs: list.length,
		total: round2(list.reduce((sum, job) => sum + job.total, 0)),
		owing: round2(list.reduce((sum, job) => sum + job.owing, 0)),
		oldest: dates[0] || null,
		newest: dates[dates.length - 1] || null
	};
}

// Jobs by completion year (length 4) or month (length 7), oldest first.
function byPeriod(list, length) {
	const groups = new Map();
	for (const job of list) {
		const period = job.completed_on ? job.completed_on.slice(0, length) : "unknown";
		if (!groups.has(period)) groups.set(period, []);
		groups.get(period).push(job);
	}
	return [...groups.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([period, jobs]) => ({
			period, ...sumJobs(jobs),
			unpaid: jobs.filter((job) => job.owing > 0.005).length,
			released: jobs.filter((job) => job.release).length,
			// What the period would release if it were selected.
			candidates: jobs.filter((job) => job.release || job.keep === "YEAR").length
		}));
}

/** The figures the card and the confirm dialog show. */
function summarizePlan(jobs) {
	const release = jobs.filter((job) => job.release);
	const kept = jobs.filter((job) => !job.release);
	const amount = jobs.filter((job) => job.bucket !== "ZERO");
	return {
		awaiting: sumJobs(jobs),
		buckets: Object.fromEntries(Object.keys(BUCKETS).map((key) => [key, sumJobs(jobs.filter((job) => job.bucket === key))])),
		byYear: byPeriod(amount, 4),
		years: byPeriod(jobs, 4).filter((year) => year.period !== "unknown"),
		owingByMonth: byPeriod(jobs.filter((job) => job.bucket === "OWING"), 7),
		zeroByMonth: byPeriod(jobs.filter((job) => job.bucket === "ZERO"), 7),
		release: sumJobs(release),
		releaseByYear: byPeriod(release, 4),
		kept: sumJobs(kept),
		keptByReason: Object.fromEntries(Object.keys(KEEP_REASONS).map((reason) => [reason, sumJobs(kept.filter((job) => job.keep === reason))]))
	};
}

function publicJob(job) {
	const { cid, wipstatus, location, status_date, ...rest } = job;
	return rest;
}

/** The date the timeline row carries: the job's status date, or its completion date when there is none. */
function releaseDateOf(job) {
	return job.status_date || job.completed_on;
}

// ── The release log ──────────────────────────────────────────────────────────

async function ensureLogTable(schema, queryFn = query) {
	// DDL commits implicitly in MySQL, so this runs before the transaction.
	await queryFn(
		`CREATE TABLE IF NOT EXISTS \`${schema}\`.${LOG_TABLE} (
		   id BIGINT AUTO_INCREMENT PRIMARY KEY,
		   batch_id INT NOT NULL,
		   job_number INT NOT NULL,
		   old_status VARCHAR(50) DEFAULT NULL,
		   old_wipstatus VARCHAR(50) DEFAULT NULL,
		   old_location VARCHAR(100) DEFAULT NULL,
		   completed_on DATE DEFAULT NULL,
		   invoice_total DECIMAL(18,2) NOT NULL DEFAULT 0.00,
		   cutoff_date DATE NOT NULL,
		   released_at DATETIME NOT NULL,
		   undone_at DATETIME DEFAULT NULL,
		   undo_result VARCHAR(20) DEFAULT NULL,
		   audit_id BIGINT DEFAULT NULL,
		   scope_note VARCHAR(255) DEFAULT NULL,
		   INDEX idx_${LOG_TABLE}_batch (batch_id),
		   INDEX idx_${LOG_TABLE}_job (job_number)
		 ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
	);
	// A log made by an earlier version lacks the later columns.
	const present = new Set((await queryFn(
		"SELECT LOWER(column_name) AS name FROM information_schema.columns WHERE table_schema = ? AND table_name = ?",
		[schema, LOG_TABLE]
	)).map((row) => row.name));
	if (!present.has("audit_id")) await queryFn(`ALTER TABLE \`${schema}\`.${LOG_TABLE} ADD COLUMN audit_id BIGINT DEFAULT NULL`);
	if (!present.has("scope_note")) await queryFn(`ALTER TABLE \`${schema}\`.${LOG_TABLE} ADD COLUMN scope_note VARCHAR(255) DEFAULT NULL`);
}

/** Writes the batch's release rows to the PWA job timeline and remembers each row's id on the log. */
async function writeAuditRows(schema, jobs, batchId, releasedAt, queryFn) {
	for (const part of chunks(jobs)) {
		await queryFn(
			`INSERT INTO \`${schema}\`.${AUDIT_TABLE}
			   (job_number, cid, event_type, event_action, entity_type, entity_id, title, description,
			    old_values_json, new_values_json, changed_fields_json, staff_id, staff_name, source_route, source_method, created_at)
			 VALUES ${part.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}`,
			part.flatMap((job) => auditRow(job, batchId, releasedAt))
		);
	}
	// Auto-increment ids need not be consecutive, so the rows are matched back by batch.
	const result = await queryFn(
		`UPDATE \`${schema}\`.${LOG_TABLE} l
		 JOIN \`${schema}\`.${AUDIT_TABLE} a ON a.job_number = l.job_number AND a.event_type = 'JOB' AND a.event_action = 'RELEASED'
		   AND a.source_method = ? AND CAST(JSON_UNQUOTE(JSON_EXTRACT(a.new_values_json, '$.cleanup_batch')) AS UNSIGNED) = l.batch_id
		 SET l.audit_id = a.audit_id
		 WHERE l.batch_id = ?`,
		[AUDIT_METHOD, batchId]
	);
	return Number(result.affectedRows) || 0;
}

/** Every release batch, newest first: how many jobs it released and how many an undo put back. */
async function readBatches(schema, tables, queryFn = query) {
	if (!tables.has(LOG_TABLE)) return [];
	const rows = await queryFn(
		`SELECT batch_id, DATE_FORMAT(MIN(released_at), '%Y-%m-%d %H:%i') AS released_at, DATE_FORMAT(MIN(cutoff_date), '%Y-%m-%d') AS cutoff_date,
		        MIN(scope_note) AS scope_note, COUNT(*) AS jobs, SUM(undone_at IS NULL) AS active, SUM(undo_result = 'restored') AS restored, SUM(undo_result = 'skipped') AS skipped,
		        DATE_FORMAT(MAX(undone_at), '%Y-%m-%d %H:%i') AS undone_at
		 FROM \`${schema}\`.${LOG_TABLE} GROUP BY batch_id ORDER BY batch_id DESC`
	);
	return rows.map((row) => ({
		batchId: Number(row.batch_id), releasedAt: row.released_at, cutoffDate: row.cutoff_date, scope: row.scope_note || null,
		jobs: Number(row.jobs), active: Number(row.active), restored: Number(row.restored), skipped: Number(row.skipped), undoneAt: row.undone_at
	}));
}

// ── The GL WIP control, kept on the card for reference ───────────────────────

async function readGlJobWip(schema, wipAccnr, queryFn = query) {
	const s = `\`${schema}\``;
	const issued = openingStock.ISSUED_INVOICE_STATUSES;
	return queryFn(
		`SELECT w.job_number, w.wip, w.last_moved, j.job_number IS NOT NULL AS in_tenant,
		        UPPER(TRIM(COALESCE(j.status, ''))) AS status,
		        EXISTS (
		          SELECT 1 FROM ${s}.invoices i
		          WHERE i.job_number = w.job_number AND COALESCE(i.invoice_nr, 0) > 0
		            AND UPPER(TRIM(COALESCE(i.status, ''))) IN (${issued.map(() => "?").join(", ")})
		        ) AS invoiced
		 FROM (
		   SELECT COALESCE(l.job_number, 0) AS job_number, ROUND(SUM(l.debit - l.credit), 2) AS wip,
		          DATE_FORMAT(MAX(h.trxdate), '%Y-%m-%d') AS last_moved
		   FROM ${s}.gl_journal_headers h JOIN ${s}.gl_journal_lines l ON l.header_id = h.id
		   WHERE h.status = 'POSTED' AND l.accnr = ?
		   GROUP BY COALESCE(l.job_number, 0)
		   HAVING ABS(SUM(l.debit - l.credit)) >= 0.005
		 ) w
		 LEFT JOIN ${s}.job_information j ON w.job_number > 0 AND j.job_number = w.job_number
		 ORDER BY w.wip DESC, w.job_number`,
		[...issued, wipAccnr]
	);
}

/** Groups the jobs carrying GL WIP by status and whether they were invoiced, biggest WIP first. */
function groupGlJobs(rows) {
	const jobs = rows.map((row) => {
		const job = Number(row.job_number) || 0;
		const status = !job ? GL_STATUS_LABELS.NO_JOB
			: !Number(row.in_tenant) ? GL_STATUS_LABELS.NOT_IN_TENANT
				: String(row.status || "").trim() || GL_STATUS_LABELS.BLANK;
		return { job_number: job, status, invoiced: Boolean(Number(row.invoiced)), wip: round2(row.wip), last_moved: row.last_moved || null };
	});
	const sum = (list) => ({ jobs: list.length, value: round2(list.reduce((total, job) => total + job.wip, 0)) });
	const groups = new Map();
	for (const job of jobs) {
		const key = `${job.status}|${job.invoiced ? 1 : 0}`;
		if (!groups.has(key)) groups.set(key, { status: job.status, invoiced: job.invoiced, list: [] });
		groups.get(key).list.push(job);
	}
	return {
		total: sum(jobs),
		groups: [...groups.values()]
			.map(({ status, invoiced, list }) => ({ status, invoiced, ...sum(list) }))
			.sort((a, b) => Math.abs(b.value) - Math.abs(a.value) || a.status.localeCompare(b.status)),
		jobs: jobs.slice(0, GL_LIST_LIMIT),
		truncated: jobs.length > GL_LIST_LIMIT
	};
}

async function readGlWip(schema, context) {
	if (!["gl_accounts", "gl_control_accounts", "gl_journal_headers", "gl_journal_lines"].every((table) => context.tables.has(table))) return null;
	const row = context.controlsByKey.WIP;
	const control = row
		? { accnr: row.accnr, name: row.name, status: row.status, reason: row.reason }
		: { accnr: null, name: null, status: "missing", reason: "no WIP control account" };
	if (control.status !== "mapped") return { control, balance: null, wip: null, writeOffDate: null };
	const [balanceRow] = await query(
		`SELECT ROUND(COALESCE(SUM(l.debit - l.credit), 0), 2) AS balance
		 FROM \`${schema}\`.gl_journal_headers h JOIN \`${schema}\`.gl_journal_lines l ON l.header_id = h.id
		 WHERE h.status = 'POSTED' AND l.accnr = ?`,
		[control.accnr]
	);
	return {
		control, balance: Number(balanceRow.balance) || 0,
		wip: groupGlJobs(await readGlJobWip(schema, control.accnr)),
		writeOffDate: await wipWriteOff.readWipWriteOffDate(schema)
	};
}

// ── Preview, release, undo ───────────────────────────────────────────────────

/** Read-only: the jobs awaiting release, the buckets, and what this run would release. */
async function readWipCleanup({ schema, input = {} }) {
	const options = readOptions(input);
	const context = await openingStock.readCutoverContext(schema);
	const missingTables = REQUIRED_TABLES.filter((table) => !context.tables.has(table));
	if (missingTables.length) return { schema, ready: false, missingTables };
	const jobs = planJobs(await readAwaitingJobs(schema), options);
	const batches = await readBatches(schema, context.tables);
	return {
		schema, ready: true, missingTables,
		cutoffDate: options.cutoffDate, defaultCutoff: options.defaultCutoff, cutoffDays: DEFAULT_CUTOFF_DAYS,
		buckets: options.buckets, years: options.years, scope: scopeNote(options),
		backfill: context.backfill, auditTable: context.tables.has(AUDIT_TABLE),
		bucketLabels: BUCKETS, releasableBuckets: RELEASABLE_BUCKETS, keepReasons: KEEP_REASONS,
		summary: summarizePlan(jobs),
		jobs: jobs.map(publicJob),
		batches,
		lastBatch: batches.find((batch) => batch.active > 0) || null,
		gl: await readGlWip(schema, context)
	};
}

/**
 * Releases the planned jobs in one transaction, as the PWA's Release Vehicle
 * action does (status, WIP status and location; no dates change), and logs
 * each job's old values under a new batch. Refuses when the tenant no longer
 * matches the preview the user confirmed.
 */
async function releaseCompletedJobs({ schema, input = {} }) {
	const options = readOptions(input);
	const context = await openingStock.readCutoverContext(schema);
	const missing = REQUIRED_TABLES.filter((table) => !context.tables.has(table));
	if (missing.length) throw httpError(409, "missing_tables", `Missing ${missing.join(", ")}.`);
	await ensureLogTable(schema);
	const tx = await companyTransaction();
	try {
		const jobs = planJobs(await readAwaitingJobs(schema, tx.query), options).filter((job) => job.release);
		if (!jobs.length) throw httpError(409, "nothing_to_release", "No job matches the cut-off. Nothing was changed.");
		if (options.expectedJobs != null && options.expectedJobs !== jobs.length) {
			throw httpError(409, "preview_stale", `The tenant changed since the preview: ${jobs.length} jobs would be released, not ${options.expectedJobs}. ` +
				"Check the preview again. Nothing was changed.");
		}
		const [{ next }] = await tx.query(`SELECT COALESCE(MAX(batch_id), 0) + 1 AS next FROM \`${schema}\`.${LOG_TABLE}`);
		const batchId = Number(next);
		const releasedAt = new Date();
		const scope = scopeNote(options).slice(0, 255);
		for (const part of chunks(jobs)) {
			await tx.query(
				`INSERT INTO \`${schema}\`.${LOG_TABLE} (batch_id, job_number, old_status, old_wipstatus, old_location, completed_on, invoice_total, cutoff_date, released_at, scope_note)
				 VALUES ${part.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}`,
				part.flatMap((job) => [batchId, job.job_number, job.status, job.wipstatus, job.location, job.completed_on, job.total, options.cutoffDate, releasedAt, scope])
			);
		}
		let updated = 0;
		for (const part of chunks(jobs)) {
			const result = await tx.query(
				`UPDATE \`${schema}\`.job_information SET status = 'RELEASED', wipstatus = 'RELEASED', location = 'WITH OWNER'
				 WHERE job_number IN (?) AND UPPER(TRIM(COALESCE(status, ''))) IN (${AWAITING_RELEASE_STATUSES.map(() => "?").join(", ")})`,
				[part.map((job) => job.job_number), ...AWAITING_RELEASE_STATUSES]
			);
			updated += Number(result.affectedRows) || 0;
		}
		if (updated !== jobs.length) throw new Error(`${updated} jobs changed where ${jobs.length} were planned. Nothing was changed.`);
		const auditTable = context.tables.has(AUDIT_TABLE);
		const auditRows = auditTable ? await writeAuditRows(schema, jobs, batchId, releasedAt, tx.query) : 0;
		if (auditTable && auditRows !== jobs.length) throw new Error(`${auditRows} audit rows written where ${jobs.length} were planned. Nothing was changed.`);
		if (options.dryRun) await tx.rollback();
		else await tx.commit();
		const totals = sumJobs(jobs);
		return {
			batchId, jobs: jobs.length, auditRows, auditTable, dryRun: options.dryRun, scope,
			total: totals.total, oldest: totals.oldest, newest: totals.newest, cutoffDate: options.cutoffDate
		};
	} catch (err) {
		await tx.rollback();
		throw err;
	}
}

/**
 * Puts a batch's jobs back to their old status, WIP status and location, as
 * long as they are still RELEASED. A job the workshop has moved since is
 * skipped and reported. Without a batch id the latest batch with jobs still
 * released is undone.
 */
async function undoRelease({ schema, input = {} }) {
	const context = await openingStock.readCutoverContext(schema);
	if (!context.tables.has(LOG_TABLE)) throw httpError(404, "not_released", "No jobs have been released from here.");
	const tx = await companyTransaction();
	try {
		let batchId = input.batchId == null || input.batchId === "" ? null : Number(input.batchId);
		if (batchId == null) {
			const [row] = await tx.query(`SELECT MAX(batch_id) AS batch_id FROM \`${schema}\`.${LOG_TABLE} WHERE undone_at IS NULL`);
			batchId = row && row.batch_id != null ? Number(row.batch_id) : null;
		}
		if (!Number.isInteger(batchId)) throw httpError(404, "not_released", "There is no release batch to undo.");
		const rows = await tx.query(
			`SELECT id, job_number, old_status, old_wipstatus, old_location, audit_id FROM \`${schema}\`.${LOG_TABLE} WHERE batch_id = ? AND undone_at IS NULL FOR UPDATE`,
			[batchId]
		);
		if (!rows.length) throw httpError(409, "already_undone", `Batch ${batchId} has already been undone.`);
		const stillReleased = new Set();
		for (const part of chunks(rows)) {
			const found = await tx.query(
				`SELECT job_number FROM \`${schema}\`.job_information WHERE job_number IN (?) AND UPPER(TRIM(COALESCE(status, ''))) = 'RELEASED' FOR UPDATE`,
				[part.map((row) => row.job_number)]
			);
			found.forEach((row) => stillReleased.add(Number(row.job_number)));
		}
		const restore = rows.filter((row) => stillReleased.has(Number(row.job_number)));
		const skipped = rows.filter((row) => !stillReleased.has(Number(row.job_number)));
		// One UPDATE per distinct set of old values.
		const groups = new Map();
		for (const row of restore) {
			const key = JSON.stringify([row.old_status, row.old_wipstatus, row.old_location]);
			if (!groups.has(key)) groups.set(key, { values: [row.old_status, row.old_wipstatus, row.old_location], jobs: [] });
			groups.get(key).jobs.push(row.job_number);
		}
		let restored = 0;
		for (const { values, jobs } of groups.values()) {
			for (const part of chunks(jobs)) {
				const result = await tx.query(
					`UPDATE \`${schema}\`.job_information SET status = ?, wipstatus = ?, location = ? WHERE job_number IN (?) AND UPPER(TRIM(COALESCE(status, ''))) = 'RELEASED'`,
					[...values, part]
				);
				restored += Number(result.affectedRows) || 0;
			}
		}
		if (restored !== restore.length) throw new Error(`${restored} jobs restored where ${restore.length} were still released. Nothing was changed.`);
		// The timeline rows of the restored jobs go too; a skipped job keeps its history.
		let auditRemoved = 0;
		const auditIds = restore.map((row) => row.audit_id).filter((id) => id != null);
		if (auditIds.length && context.tables.has(AUDIT_TABLE)) {
			for (const part of chunks(auditIds)) {
				const result = await tx.query(`DELETE FROM \`${schema}\`.${AUDIT_TABLE} WHERE audit_id IN (?) AND source_method = ?`, [part, AUDIT_METHOD]);
				auditRemoved += Number(result.affectedRows) || 0;
			}
		}
		const undoneAt = new Date();
		for (const [list, result] of [[restore, "restored"], [skipped, "skipped"]]) {
			for (const part of chunks(list)) {
				await tx.query(`UPDATE \`${schema}\`.${LOG_TABLE} SET undone_at = ?, undo_result = ? WHERE id IN (?)`, [undoneAt, result, part.map((row) => row.id)]);
			}
		}
		await tx.commit();
		return { batchId, restored: restore.length, auditRemoved, skipped: skipped.length, skippedJobs: skipped.slice(0, 50).map((row) => Number(row.job_number)) };
	} catch (err) {
		await tx.rollback();
		throw err;
	}
}

module.exports = {
	REQUIRED_TABLES, LOG_TABLE, AUDIT_TABLE, AUDIT_ACTOR, AUDIT_METHOD, BUCKETS, RELEASABLE_BUCKETS, KEEP_REASONS, DEFAULT_CUTOFF_DAYS,
	readOptions, planJobs, summarizePlan, scopeNote, groupGlJobs, auditRow,
	readWipCleanup, releaseCompletedJobs, undoRelease
};
