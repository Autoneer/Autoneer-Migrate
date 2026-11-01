"use strict";

// The migration WIP write-off. The backfill replays supplier invoices into Work
// In Progress job by job and customer invoices relieve it, but much of that
// cost never reaches an invoice: jobs missing from the tenant, cost that came
// in after the job was invoiced, quotes, cancelled and long-finished jobs. One
// WIP_WRITE_OFF journal on the cut-over date moves it to the Opening Stock
// control, one WIP line per job, and keeps the WIP of jobs the PWA may still
// invoice. PWA finalise relieves a job's supplier WIP (getJobWipDebitedTotal)
// without reading this journal, so a written-off job must not be invoiced
// later. Every function runs inside withPool(), like the mirror.

const { query, companyTransaction } = require("./mirror/database/database");
const { getOpenPeriodId, postJournal, deleteGlJournalBySource } = require("./mirror/lib/finance/postingEngine");
const openingStock = require("./openingStock");
const { round2 } = require("./openingStockPlan");

const JOURNAL_SOURCE = "WIP_WRITE_OFF";
const REQUIRED_TABLES = [
	"gl_accounts", "gl_control_accounts", "gl_periods", "gl_journal_headers", "gl_journal_lines",
	"job_information", "invoices", "spares_used", "company_prefferences"
];
const CANCELLED_JOB_STATUSES = ["CANCELLED", "DELETED"];
// By default an unfinished job keeps its WIP when it moved in the months before the cut-over.
const KEEP_MONTHS = 6;
const REASONS = {
	NO_JOB: "No job on the line",
	NOT_IN_TENANT: "Job not in the tenant",
	INVOICED: "Left after the job's invoice",
	CANCELLED: "Cancelled or deleted job",
	UNFINISHED: "Unfinished job"
};

function httpError(statusCode, code, message) {
	return Object.assign(new Error(message), { statusCode, code });
}

function monthsBefore(ymd, months) {
	const date = new Date(`${ymd}T00:00:00Z`);
	date.setUTCMonth(date.getUTCMonth() - months);
	return date.toISOString().slice(0, 10);
}

function idSet(values) {
	return new Set((Array.isArray(values) ? values : []).map(Number).filter((n) => Number.isInteger(n) && n > 0));
}

function readPlanOptions(input, cutoverDate) {
	const keepFrom = input.keepFrom == null || input.keepFrom === "" ? monthsBefore(cutoverDate, KEEP_MONTHS) : String(input.keepFrom);
	if (!openingStock.isYmd(keepFrom)) throw httpError(400, "invalid_date", "Enter the keep-from date as YYYY-MM-DD.");
	return { keepFrom, keepJobs: idSet(input.keepJobs), writeOffJobs: idSet(input.writeOffJobs) };
}

