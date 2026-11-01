"use strict";

// Posts GL journals for imported documents with the GL backfill mirrored from
// AUTONEER-PWA (mirror/, kept in step by mirrorSync.js). The run guards follow
// the PWA's POST /accounting/gl-backfill/run. readScope is Migrate's own
// preflight and only reads.

const mysql = require("mysql2/promise");
const { withPool, query, companyTransaction } = require("./mirror/database/database");
const controlAccounts = require("./controlAccounts");
const openingStock = require("./openingStock");
const glBackfill = require("./mirror/lib/finance/glBackfill");
const { clearControlAccountCache } = require("./mirror/lib/finance/postingEngine");
const { flushStockGlCache } = require("./mirror/lib/finance/stockGlResolver");

const TYPES = glBackfill.BACKFILL_TYPE_ORDER;
// Migrate has no staff session; the PWA records 0 in the same case.
const STAFF_ID = 0;
const COOLDOWN_MINUTES = 10;

const REQUIRED_TABLES = [
	"gl_account_types", "gl_accounts", "gl_periods", "gl_journal_headers", "gl_journal_lines",
	"gl_control_accounts", "tax_codes", "gl_backfill_runs", "gl_backfill_run_items",
	"invoices", "invoices_supplier", "invoice_items", "invoice_general", "customer_invoice_lines",
	"invoice_adjustments", "spares_used", "work_done", "payments", "job_information", "stock",
	"customers", "suppliers", "company_prefferences", "manual_journal_headers", "manual_journal_lines"
];
// Read by the backfill without a fallback.
const REQUIRED_COLUMNS = [
	["invoices", "is_split_invoice"], ["invoices", "is_historical_import"], ["invoices_supplier", "voided_at"],
	["spares_used", "is_excluded_from_quote"], ["spares_used", "excluded_stock_returned"], ["work_done", "is_excluded_from_quote"]
];
const DOCUMENT_DATES = {
	CREDITOR_INVOICE: ["invoices_supplier", "inv_date"],
	REBUILD_STOCK: ["stock_rebuild_jobs", "completed_at"],
	DEBTOR_INVOICE: ["invoices", "invoice_date"],
	DEBTOR_PAYMENT: ["payments", "paydate"],
	CREDITOR_PAYMENT: ["payments_suppliers", "paydate"]
};

const activeRuns = new Map();
// Repair tasks in progress, by tenant: what is running, for the busy message.
const activeTasks = new Map();

function httpError(statusCode, code, message) {
	return Object.assign(new Error(message), { statusCode, code });
}

function flag(value) {
	return value === true || ["1", "true", "yes"].includes(String(value).toLowerCase());
}

function assertSchemaName(schema) {
	if (!/^[A-Za-z0-9_]+$/.test(String(schema || ""))) throw httpError(400, "invalid_schema", "Select a target schema first.");
}

function createPool(config, schema, connectionLimit = 5) {
	// Same driver options as the PWA pool: one statement per query.
	return mysql.createPool({
		host: config.host,
		port: Number(config.port || 3306),
		user: config.user,
		password: config.password,
		database: schema,
		waitForConnections: true,
		connectionLimit
	});
}

async function withSchema(config, schema, work, connectionLimit = 5) {
	assertSchemaName(schema);
	const pool = createPool(config, schema, connectionLimit);
	try {
		return await withPool(pool, work);
	} finally {
		await pool.end().catch(() => {});
	}
}

function runKey(config, schema) {
	return `${config.host}:${config.port || 3306}/${schema}`;
}

// One writer per tenant: a backfill run, a repair task or a control account fix.
function assertIdle(config, schema) {
	const key = runKey(config, schema);
	if (activeRuns.has(key)) throw httpError(409, "run_in_progress", `A GL backfill is still running for ${schema}. Wait for it to finish.`);
	if (activeTasks.has(key)) throw httpError(409, "task_in_progress", `Wait for ${activeTasks.get(key)} to finish.`);
	return key;
}

async function runTask(config, schema, label, work, connectionLimit = 5) {
	assertSchemaName(schema);
	const key = assertIdle(config, schema);
	activeTasks.set(key, label);
	try {
		return await withSchema(config, schema, work, connectionLimit);
	} finally {
		activeTasks.delete(key);
	}
}