/** Each job's WIP balance at the cut-over (job 0: lines without a job), with what decides its fate. */
async function readJobWip(schema, wipAccnr, cutoverDate, queryFn = query) {
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
		   WHERE h.status = 'POSTED' AND l.accnr = ? AND h.trxdate <= ?
		   GROUP BY COALESCE(l.job_number, 0)
		   HAVING ABS(SUM(l.debit - l.credit)) >= 0.005
		 ) w
		 LEFT JOIN ${s}.job_information j ON w.job_number > 0 AND j.job_number = w.job_number
		 ORDER BY w.wip DESC, w.job_number`,
		[...issued, wipAccnr, cutoverDate]
	);
}

/**
 * Writes off every job's WIP except an unfinished job's (in the tenant, not
 * invoiced, not cancelled; quotes included). That stays when the opening stock
 * counts on it (openJobs) or it moved on or after keepFrom, unless the user
 * ticked it either way. The opening stock's jobs cannot be written off.
 */
function classifyJobs(rows, { keepFrom, keepJobs = new Set(), writeOffJobs = new Set() }, openJobs = new Set()) {
	return rows.map((row) => {
		const job = Number(row.job_number) || 0;
		const status = String(row.status || "");
		const reason = !job ? "NO_JOB"
			: !Number(row.in_tenant) ? "NOT_IN_TENANT"
				: Number(row.invoiced) ? "INVOICED"
					: CANCELLED_JOB_STATUSES.includes(status) ? "CANCELLED" : "UNFINISHED";
		const base = { job_number: job, wip: round2(row.wip), last_moved: row.last_moved || null, status, reason };
		if (reason !== "UNFINISHED") return { ...base, writeOff: true, locked: false, recent: false };
		const locked = openJobs.has(job);
		const recent = String(row.last_moved || "") >= keepFrom;
		return { ...base, writeOff: !locked && (writeOffJobs.has(job) || (!keepJobs.has(job) && !recent)), locked, recent };
	});
}

/** One WIP line per written-off job, against the Opening Stock control. */
function buildJournalLines(jobs, { wipAccnr, openingAccnr }) {
	const lines = jobs.filter((job) => job.writeOff).map((job) => ({
		accnr: wipAccnr,
		debit: job.wip < 0 ? -job.wip : 0,
		credit: job.wip > 0 ? job.wip : 0,
		job_number: job.job_number || null,
		ref1: `WIP write-off: ${REASONS[job.reason]}`
	}));
	const total = round2(lines.reduce((sum, line) => sum + line.credit - line.debit, 0));
	if (Math.abs(total) >= 0.005) {
		lines.push({ accnr: openingAccnr, debit: total > 0 ? total : 0, credit: total < 0 ? -total : 0, ref1: "WIP write-off" });
	}
	return lines;
}

function summarize(jobs) {
	return { jobs: jobs.length, value: round2(jobs.reduce((sum, job) => sum + job.wip, 0)) };
}

async function readAccountBalance(schema, accnr, asAt, queryFn = query) {
	const [row] = await queryFn(
		`SELECT ROUND(COALESCE(SUM(l.debit - l.credit), 0), 2) AS balance
		 FROM \`${schema}\`.gl_journal_headers h JOIN \`${schema}\`.gl_journal_lines l ON l.header_id = h.id
		 WHERE h.status = 'POSTED' AND l.accnr = ? AND h.trxdate <= ?`,
		[accnr, asAt]
	);
	return Number(row.balance) || 0;
}

/** Everything the post would do, worked out from the tenant. */
async function buildPlan(schema, context, input, queryFn = query) {
	const controls = openingStock.controlAccnrs(context.controlsByKey);
	// The opening stock's date when it is posted: both steps belong to the same cut-over.
	const defaultCutover = context.openingStockDate || context.defaultCutover;
	const cutoverDate = input.cutoverDate == null || input.cutoverDate === "" ? defaultCutover : String(input.cutoverDate);
	if (!openingStock.isYmd(cutoverDate)) throw httpError(400, "invalid_date", "Enter the cut-over date as YYYY-MM-DD.");
	const options = readPlanOptions(input, cutoverDate);

	const blockers = [];
	const warnings = [];
	if (!controls.WIP) blockers.push("Map the WIP control account in the Tenant Check.");
	if (!controls.OPENING_STOCK) blockers.push("Map the Opening Stock control account to an Equity account in the Tenant Check.");
	try {
		await getOpenPeriodId(schema, cutoverDate, queryFn);
	} catch (err) {
		blockers.push(err.code === "PERIOD_CLOSED" ? `The GL period for ${cutoverDate} is closed.` : `No GL period covers ${cutoverDate}.`);
	}
	if (!context.backfill) warnings.push("No live GL backfill has run. Run it first: the write-off clears the WIP the backfill leaves.");
	if (context.openingStockDate && context.openingStockDate !== cutoverDate) {
		warnings.push(`The opening stock was posted on ${context.openingStockDate}. Use the same cut-over date.`);
	}

	let jobs = [];
	let wipBalance = 0;
	if (controls.WIP) {
		const rows = await readJobWip(schema, controls.WIP, cutoverDate, queryFn);
		jobs = classifyJobs(rows, options, await openingStock.readOpenJobNumbers(schema, queryFn));
		wipBalance = round2(rows.reduce((sum, row) => sum + Number(row.wip), 0));
	}
	const journalLines = controls.WIP && controls.OPENING_STOCK
		? buildJournalLines(jobs, { wipAccnr: controls.WIP, openingAccnr: controls.OPENING_STOCK })
		: [];
	if (controls.WIP && !journalLines.length) blockers.push(`Nothing to write off: every job's WIP at ${cutoverDate} is kept.`);
	return { controls, cutoverDate, defaultCutover, options, jobs, wipBalance, journalLines, blockers, warnings };
}