/** Read-only: whether the tenant can run the backfill, and what it would cover. */
async function readScope(config, schema) {
	return withSchema(config, schema, async () => {
		const tableRows = await query(
			"SELECT LOWER(table_name) AS name FROM information_schema.tables WHERE table_schema = ?",
			[schema]
		);
		const tables = new Set(tableRows.map((row) => row.name));
		const columnRows = await query(
			"SELECT LOWER(table_name) AS t, LOWER(column_name) AS c FROM information_schema.columns WHERE table_schema = ?",
			[schema]
		);
		const columns = new Set(columnRows.map((row) => `${row.t}.${row.c}`));
		const missingTables = REQUIRED_TABLES.filter((table) => !tables.has(table));
		const missingColumns = REQUIRED_COLUMNS
			.filter(([table, column]) => tables.has(table) && !columns.has(`${table}.${column}`))
			.map(([table, column]) => `${table}.${column}`);

		const skippedTypes = {};
		if (!tables.has("stock_rebuild_jobs") || !tables.has("stock_listed_units")) skippedTypes.REBUILD_STOCK = "stock_rebuild_jobs is missing";
		if (!tables.has("payments_suppliers")) skippedTypes.CREDITOR_PAYMENT = "payments_suppliers is missing";

		const dates = {};
		for (const type of TYPES) {
			const [table, column] = DOCUMENT_DATES[type];
			if (!tables.has(table) || !columns.has(`${table}.${column}`)) continue;
			const [row] = await query(
				`SELECT COUNT(${column}) AS dated, DATE_FORMAT(MIN(${column}), '%Y-%m-%d') AS first, DATE_FORMAT(MAX(${column}), '%Y-%m-%d') AS last FROM \`${schema}\`.${table}`
			);
			// Rows in the table, not documents the backfill will post; a dry run gives those.
			dates[type] = { rows: Number(row.dated), from: row.first, to: row.last };
		}
		const known = Object.values(dates).filter((d) => d.from);
		const from = known.length ? known.map((d) => d.from).sort()[0] : null;
		const to = known.length ? known.map((d) => d.to).sort().pop() : null;

		const ready = missingTables.length === 0 && missingColumns.length === 0;
		if (!ready) return { schema, ready, missingTables, missingColumns, skippedTypes, dates, from, to };

		const controls = await controlAccounts.readControls(query, schema);
		const closedPeriods = await query(
			`SELECT fiscal_year, period_no, DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date, DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date
			 FROM \`${schema}\`.gl_periods WHERE status = 'CLOSED' ORDER BY start_date`
		);
		// RFC-ORIGINAL invoices without a '-RFC' return to pair with (paired the way
		// migrateLegacyRfcs pairs). The RFC migration never selects them and the
		// backfill posts only DONE, POSTED and CREDIT invoices, so each needs a decision.
		const unpairedRfcOriginals = (await query(
			`SELECT o.sinvid, o.suppid, sup.supplier AS supplier_name, o.invoice_nr, DATE_FORMAT(o.inv_date, '%Y-%m-%d') AS inv_date,
			        o.amount, o.rfcamount,
			        (SELECT GROUP_CONCAT(r.invoice_nr ORDER BY r.invoice_nr SEPARATOR ', ') FROM \`${schema}\`.invoices_supplier r
			         WHERE r.suppid = o.suppid AND r.sinvid <> o.sinvid AND r.invoice_nr LIKE '%-RFC'
			           AND r.invoice_nr LIKE CONCAT(o.invoice_nr, '%')) AS similar_returns
			 FROM \`${schema}\`.invoices_supplier o
			 LEFT JOIN \`${schema}\`.suppliers sup ON sup.suppid = o.suppid
			 WHERE o.status = 'RFC-ORIGINAL'
			   AND NOT EXISTS (
			     SELECT 1 FROM \`${schema}\`.invoices_supplier r
			     WHERE r.suppid = o.suppid AND r.invoice_nr LIKE '%-RFC' AND r.status IN ('RFC-DONE', 'POSTED')
			       AND REPLACE(r.invoice_nr, '-RFC', '') = o.invoice_nr
			   )
			 ORDER BY o.inv_date, o.sinvid
			 LIMIT 200`
		)).map((row) => ({
			sinvid: Number(row.sinvid), supplier: row.supplier_name || `Supplier ${row.suppid}`, invoiceNr: row.invoice_nr,
			date: row.inv_date, amount: Number(row.amount), returnRecorded: Math.abs(Number(row.rfcamount || 0)), similarReturns: row.similar_returns
		}));
		const journals = await query(
			`SELECT source, COUNT(*) AS headers FROM \`${schema}\`.gl_journal_headers GROUP BY source ORDER BY source`
		);
		const [latestRun] = await query(
			`SELECT id, status, dry_run, DATE_FORMAT(from_date, '%Y-%m-%d') AS from_date, DATE_FORMAT(to_date, '%Y-%m-%d') AS to_date, started_at, finished_at
			 FROM \`${schema}\`.gl_backfill_runs ORDER BY id DESC LIMIT 1`
		);
		return {
			schema, ready, missingTables, missingColumns, skippedTypes, dates, from, to, controls, closedPeriods, unpairedRfcOriginals,
			journals: journals.map((row) => ({ source: row.source, headers: Number(row.headers) })),
			latestRun: latestRun ? { ...latestRun, active: activeRuns.get(runKey(config, schema)) === latestRun.id } : null
		};
	});
}

function isYmd(value) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
	const date = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function readRunOptions(input = {}) {
	const requested = (Array.isArray(input.types) ? input.types : input.types ? [input.types] : []).map((t) => String(t).toUpperCase());
	const types = TYPES.filter((type) => requested.includes(type));
	if (!isYmd(input.fromDate) || !isYmd(input.toDate) || input.fromDate > input.toDate) {
		throw httpError(400, "invalid_params", "Enter a valid date range, with the start date on or before the end date.");
	}
	if (types.length === 0 || requested.some((type) => !TYPES.includes(type))) {
		throw httpError(400, "invalid_params", `Choose one or more document types from ${TYPES.join(", ")}.`);
	}
	const options = {
		fromDate: input.fromDate,
		toDate: input.toDate,
		types,
		dryRun: flag(input.dryRun),
		clearPrevious: flag(input.clearPrevious),
		confirm: flag(input.confirm)
	};
	if (options.dryRun && options.clearPrevious) {
		throw httpError(400, "invalid_params", "Clearing previous postings is only allowed for a live run.");
	}
	if (!options.dryRun && !options.confirm) {
		throw httpError(400, "confirmation_required", "A live run needs explicit confirmation.");
	}
	return options;
}

// The PWA route's guards for a live run, then the run row.
//
// createRun stores started_at in UTC, so the guards compare with UTC_TIMESTAMP().
// The PWA route compares with NOW(); on a server east of UTC every run then looks
// hours old, so it fails a live run as stale and never applies the cooldown.
async function prepareRun(schema, options, backfill) {
	if (!options.dryRun) {
		await query(`UPDATE ${schema}.gl_backfill_runs SET status = 'FAILED', finished_at = UTC_TIMESTAMP() WHERE status = 'RUNNING' AND started_at < UTC_TIMESTAMP() - INTERVAL 30 MINUTE`).catch(() => {});
		const [running] = await query(`SELECT COUNT(*) AS cnt FROM ${schema}.gl_backfill_runs WHERE status = 'RUNNING'`);
		if (Number(running.cnt) > 0) {
			throw httpError(409, "run_in_progress", "A backfill on this tenant is still marked as running. Wait for it to finish; " +
				"a run that stopped when Migrate restarted is cleared 30 minutes after it started.");
		}
		const [last] = await query(`SELECT TIMESTAMPDIFF(SECOND, started_at, UTC_TIMESTAMP()) AS age_seconds FROM ${schema}.gl_backfill_runs WHERE started_by_staff_id = ? AND dry_run = 0 ORDER BY started_at DESC LIMIT 1`, [STAFF_ID]);
		if (last && last.age_seconds != null && Number(last.age_seconds) < COOLDOWN_MINUTES * 60) {
			const waitSeconds = COOLDOWN_MINUTES * 60 - Number(last.age_seconds);
			throw httpError(429, "rate_limited", `Please wait ${waitSeconds} seconds before starting another live run.`);
		}
		// The opening stock journal reversed the Inventory balance the backfill had
		// left by its date; posting more on or before that date would undo it.
		const openingDate = await openingStock.readOpeningStockDate(schema);
		if (openingDate && options.fromDate <= openingDate) {
			throw httpError(409, "opening_stock_posted", `The opening stock take was posted on ${openingDate}. ` +
				"Undo it before a live backfill on or before that date, then post it again.");
		}
	}
	// Rebuild GL Accounts can change the chart in this process.
	clearControlAccountCache(schema);
	flushStockGlCache();
	const base = { companyDb: schema, schema, fromDate: options.fromDate, toDate: options.toDate, types: options.types };
	const cleared = options.clearPrevious ? await backfill.clearPreviousBackfillScope(base) : null;
	const runId = await backfill.createRun({ ...base, staffId: STAFF_ID, dryRun: options.dryRun });
	return { runId, cleared };
}