function journalByAccount(lines, names) {
	const byAccount = new Map();
	for (const line of lines) {
		const row = byAccount.get(line.accnr) || { accnr: line.accnr, name: names.get(line.accnr) || null, debit: 0, credit: 0 };
		row.debit = round2(row.debit + line.debit);
		row.credit = round2(row.credit + line.credit);
		byAccount.set(line.accnr, row);
	}
	return [...byAccount.values()].sort((a, b) => a.accnr - b.accnr);
}

async function readPostedJournal(schema, queryFn = query, forUpdate = false) {
	const [journal] = await queryFn(
		`SELECT h.id, h.source_id, DATE_FORMAT(h.trxdate, '%Y-%m-%d') AS trxdate, p.status AS period_status
		 FROM \`${schema}\`.gl_journal_headers h LEFT JOIN \`${schema}\`.gl_periods p ON p.id = h.period_id
		 WHERE h.source = ? ORDER BY h.id DESC LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
		[JOURNAL_SOURCE]
	);
	return journal || null;
}

async function readPostedState(schema, journal, controls) {
	const [totals] = await query(
		`SELECT COUNT(*) AS jobs, ROUND(COALESCE(SUM(credit - debit), 0), 2) AS value
		 FROM \`${schema}\`.gl_journal_lines WHERE header_id = ? AND accnr = ?`,
		[journal.id, controls.WIP || 0]
	);
	const undoBlockers = journal.period_status === "OPEN" ? [] : [`The GL period of ${journal.trxdate} is closed.`];
	return {
		journalId: Number(journal.id), sourceId: journal.source_id, trxdate: journal.trxdate,
		jobs: Number(totals.jobs), value: Number(totals.value),
		wipAtCutover: controls.WIP ? await readAccountBalance(schema, controls.WIP, journal.trxdate) : null,
		wipNow: controls.WIP ? await readAccountBalance(schema, controls.WIP, "9999-12-31") : null,
		canUndo: undoBlockers.length === 0, undoBlockers
	};
}

/** Read-only: the WIP write-off Migrate would post, or the one it posted. */
async function readWipWriteOff({ schema, input = {} }) {
	const context = await openingStock.readCutoverContext(schema);
	const missingTables = REQUIRED_TABLES.filter((table) => !context.tables.has(table));
	if (missingTables.length) return { schema, missingTables };
	const controls = openingStock.controlAccnrs(context.controlsByKey);
	const journal = await readPostedJournal(schema);
	if (journal) return { schema, missingTables, posted: await readPostedState(schema, journal, controls), backfill: context.backfill };

	const built = await buildPlan(schema, context, input);
	const accnrs = [controls.WIP, controls.OPENING_STOCK].filter(Boolean);
	const names = new Map(accnrs.length
		? (await query(`SELECT accnr, name FROM \`${schema}\`.gl_accounts WHERE accnr IN (?)`, [accnrs])).map((row) => [Number(row.accnr), row.name])
		: []);
	const control = (key) => {
		const row = context.controlsByKey[key];
		return row ? { accnr: row.accnr, name: row.name, status: row.status, reason: row.reason } : null;
	};
	const writtenOff = built.jobs.filter((job) => job.writeOff);
	const kept = built.jobs.filter((job) => !job.writeOff);
	const byReason = Object.fromEntries(Object.keys(REASONS).map((reason) => [reason, summarize(writtenOff.filter((job) => job.reason === reason))]));
	return {
		schema, missingTables, posted: null, backfill: context.backfill,
		cutoverDate: built.cutoverDate, defaultCutover: built.defaultCutover, openingStockDate: context.openingStockDate,
		keepFrom: built.options.keepFrom, keepMonths: KEEP_MONTHS,
		controls: { wip: control("WIP"), opening: control("OPENING_STOCK") },
		summary: {
			wipBalance: built.wipBalance, writtenOff: summarize(writtenOff), kept: summarize(kept), byReason,
			wipAfter: round2(built.wipBalance - summarize(writtenOff).value)
		},
		reasons: REASONS,
		journal: journalByAccount(built.journalLines, names),
		jobs: built.jobs,
		blockers: built.blockers, warnings: built.warnings, canPost: built.blockers.length === 0
	};
}