/**
 * Starts a run and returns once it is recorded. The run itself continues in the
 * background on its own pool; poll readRunStatus for progress.
 */
async function startRun(config, schema, input, { backfill = glBackfill, openPool = createPool } = {}) {
	assertSchemaName(schema);
	const options = readRunOptions(input);
	const key = assertIdle(config, schema);
	activeRuns.set(key, null);
	const pool = openPool(config, schema);
	let runId = null;
	try {
		const prepared = await withPool(pool, () => prepareRun(schema, options, backfill));
		runId = prepared.runId;
		activeRuns.set(key, runId);
		setImmediate(() => {
			withPool(pool, () => backfill.runBackfillJob({
				companyDb: schema, schema, runId, fromDate: options.fromDate, toDate: options.toDate,
				types: options.types, dryRun: options.dryRun, staffId: STAFF_ID
			})).finally(async () => {
				activeRuns.delete(key);
				await pool.end().catch(() => {});
			});
		});
		return { runId, cleared: prepared.cleared, dryRun: options.dryRun, types: options.types };
	} finally {
		if (runId == null) {
			activeRuns.delete(key);
			await pool.end().catch(() => {});
		}
	}
}

async function readRunStatus(config, schema, runId, { itemStatuses, itemLimit } = {}) {
	const id = Number(runId);
	if (!Number.isSafeInteger(id) || id <= 0) throw httpError(400, "invalid_run", "Unknown GL backfill run.");
	const status = await withSchema(config, schema, () => glBackfill.getRunStatus({ companyDb: schema, schema, runId: id, itemStatuses, itemLimit }));
	if (!status.run) throw httpError(404, "invalid_run", `GL backfill run ${id} was not found in ${schema}.`);
	// The job keeps working after DONE while it resyncs customer and supplier balances.
	const active = activeRuns.get(runKey(config, schema)) === id;
	// A run executes inside the Migrate process that started it. RUNNING without
	// that process means it stopped, for example when Migrate restarted.
	return { ...status, active, stopped: status.run.status === "RUNNING" && !active };
}

/** Read-only: the ways one control account can be fixed. */
async function readControlFix(config, schema, key) {
	return withSchema(config, schema, () => controlAccounts.readFixOptions(query, schema, String(key || "").toUpperCase()));
}

/** Applies one control account fix in a single transaction. */
async function applyControlFix(config, schema, key, choice) {
	return runTask(config, schema, "a control account fix", async () => {
		const tx = await companyTransaction();
		try {
			const applied = await controlAccounts.applyFix(tx.query, schema, String(key || "").toUpperCase(), choice);
			await tx.commit();
			clearControlAccountCache(schema);
			return { applied };
		} catch (err) {
			await tx.rollback();
			throw err;
		}
	});
}

// Phase 2: the repair tools from the PWA's Accounting Backfill page. Each wraps
// the mirrored function with the limits and defaults of its PWA route.

const RFC_TABLES = ["invoices_supplier", "invoice_items", "orders", "supplier_rfc_headers", "supplier_rfc_lines"];

/** Read-only: what each repair would work on. */
async function readRepairScope(config, schema) {
	return withSchema(config, schema, async () => {
		const s = `\`${schema}\``;
		const tableRows = await query("SELECT LOWER(table_name) AS name FROM information_schema.tables WHERE table_schema = ?", [schema]);
		const tables = new Set(tableRows.map((row) => row.name));
		const missing = (names) => names.filter((name) => !tables.has(name));

		let rfc = { missing: missing(RFC_TABLES) };
		if (!rfc.missing.length) {
			// The pairs migrateLegacyRfcs selects, without its limit.
			const [pairs] = await query(
				`SELECT COUNT(*) AS pairs, ROUND(COALESCE(SUM(ABS(rfc.amount)), 0), 2) AS returns_total
				 FROM ${s}.invoices_supplier rfc
				 JOIN ${s}.invoices_supplier orig
				   ON orig.suppid = rfc.suppid
				  AND orig.invoice_nr = REPLACE(rfc.invoice_nr, '-RFC', '')
				  AND orig.status IN ('RFC-ORIGINAL', 'POSTED')
				 LEFT JOIN ${s}.supplier_rfc_headers h ON h.original_sinvid = orig.sinvid
				 WHERE rfc.invoice_nr LIKE '%-RFC'
				   AND rfc.status IN ('RFC-DONE', 'POSTED')
				   AND h.rfc_id IS NULL
				   AND (
				     orig.status = 'RFC-ORIGINAL'
				     OR ABS(COALESCE(rfc.amount, 0)) > 0.01
				     OR EXISTS (
				       SELECT 1 FROM ${s}.invoice_items rfc_line
				       WHERE rfc_line.invoice_nr = rfc.invoice_nr AND rfc_line.suppid = rfc.suppid
				         AND COALESCE(rfc_line.quantity, 0) <> 0
				         AND ABS(COALESCE(rfc_line.amountexvat, 0)) + ABS(COALESCE(rfc_line.vat, 0)) > 0.01
				     )
				   )`
			);
			const [migrated] = await query(`SELECT COUNT(*) AS n FROM ${s}.supplier_rfc_headers WHERE reason = 'LEGACY_MIGRATION'`);
			rfc = { missing: [], pairs: Number(pairs.pairs), returnsTotal: Number(pairs.returns_total), migrated: Number(migrated.n) };
		}

		// An invoice number that is not a plain number is kept in ref2 instead of invoice_nr; that line is not missing it.
		const [refs] = await query(
			`SELECT COUNT(DISTINCT h.id) AS n FROM ${s}.gl_journal_headers h JOIN ${s}.gl_journal_lines l ON l.header_id = h.id
			 WHERE h.source IN ('CREDITOR_INVOICE', 'SUPPLIER_INVOICE') AND (l.suppid IS NULL OR (l.invoice_nr IS NULL AND l.ref2 IS NULL))`
		);
		const [legacyRfcJournals] = await query(`SELECT COUNT(*) AS n FROM ${s}.gl_journal_headers WHERE source = 'CREDITOR_RFC' AND source_id LIKE '%-RFC'`);
		const [journals] = await query(`SELECT COUNT(*) AS n FROM ${s}.gl_journal_headers`);

		const general = { missing: missing(["invoice_general", "suppliers"]), suppliers: [], accounts: [] };
		if (!general.missing.length) {
			general.suppliers = (await glBackfill.getGeneralInvoicesWithoutGlLines({ companyDb: schema, schema })).map((row) => ({
				suppid: Number(row.suppid), name: row.supplier_name, invoices: Number(row.invoice_count), total: Number(row.total_amount || 0)
			}));
			general.accounts = (await query(
				`SELECT a.accnr, a.name, UPPER(t.code) AS type FROM ${s}.gl_accounts a
				 LEFT JOIN ${s}.gl_account_types t ON t.id = a.type_id WHERE a.active = 1 ORDER BY a.accnr`
			)).map((row) => ({ accnr: Number(row.accnr), name: row.name, type: row.type }));
		}

		const [history] = await query(`SELECT (SELECT COUNT(*) FROM ${s}.gl_backfill_runs) AS runs, (SELECT COUNT(*) FROM ${s}.gl_backfill_run_items) AS items`);
		return {
			schema,
			busy: activeRuns.has(runKey(config, schema)) || activeTasks.has(runKey(config, schema)),
			rfc,
			repair: { journals: Number(journals.n), journalsMissingRefs: Number(refs.n), legacyRfcJournals: Number(legacyRfcJournals.n) },
			general,
			history: { runs: Number(history.runs), items: Number(history.items) }
		};
	});
}

/** POST /accounting/gl-backfill/migrate-legacy-rfcs */
async function migrateLegacyRfcs(config, schema, input = {}, onProgress = null) {
	const limit = Math.max(1, Math.min(5000, Number(input.limit) || 500));
	const dryRun = flag(input.dryRun);
	if (!dryRun && !flag(input.confirm)) throw httpError(400, "confirmation_required", "A live RFC migration needs explicit confirmation.");
	return runTask(config, schema, "the legacy RFC migration", async () => {
		const result = await glBackfill.migrateLegacyRfcs({
			companyDb: schema, schema, staffId: STAFF_ID, limit, dryRun,
			parkLegacyRfcRow: flag(input.parkLegacyRfcRow),
			rewriteGlSourceId: input.rewriteGlSourceId !== false && String(input.rewriteGlSourceId) !== "false",
			onProgress: onProgress && ((p) => onProgress({ processed: p.processed, total: p.of }))
		});
		return { dryRun, ...result };
	});
}