/** Posts the write-off in one transaction. */
async function postWipWriteOff({ schema, input = {}, staffId = 0 }) {
	const context = await openingStock.readCutoverContext(schema);
	const missing = REQUIRED_TABLES.filter((table) => !context.tables.has(table));
	if (missing.length) throw httpError(409, "missing_tables", `Missing ${missing.join(", ")}.`);
	const tx = await companyTransaction();
	try {
		if (await readPostedJournal(schema, tx.query, true)) throw httpError(409, "already_posted", "The WIP write-off has already been posted. Undo it first to post it again.");
		const built = await buildPlan(schema, context, input, tx.query);
		if (built.blockers.length) throw httpError(409, "not_ready", built.blockers.join(" "));
		const { cutoverDate, controls } = built;
		const sourceId = `WO-${cutoverDate}`;
		const posted = await postJournal({
			schema, source: JOURNAL_SOURCE, sourceId, trxdate: cutoverDate,
			description: `WIP write-off ${cutoverDate} (Autoneer-Migrate)`, lines: built.journalLines, userId: staffId, queryFn: tx.query
		});
		if (posted.status !== "posted") throw httpError(409, "journal_exists", `A ${JOURNAL_SOURCE} journal ${sourceId} already exists.`);

		const writtenOff = summarize(built.jobs.filter((job) => job.writeOff));
		const expected = round2(built.wipBalance - writtenOff.value);
		const after = await readAccountBalance(schema, controls.WIP, cutoverDate, tx.query);
		if (Math.abs(after - expected) > 0.009) throw new Error(`WIP at ${cutoverDate} would be ${after.toFixed(2)}, not ${expected.toFixed(2)}. Nothing was posted.`);

		await tx.commit();
		return { journalId: posted.id, sourceId, cutoverDate, jobs: writtenOff.jobs, value: writtenOff.value, wipAtCutover: after };
	} catch (err) {
		await tx.rollback();
		throw err;
	}
}

/** Deletes the write-off journal while its period is open. */
async function undoWipWriteOff({ schema }) {
	const tx = await companyTransaction();
	try {
		const journal = await readPostedJournal(schema, tx.query, true);
		if (!journal) throw httpError(404, "not_posted", "There is no WIP write-off to undo.");
		if (journal.period_status !== "OPEN") throw httpError(409, "period_closed", `The GL period of ${journal.trxdate} is closed.`);
		const deleted = await deleteGlJournalBySource(schema, JOURNAL_SOURCE, journal.source_id, tx.query);
		await tx.commit();
		return { trxdate: journal.trxdate, journalDeleted: deleted.deleted };
	} catch (err) {
		await tx.rollback();
		throw err;
	}
}

/** The date of the WIP write-off Migrate posted, or null. */
async function readWipWriteOffDate(schema) {
	const journal = await readPostedJournal(schema);
	return journal ? journal.trxdate : null;
}

module.exports = {
	JOURNAL_SOURCE,
	readWipWriteOff,
	postWipWriteOff,
	undoWipWriteOff,
	readWipWriteOffDate,
	classifyJobs,
	buildJournalLines
};