/** POST /accounting/gl-backfill/post-repair. Filling missing supplier references always writes, as in the PWA. */
async function postBackfillRepair(config, schema, input = {}, onProgress = null) {
	const limit = Math.max(1, Number(input.limit) || 1000);
	const dryRun = flag(input.dryRun);
	if (!flag(input.confirm)) throw httpError(400, "confirmation_required", "The post-backfill repair needs explicit confirmation.");
	return runTask(config, schema, "the post-backfill repair", async () => {
		const refs = await glBackfill.backfillSupplierRefs({
			companyDb: schema, schema, limit,
			onProgress: onProgress && ((p) => onProgress({ phase: "refs", processed: p.processed, total: p.total }))
		});
		const rewrite = await glBackfill.rewriteLegacyRfcGlSourceIds({
			companyDb: schema, schema, dryRun,
			onProgress: onProgress && ((p) => onProgress({ phase: "rfc", processed: p.processed, total: p.total }))
		});
		return { dryRun, refs, rewrite };
	});
}

/** POST /accounting/gl-backfill/general-gl-lines */
async function assignGeneralInvoiceAccounts(config, schema, input = {}, onProgress = null) {
	const accnr = Number(input.accnr);
	if (!Number.isSafeInteger(accnr) || accnr <= 0) throw httpError(400, "invalid_account", "Choose the GL account to assign.");
	const suppid = input.suppid ? Number(input.suppid) : null;
	if (suppid !== null && (!Number.isSafeInteger(suppid) || suppid <= 0)) throw httpError(400, "invalid_supplier", "Unknown supplier.");
	const description = input.description ? String(input.description).trim() || null : null;
	const dryRun = flag(input.dryRun);
	if (!dryRun && !flag(input.confirm)) throw httpError(400, "confirmation_required", "Assigning accounts needs explicit confirmation.");
	return runTask(config, schema, "assigning general invoice accounts", async () => {
		const result = await glBackfill.backfillGeneralInvoiceGlLines({
			companyDb: schema, schema, accnr, description, suppid, dryRun, staffId: STAFF_ID,
			onProgress: onProgress && ((p) => onProgress({ processed: p.processed, total: p.total }))
		});
		return { dryRun, accnr, ...result };
	});
}

// The migration opening stock take (openingStock.js). Migrate's own step; the
// PWA has no route for it.

/** Read-only: the opening stock take Migrate would post, or the one it posted. */
async function readOpeningStock(config, schema, firebirdConfig, input = {}) {
	return withSchema(config, schema, async () => ({
		busy: activeRuns.has(runKey(config, schema)) || activeTasks.has(runKey(config, schema)),
		...await openingStock.readOpeningStock({ schema, firebirdConfig, input })
	}));
}

async function postOpeningStock(config, schema, firebirdConfig, input = {}, onProgress = null) {
	if (!flag(input.confirm)) throw httpError(400, "confirmation_required", "Posting the opening stock needs explicit confirmation.");
	return runTask(config, schema, "the opening stock take", () => openingStock.postOpeningStock({
		schema, firebirdConfig, input, staffId: STAFF_ID, onProgress: onProgress || undefined
	}));
}

async function undoOpeningStock(config, schema, input = {}) {
	if (!flag(input.confirm)) throw httpError(400, "confirmation_required", "Undoing the opening stock needs explicit confirmation.");
	return runTask(config, schema, "undoing the opening stock take", () => openingStock.undoOpeningStock({ schema }));
}

/** POST /accounting/gl-backfill/truncate: empties the run history. Journals are untouched. */
async function clearRunHistory(config, schema, input = {}) {
	if (!flag(input.confirm)) throw httpError(400, "confirmation_required", "Clearing the run history needs explicit confirmation.");
	// The PWA turns FOREIGN_KEY_CHECKS off and on around the truncates. Those are
	// connection settings, so the task gets a pool of exactly one connection.
	return runTask(config, schema, "clearing the run history", async () => ({
		truncated: await glBackfill.truncateGlBackfillTables(schema, schema)
	}), 1);
}

module.exports = {
	TYPES,
	readScope,
	readRunOptions,
	startRun,
	readRunStatus,
	readRepairScope,
	migrateLegacyRfcs,
	postBackfillRepair,
	assignGeneralInvoiceAccounts,
	clearRunHistory,
	readControlFix,
	applyControlFix,
	readOpeningStock,
	postOpeningStock,
	undoOpeningStock
};
