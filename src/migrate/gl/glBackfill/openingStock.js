"use strict";

// The migration opening stock take. Reads the legacy stock quantities and posts
// them the way AUTONEER-PWA finalises an opening stock import (routes/stock-
// takes.js, POST /api/sessions/:takedate/finalise): a FINALISED session and
// its lines, the stock quantities with tagged stock_movement_ledger rows, the
// adjust_stock gains and one STOCK_TAKE journal. That journal also carries the
// open-job stock and reverses the Inventory balance the backfill left, so the
// Inventory control equals the stock valuation at cut-over. The rules are in
// openingStockPlan.js. Every function runs inside withPool(), like the mirror.

const path = require("path");
const firebird = require("../../../db/firebird");
const { query, companyTransaction } = require("./mirror/database/database");
const { getOpenPeriodId, postJournal, deleteGlJournalBySource } = require("./mirror/lib/finance/postingEngine");
const { resolveStockGlAccounts } = require("./mirror/lib/finance/stockGlResolver");
const { buildDebtorInvoicePartCostLines, isDebtorInvoiceBackfillStatus } = require("./mirror/lib/finance/glBackfill");
const { costedLineSql, getJobWipDebitedTotal } = require("./mirror/services/finalise/finalise.service");
const { areExcludedLinesCosted } = require("./mirror/utils/printExcludedItems");
const controlAccounts = require("./controlAccounts");
const plan = require("./openingStockPlan");

const REQUIRED_TABLES = [
	"stock", "stock_take", "stock_takes", "adjust_stock", "stock_movement_ledger", "spares_used", "job_information",
	"invoices", "company_prefferences", "gl_accounts", "gl_account_types", "gl_control_accounts", "gl_periods",
	"gl_journal_headers", "gl_journal_lines"
];
// A job with an invoice in one of these states has been invoiced (glBackfill's DEBTOR_INVOICE_BACKFILL_STATUSES).
const ISSUED_INVOICE_STATUSES = ["PRINTED", "POSTED", "FINAL", "CREDIT"].filter(isDebtorInvoiceBackfillStatus);
const CLOSED_JOB_STATUSES = ["QUOTE", "CANCELLED", "DELETED"];
const LIST_LIMIT = 2000;
const INSERT_CHUNK = 500;
// Ends the notes of every stock_movement_ledger row Migrate writes.
const LEDGER_NOTE_SUFFIX = "(Autoneer-Migrate)";

function httpError(statusCode, code, message) {
	return Object.assign(new Error(message), { statusCode, code });
}

function isYmd(value) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
	const date = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function addDays(ymd, days) {
	const date = new Date(`${ymd}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
}

function todayYmd() {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

async function readTables(schema) {
	const rows = await query("SELECT LOWER(table_name) AS name FROM information_schema.tables WHERE table_schema = ?", [schema]);
	return new Set(rows.map((row) => row.name));
}

async function hasColumn(schema, table, column) {
	const rows = await query(
		"SELECT 1 AS ok FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ? LIMIT 1",
		[schema, table, column]
	);
	return rows.length > 0;
}

/** The legacy STOCK quantities that are not zero, keyed by legacy STOCK_ID. */
async function readLegacyQuantities(firebirdConfig) {
	const config = firebird.resolveFirebirdConfig(firebirdConfig);
	const problem = firebird.validateFirebirdConfig(config);
	if (problem) throw httpError(409, "legacy_unavailable", `Connect the legacy database on the Setup page first. ${problem}`);
	let db;
	try {
		db = await firebird.attachWithRetry(config);
	} catch (err) {
		throw httpError(409, "legacy_unavailable", `The legacy database could not be opened: ${err.message}`);
	}
	try {
		const columns = await firebird.queryWithDb(db, "SELECT TRIM(RDB$FIELD_NAME) AS name FROM RDB$RELATION_FIELDS WHERE RDB$RELATION_NAME = 'STOCK'");
		const names = new Set(columns.map((row) => String(row.name).trim().toUpperCase()));
		// Older legacy versions name the column QTY (mapping.default.json).
		const quantityColumn = ["QUANTITY", "QTY"].find((name) => names.has(name));
		if (!names.has("STOCK_ID") || !quantityColumn) {
			throw httpError(409, "legacy_stock_columns", "The legacy STOCK table has no STOCK_ID and QUANTITY columns.");
		}
		const rows = await firebird.queryWithDb(db, `SELECT STOCK_ID, ${quantityColumn} AS QTY FROM STOCK WHERE ${quantityColumn} <> 0`);
		const [total] = await firebird.queryWithDb(db, "SELECT COUNT(*) AS N FROM STOCK");
		const quantities = new Map();
		for (const row of rows) quantities.set(Number(row.stock_id), Number(row.qty) || 0);
		return { database: path.basename(String(config.database).replace(/\\/g, "/")), rows: Number(total.n), quantities, quantityColumn };
	} finally {
		db.detach();
	}
}

// Legacy STOCK_ID → target stock_id. The import preserves stock ids unless a
// plan generated new keys, in which case the latest run's id map has them.
async function readStockIdMap(schema, tables) {
	if (!tables.has("migration_id_map")) return { map: null, label: "preserved ids" };
	const [latest] = await query(`SELECT MAX(run_id) AS run_id FROM \`${schema}\`.migration_id_map WHERE UPPER(table_name) = 'STOCK'`);
	if (!latest || latest.run_id == null) return { map: null, label: "preserved ids" };
	const rows = await query(
		`SELECT source_pk, target_pk FROM \`${schema}\`.migration_id_map WHERE UPPER(table_name) = 'STOCK' AND run_id = ?`,
		[latest.run_id]
	);
	return { map: new Map(rows.map((row) => [Number(row.source_pk), Number(row.target_pk)])), label: `run ${latest.run_id} id map` };
}

async function readStockItems(schema, legacy, idMap, queryFn = query) {
	const s = `\`${schema}\``;
	const tracking = (await hasColumn(schema, "stock", "tracking_mode")) ? "COALESCE(s.tracking_mode, 'NORMAL')" : "'NORMAL'";
	// An opening stock take Migrate posted and then undid leaves its own ledger
	// rows behind; those are not stock movements of the tenant.
	const rows = await queryFn(
		`SELECT s.stock_id, s.partnr, s.description, s.stocktype, s.binnr, ${tracking} AS tracking_mode,
		        COALESCE(s.cost_price_exvat, 0) AS cost_price_exvat, COALESCE(s.quantity, 0) AS quantity,
		        (moved.stock_id IS NOT NULL) AS has_movements
		 FROM ${s}.stock s
		 LEFT JOIN (
		   SELECT DISTINCT stock_id FROM ${s}.stock_movement_ledger
		   WHERE NOT (source_type = ? AND notes LIKE ?)
		 ) moved ON moved.stock_id = s.stock_id`,
		[plan.OPENING_STOCK_SOURCE_TYPE, `%${LEDGER_NOTE_SUFFIX}`]
	);
	const legacyByTarget = new Map();
	for (const [legacyId, quantity] of legacy.quantities) {
		const targetId = idMap ? idMap.get(legacyId) : legacyId;
		if (targetId != null) legacyByTarget.set(Number(targetId), quantity);
	}
	const items = rows.map((row) => ({
		stock_id: Number(row.stock_id), partnr: row.partnr, description: row.description, stocktype: row.stocktype, binnr: row.binnr,
		tracking_mode: row.tracking_mode, cost_price_exvat: Number(row.cost_price_exvat), quantity: Number(row.quantity),
		has_movements: Boolean(Number(row.has_movements)),
		// Only quantities that are not zero are read from the legacy database.
		legacy_quantity: legacyByTarget.get(Number(row.stock_id)) || 0
	}));
	const targetIds = new Set(items.map((item) => item.stock_id));
	const notImported = [...legacyByTarget.keys()].filter((id) => !targetIds.has(id)).length +
		(idMap ? [...legacy.quantities.keys()].filter((id) => !idMap.has(id)).length : 0);
	return { items, notImported };
}

/** readOpenJobStock's parts: costed and not invoiced, on jobs the PWA can still finalise. */
async function readOpenJobParts(schema, queryFn = query) {
	const s = `\`${schema}\``;
	const historical = (await hasColumn(schema, "job_information", "is_historical_import")) ? "AND COALESCE(j.is_historical_import, 0) = 0" : "";
	const excludedLinesCosted = await areExcludedLinesCosted(schema, schema, (_db, sql, params) => queryFn(sql, params));
	const statusList = (values) => values.map((value) => `'${value}'`).join(", ");
	return queryFn(
		`SELECT su.spares_id, su.job_number, su.stock_id, su.partnr, su.siid, su.accasset, su.cost
		 FROM (
		   SELECT spares_id, job_number, stock_id, partnr, siid, accasset,
		          ROUND(CAST(cost_price AS DECIMAL(18,6)) * CAST(COALESCE(quantity, 1) AS DECIMAL(18,6)), 2) AS cost
		   FROM ${s}.spares_used
		   WHERE invoice_nr IS NULL
		     AND COALESCE(stock_id, 0) > 0
		     AND ${costedLineSql(excludedLinesCosted, "PARTS")}
		     AND UPPER(COALESCE(status, '')) NOT IN ('AWAITING_QUOTE', 'ORDER', 'ORDERED')
		 ) su
		 JOIN ${s}.job_information j ON j.job_number = su.job_number
		 WHERE su.cost > 0.009
		   AND UPPER(TRIM(COALESCE(j.status, ''))) NOT IN (${statusList(CLOSED_JOB_STATUSES)})
		   ${historical}
		   AND NOT EXISTS (
		     SELECT 1 FROM ${s}.invoices i
		     WHERE i.job_number = su.job_number AND COALESCE(i.invoice_nr, 0) > 0
		       AND UPPER(TRIM(COALESCE(i.status, ''))) IN (${statusList(ISSUED_INVOICE_STATUSES)})
		   )
		 ORDER BY su.job_number, su.spares_id`
	);
}

/** The jobs readOpenJobStock covers, without working out their stock. */
async function readOpenJobNumbers(schema, queryFn = query) {
	return new Set((await readOpenJobParts(schema, queryFn)).map((part) => Number(part.job_number)));
}

/**
 * Stock already issued to open jobs that finalising those jobs will relieve
 * from an asset account. Legacy took these parts out of stock when they went on
 * the job, so the counted quantity no longer holds them; without them in the
 * opening journal, finalising the job would take Inventory below the stock.
 * Each job is split as finalise splits it (buildDebtorInvoicePartCostLines):
 * its supplier WIP first, the rest from each part's asset account.
 */
async function readOpenJobStock(schema, cutoverDate, controls, queryFn = query) {
	const s = `\`${schema}\``;
	const parts = await readOpenJobParts(schema, queryFn);
	if (!parts.length) return { jobs: [], lines: [] };

	const accnrs = [...new Set(parts.flatMap((p) => [p.siid, p.accasset]).map(Number).filter((n) => n > 0))];
	const valid = new Set(accnrs.length
		? (await queryFn(`SELECT accnr FROM ${s}.gl_accounts WHERE accnr IN (?) AND active = 1`, [accnrs])).map((row) => Number(row.accnr))
		: []);
	const stockControls = { INVENTORY: controls.INVENTORY, SALES: controls.SALES, COS: controls.COS };
	// Mirrors the debtor invoice backfill: snapshot accounts first, then the item's own accounts.
	const resolveAccounts = async (part) => {
		const cosAccnr = part.siid && valid.has(Number(part.siid)) ? Number(part.siid) : null;
		const assetAccnr = part.accasset && valid.has(Number(part.accasset)) ? Number(part.accasset) : null;
		if (cosAccnr && assetAccnr) return { cosAccnr, assetAccnr };
		try {
			const item = await resolveStockGlAccounts({ schema, stockId: part.stock_id || null, partnr: part.partnr || null, txnType: "PARTS", queryFn, controlAccounts: stockControls });
			return { cosAccnr: cosAccnr || item.cosAccnr, assetAccnr: assetAccnr || item.assetAccnr };
		} catch (_err) {
			return { cosAccnr: cosAccnr || controls.COS, assetAccnr: assetAccnr || controls.INVENTORY };
		}
	};

	const byJob = new Map();
	for (const part of parts) {
		if (!byJob.has(part.job_number)) byJob.set(part.job_number, []);
		byJob.get(part.job_number).push({ ...part, cost: Number(part.cost) });
	}
	// The WIP credits get an account no tenant has, so only the asset credits remain.
	const WIP_MARKER = -1;
	const jobs = [];
	const lines = [];
	for (const [jobNumber, jobParts] of byJob) {
		const wip = await getJobWipDebitedTotal(queryFn, schema, jobNumber, {
			asAt: cutoverDate, resolveControlAccountsFn: async () => ({ WIP: controls.WIP })
		});
		const costLines = await buildDebtorInvoicePartCostLines({
			parts: jobParts, wipBalance: wip.total, wipAccnr: wip.wipAccnr ? WIP_MARKER : null, refs: {}, resolveAccounts
		});
		const byAccount = new Map();
		for (const line of costLines) {
			if (!line.credit || line.accnr === WIP_MARKER) continue;
			byAccount.set(line.accnr, plan.round2((byAccount.get(line.accnr) || 0) + line.credit));
		}
		const cost = plan.round2(jobParts.reduce((sum, part) => sum + part.cost, 0));
		const accounts = [...byAccount].map(([accnr, amount]) => ({ accnr, amount }));
		jobs.push({ job_number: Number(jobNumber), parts: jobParts.length, cost, wip: plan.round2(Math.min(cost, wip.total)), accounts });
		for (const account of accounts) lines.push({ job_number: Number(jobNumber), ...account });
	}
	return { jobs, lines };
}

async function readInventoryBalance(schema, accnr, asAt, queryFn = query) {
	const [row] = await queryFn(
		`SELECT ROUND(COALESCE(SUM(l.debit - l.credit), 0), 2) AS balance
		 FROM \`${schema}\`.gl_journal_headers h JOIN \`${schema}\`.gl_journal_lines l ON l.header_id = h.id
		 WHERE h.status = 'POSTED' AND l.accnr = ? AND h.trxdate <= ?`,
		[accnr, asAt]
	);
	return Number(row.balance) || 0;
}

async function readLaterInventoryLines(schema, accnr, asAt, queryFn = query) {
	const [row] = await queryFn(
		`SELECT COUNT(*) AS n, DATE_FORMAT(MAX(h.trxdate), '%Y-%m-%d') AS last
		 FROM \`${schema}\`.gl_journal_headers h JOIN \`${schema}\`.gl_journal_lines l ON l.header_id = h.id
		 WHERE h.status = 'POSTED' AND l.accnr = ? AND h.trxdate > ?`,
		[accnr, asAt]
	);
	return { lines: Number(row.n), last: row.last };
}

async function readLatestDocumentDate(schema, tables) {
	const sources = [["invoices", "invoice_date"], ["invoices_supplier", "inv_date"], ["payments", "paydate"], ["payments_suppliers", "paydate"]]
		.filter(([table]) => tables.has(table));
	let latest = null;
	for (const [table, column] of sources) {
		const [row] = await query(`SELECT DATE_FORMAT(MAX(${column}), '%Y-%m-%d') AS last FROM \`${schema}\`.${table} WHERE ${column} <= CURDATE()`);
		if (row && row.last && (!latest || row.last > latest)) latest = row.last;
	}
	return latest;
}

/** The session Migrate posted, whatever state the PWA has left it in. */
async function readMigrateSession(schema, queryFn = query, forUpdate = false) {
	const [session] = await queryFn(
		`SELECT takeid, stocktakeday, set_type, newcount, import_filename, created_at FROM \`${schema}\`.stock_takes
		 WHERE source_type = ? AND import_filename LIKE ? ORDER BY takeid DESC LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
		[plan.OPENING_STOCK_SOURCE_TYPE, `${plan.IMPORT_FILENAME_PREFIX}%`]
	);
	return session || null;
}

async function readControlsByKey(schema, queryFn = query) {
	const rows = await controlAccounts.readControls(queryFn, schema);
	return Object.fromEntries(rows.map((row) => [row.key, row]));
}

function controlAccnrs(byKey) {
	const accnr = (key) => (byKey[key] && byKey[key].status === "mapped" ? byKey[key].accnr : null);
	return { INVENTORY: accnr("INVENTORY"), OPENING_STOCK: accnr("OPENING_STOCK"), SALES: accnr("SALES"), COS: accnr("COS"), WIP: accnr("WIP") };
}

function summarize(list, key = "legacy_value") {
	return { items: list.length, value: plan.round2(list.reduce((sum, row) => sum + (Number(row[key]) || 0), 0)) };
}

function publicRow(row) {
	return {
		stock_id: row.stock_id, partnr: row.partnr, description: row.description, stocktype: row.stocktype,
		legacy_quantity: row.legacy_quantity, quantity: row.quantity, cost: row.cost_price_exvat, value: row.legacy_value,
		candidate: Boolean(row.candidate)
	};
}

/** Everything the post would do, worked out from the tenant and the legacy quantities. */
async function buildOpeningPlan(schema, legacy, input, queryFn = query) {
	const tables = await readTables(schema);
	const missingTables = REQUIRED_TABLES.filter((table) => !tables.has(table));
	if (missingTables.length) return { missingTables };

	const ids = await readStockIdMap(schema, tables);
	const { items, notImported } = await readStockItems(schema, legacy, ids.map, queryFn);
	const options = plan.readPlanOptions(input);
	const groups = plan.classifyItems(items, options);
	const controlsByKey = await readControlsByKey(schema, queryFn);
	const controls = controlAccnrs(controlsByKey);

	const latestDocument = await readLatestDocumentDate(schema, tables);
	const defaultCutover = latestDocument ? addDays(latestDocument, 1) : todayYmd();
	const cutoverDate = input.cutoverDate == null || input.cutoverDate === "" ? defaultCutover : String(input.cutoverDate);
	if (!isYmd(cutoverDate)) throw httpError(400, "invalid_date", "Enter the cut-over date as YYYY-MM-DD.");

	const blockers = [];
	const warnings = [];
	if (!controls.INVENTORY) blockers.push("Map the Inventory control account in the Tenant Check.");
	if (!controls.OPENING_STOCK) blockers.push("Map the Opening Stock control account to an Equity account in the Tenant Check.");
	let periodProblem = null;
	try {
		await getOpenPeriodId(schema, cutoverDate, queryFn);
	} catch (err) {
		periodProblem = err.code === "PERIOD_CLOSED" ? `The GL period for ${cutoverDate} is closed.` : `No GL period covers ${cutoverDate}.`;
		blockers.push(periodProblem);
	}
	const [sessionOnDate] = await queryFn(`SELECT takeid FROM \`${schema}\`.stock_takes WHERE stocktakeday = ? LIMIT 1`, [cutoverDate]);
	if (sessionOnDate) blockers.push(`A stock take session already exists for ${cutoverDate}. Choose another cut-over date.`);
	if (!groups.counted.length) {
		blockers.push(groups.alreadyStocked.length
			? "Every legacy quantity is already in the tenant's stock. Re-import STOCK with this version of Migrate so quantities come in through the opening stock take."
			: "The legacy database has no stock quantities to bring in.");
	}

	let openJobs = { jobs: [], lines: [] };
	let inventoryBalance = 0;
	let later = { lines: 0, last: null };
	if (controls.INVENTORY) {
		openJobs = await readOpenJobStock(schema, cutoverDate, controls, queryFn);
		inventoryBalance = await readInventoryBalance(schema, controls.INVENTORY, cutoverDate, queryFn);
		later = await readLaterInventoryLines(schema, controls.INVENTORY, cutoverDate, queryFn);
		if (later.lines) {
			blockers.push(`${later.lines} Inventory journal lines are dated after ${cutoverDate} (last ${later.last}). ` +
				"Legacy quantities already include those movements, so choose a cut-over on or after that date.");
		}
	}

	const takeLines = plan.buildTakeLines(groups.counted, cutoverDate);
	const journalLines = controls.INVENTORY && controls.OPENING_STOCK
		? plan.buildJournalLines({ takeLines, openJobLines: openJobs.lines, inventoryBalance, inventoryAccnr: controls.INVENTORY, openingAccnr: controls.OPENING_STOCK, takedate: cutoverDate })
		: [];

	if (groups.alreadyStocked.length) warnings.push(`${groups.alreadyStocked.length} items already have stock or stock movements in the tenant; they are left as they are.`);
	if (groups.zeroCost.length) warnings.push(`${groups.zeroCost.length} counted items have no ex-VAT cost, so they add quantity but no value.`);
	if (groups.negativeCost.length) {
		const value = plan.round2(groups.negativeCost.reduce((sum, row) => sum + row.value, 0));
		warnings.push(`${groups.negativeCost.length} counted items have a negative ex-VAT cost (${value.toFixed(2)}). They are posted as they are, ` +
			"so Inventory matches the stock valuation; correct their cost prices.");
	}
	if (notImported) warnings.push(`${notImported} legacy items with a quantity are not in the tenant's stock.`);

	return {
		missingTables, tables, legacy, ids, options, groups, controlsByKey, controls, cutoverDate, defaultCutover, latestDocument,
		periodProblem, openJobs, inventoryBalance, takeLines, journalLines, blockers, warnings
	};
}

async function readBackfillStatus(schema, tables) {
	if (!tables.has("gl_backfill_runs")) return null;
	const [run] = await query(
		`SELECT id, status, DATE_FORMAT(from_date, '%Y-%m-%d') AS from_date, DATE_FORMAT(to_date, '%Y-%m-%d') AS to_date, finished_at
		 FROM \`${schema}\`.gl_backfill_runs WHERE dry_run = 0 ORDER BY id DESC LIMIT 1`
	);
	return run || null;
}

async function readPostedState(schema, session, controls) {
	const s = `\`${schema}\``;
	const sourceId = `ST-${session.takeid}`;
	const [journal] = await query(
		`SELECT h.id, DATE_FORMAT(h.trxdate, '%Y-%m-%d') AS trxdate, p.status AS period_status,
		        ROUND(SUM(CASE WHEN l.accnr = ? THEN l.debit - l.credit ELSE 0 END), 2) AS inventory,
		        ROUND(SUM(l.debit), 2) AS total
		 FROM ${s}.gl_journal_headers h
		 JOIN ${s}.gl_journal_lines l ON l.header_id = h.id
		 LEFT JOIN ${s}.gl_periods p ON p.id = h.period_id
		 WHERE h.source = ? AND h.source_id = ? GROUP BY h.id, h.trxdate, p.status`,
		[controls.INVENTORY || 0, plan.JOURNAL_SOURCE, sourceId]
	);
	const [lines] = await query(
		`SELECT COUNT(*) AS n, ROUND(COALESCE(SUM(costoverunder), 0), 2) AS value,
		        COALESCE(SUM(s.stock_id IS NULL OR COALESCE(s.quantity, 0) <> st.newquantity), 0) AS moved
		 FROM ${s}.stock_take st LEFT JOIN ${s}.stock s ON s.stock_id = st.stock_id WHERE st.takedate = ?`,
		[session.stocktakeday]
	);
	const [latest] = await query(`SELECT MAX(takeid) AS takeid FROM ${s}.stock_takes`);
	const [valuation] = await query(
		`SELECT ROUND(COALESCE(SUM(COALESCE(quantity, 0) * COALESCE(cost_price_exvat, 0)), 0), 2) AS value
		 FROM ${s}.stock WHERE UPPER(TRIM(COALESCE(stocktype, ''))) NOT IN ('ASSET', 'TOOL')`
	);
	const inventoryAtCutover = controls.INVENTORY ? await readInventoryBalance(schema, controls.INVENTORY, session.stocktakeday) : null;
	const inventoryNow = controls.INVENTORY ? await readInventoryBalance(schema, controls.INVENTORY, "9999-12-31") : null;

	const undoBlockers = [];
	const finalised = String(session.set_type || "").toUpperCase() === "FINALISED";
	if (finalised) {
		if (Number(latest.takeid) !== Number(session.takeid)) undoBlockers.push("A later stock take exists. Only the latest stock take can be undone.");
		if (journal && journal.period_status !== "OPEN") undoBlockers.push(`The GL period of ${session.stocktakeday} is closed.`);
		if (Number(lines.moved)) undoBlockers.push(`${lines.moved} counted items have moved since the opening stock take.`);
	}
	return {
		takeid: Number(session.takeid), takedate: session.stocktakeday, status: session.set_type, createdAt: session.created_at,
		lines: Number(lines.n), value: Number(lines.value), journal: journal ? { id: Number(journal.id), total: Number(journal.total), inventory: Number(journal.inventory) } : null,
		inventoryAtCutover, inventoryNow, valuationNow: Number(valuation.value),
		canUndo: undoBlockers.length === 0, undoBlockers
	};
}

function accountNames(rows) {
	return new Map(rows.map((row) => [Number(row.accnr), row.name]));
}

function journalByAccount(lines, names) {
	const byAccount = new Map();
	for (const line of lines) {
		const row = byAccount.get(line.accnr) || { accnr: line.accnr, name: names.get(line.accnr) || null, debit: 0, credit: 0 };
		row.debit = plan.round2(row.debit + (line.debit || 0));
		row.credit = plan.round2(row.credit + (line.credit || 0));
		byAccount.set(line.accnr, row);
	}
	return [...byAccount.values()].sort((a, b) => a.accnr - b.accnr);
}

/** Read-only: the opening stock take Migrate would post, or the one it posted. */
async function readOpeningStock({ schema, firebirdConfig, input = {} }) {
	const tables = await readTables(schema);
	const missingTables = REQUIRED_TABLES.filter((table) => !tables.has(table));
	if (missingTables.length) return { schema, missingTables };
	const controls = controlAccnrs(await readControlsByKey(schema));
	const session = await readMigrateSession(schema);
	if (session) {
		return { schema, missingTables, posted: await readPostedState(schema, session, controls), backfill: await readBackfillStatus(schema, tables) };
	}

	const built = await buildOpeningPlan(schema, await readLegacyQuantities(firebirdConfig), input);
	const { groups } = built;
	const names = accountNames(await query(`SELECT accnr, name FROM \`${schema}\`.gl_accounts`));
	const openJobValue = plan.round2(built.openJobs.lines.reduce((sum, line) => sum + line.amount, 0));
	const counted = summarize(groups.counted, "value");
	const backfill = await readBackfillStatus(schema, tables);
	if (!backfill) built.warnings.unshift("No live GL backfill has run. Run it first: the opening journal reverses the Inventory balance the backfill leaves.");
	const control = (key) => {
		const row = built.controlsByKey[key];
		return row ? { accnr: row.accnr, name: row.name, status: row.status, reason: row.reason } : null;
	};
	return {
		schema, missingTables, posted: null, backfill,
		legacy: { database: built.legacy.database, rows: built.legacy.rows, withQuantity: built.legacy.quantities.size, ids: built.ids.label },
		cutoverDate: built.cutoverDate, defaultCutover: built.defaultCutover, latestDocument: built.latestDocument,
		placeholderMinQty: built.options.placeholderMinQty,
		controls: { inventory: control("INVENTORY"), opening: control("OPENING_STOCK") },
		summary: {
			counted: { ...counted, quantity: plan.round2(groups.counted.reduce((sum, row) => sum + row.quantity, 0)) },
			placeholders: summarize(groups.placeholders), negatives: summarize(groups.negatives), zeroCost: { items: groups.zeroCost.length },
			negativeCost: summarize(groups.negativeCost, "value"),
			alreadyStocked: summarize(groups.alreadyStocked), workshopAssets: summarize(groups.workshopAssets), rebuildListed: summarize(groups.rebuildListed),
			openJobs: { jobs: built.openJobs.jobs.length, value: openJobValue },
			inventoryBalance: built.inventoryBalance,
			inventoryAfter: plan.round2(built.inventoryBalance + plan.sumLines(built.journalLines, built.controls.INVENTORY)),
			journalTotal: plan.round2(built.journalLines.reduce((sum, line) => sum + (line.debit || 0), 0))
		},
		journal: journalByAccount(built.journalLines, names),
		openJobs: built.openJobs.jobs.map((job) => ({ ...job, accounts: job.accounts.map((a) => ({ ...a, name: names.get(a.accnr) || null })) })),
		lists: {
			counted: groups.counted.slice(0, LIST_LIMIT).map(publicRow),
			placeholders: groups.placeholders.map(publicRow),
			negatives: groups.negatives.slice(0, LIST_LIMIT).map(publicRow),
			zeroCost: groups.zeroCost.slice(0, LIST_LIMIT).map(publicRow),
			negativeCost: groups.negativeCost.map(publicRow),
			alreadyStocked: groups.alreadyStocked.slice(0, LIST_LIMIT).map(publicRow)
		},
		blockers: built.blockers, warnings: built.warnings, canPost: built.blockers.length === 0
	};
}

async function setMovementContext(txQuery, context) {
	await txQuery(
		`SET @stock_movement_source_type = ?, @stock_movement_source_ref = ?, @stock_movement_source_line_ref = NULL,
		     @stock_movement_notes = ?, @stock_movement_staff_id = NULL`,
		[context.sourceType, context.sourceRef, context.notes]
	);
}

async function clearMovementContext(txQuery) {
	await txQuery(
		`SET @stock_movement_source_type = NULL, @stock_movement_source_ref = NULL, @stock_movement_source_line_ref = NULL,
		     @stock_movement_notes = NULL, @stock_movement_staff_id = NULL`
	);
}

async function insertChunks(txQuery, sql, rows, toValues, columnsPerRow) {
	for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
		const chunk = rows.slice(i, i + INSERT_CHUNK);
		const placeholders = chunk.map(() => `(${new Array(columnsPerRow).fill("?").join(", ")})`).join(", ");
		await txQuery(`${sql} VALUES ${placeholders}`, chunk.flatMap(toValues));
	}
}

/** Posts the opening stock take in one transaction. */
async function postOpeningStock({ schema, firebirdConfig, input = {}, staffId = 0, onProgress = () => {} }) {
	const tables = await readTables(schema);
	const missing = REQUIRED_TABLES.filter((table) => !tables.has(table));
	if (missing.length) throw httpError(409, "missing_tables", `Missing ${missing.join(", ")}.`);
	if (await readMigrateSession(schema)) throw httpError(409, "already_posted", "The opening stock take has already been posted. Undo it first to post it again.");
	onProgress({ phase: "read" });
	const legacy = await readLegacyQuantities(firebirdConfig);

	const tx = await companyTransaction();
	try {
		// Header-first lock, as the PWA's stock take routes take it.
		await tx.query(`SELECT takeid FROM \`${schema}\`.stock_takes ORDER BY takeid DESC LIMIT 1 FOR UPDATE`);
		if (await readMigrateSession(schema, tx.query, true)) throw httpError(409, "already_posted", "The opening stock take has already been posted.");
		const built = await buildOpeningPlan(schema, legacy, input, tx.query);
		if (built.missingTables.length) throw httpError(409, "missing_tables", `Missing ${built.missingTables.join(", ")}.`);
		if (built.blockers.length) throw httpError(409, "not_ready", built.blockers.join(" "));
		const { cutoverDate: takedate, takeLines, controls, groups } = built;
		const s = `\`${schema}\``;

		const header = await tx.query(
			`INSERT INTO ${s}.stock_takes
			 (stocktakeday, lastcount, newcount, set_type, source_type, import_filename, import_total_rows, import_matched_rows, import_skipped_rows, created_by, created_at)
			 VALUES (?, ?, ?, 'FINALISED', ?, ?, ?, ?, ?, ?, NOW())`,
			[takedate, takeLines.length, takeLines.length, plan.OPENING_STOCK_SOURCE_TYPE,
				`${plan.IMPORT_FILENAME_PREFIX}${built.legacy.database}`.slice(0, 255), built.legacy.quantities.size, takeLines.length,
				built.legacy.quantities.size - takeLines.length, staffId]
		);
		const takeid = header.insertId;
		const sourceRef = `ST-${takeid}`;

		onProgress({ phase: "lines", processed: 0, total: takeLines.length });
		await insertChunks(tx.query,
			`INSERT INTO ${s}.stock_take (stock_id, partnr, description, quantity, stocktype, cost_price, newquantity, takedate, status, diffquantity, binnr, costoverunder)`,
			takeLines, (l) => [l.stock_id, l.partnr, l.description, l.quantity, l.stocktype, l.cost_price, l.newquantity, l.takedate, l.status, l.diffquantity, l.binnr, l.costoverunder], 12);

		await setMovementContext(tx.query, { sourceType: plan.OPENING_STOCK_SOURCE_TYPE, sourceRef, notes: `Opening stocktake import ${takedate} ${LEDGER_NOTE_SUFFIX}` });
		try {
			let processed = 0;
			for (const line of takeLines) {
				const result = await tx.query(
					`UPDATE ${s}.stock SET quantity = ?
					 WHERE stock_id = ? AND COALESCE(quantity, 0) = 0 AND COALESCE(tracking_mode, 'NORMAL') <> 'REBUILD_LISTED'
					   AND UPPER(TRIM(COALESCE(stocktype, ''))) NOT IN ('ASSET', 'TOOL')`,
					[line.newquantity, line.stock_id]
				);
				if (Number(result.affectedRows) !== 1) throw httpError(409, "stock_changed", `Stock item ${line.partnr || line.stock_id} changed while the opening stock was posted. Check again.`);
				if (++processed % 250 === 0) onProgress({ phase: "stock", processed, total: takeLines.length });
			}
		} finally {
			await clearMovementContext(tx.query);
		}

		// PWA finalise writes one adjust_stock row per variance; its rollback deletes them by this reason and date.
		await insertChunks(tx.query,
			`INSERT INTO ${s}.adjust_stock (stock_id, description, part_nr, quantity, reason, adjust_date, staff_id, cost_price, adjusttype)`,
			takeLines, (l) => [l.stock_id, String(l.description).slice(0, 50), String(l.partnr).slice(0, 70), l.diffquantity, `Stock Take ${takedate}`, takedate, staffId, l.cost_price, "GAIN"], 9);

		onProgress({ phase: "journal" });
		// As in PWA finalise, a take whose lines carry no value posts no journal.
		const posted = built.journalLines.length
			? await postJournal({
				schema, source: plan.JOURNAL_SOURCE, sourceId: sourceRef, trxdate: takedate,
				description: `Opening Stock Import ${takedate} (Autoneer-Migrate)`, lines: built.journalLines, userId: staffId, queryFn: tx.query
			})
			: { id: null, status: "posted" };
		if (posted.status !== "posted") throw httpError(409, "journal_exists", `A ${plan.JOURNAL_SOURCE} journal ${sourceRef} already exists.`);

		const expected = plan.round2(plan.sumLines(built.journalLines, controls.INVENTORY) + built.inventoryBalance);
		const after = await readInventoryBalance(schema, controls.INVENTORY, takedate, tx.query);
		if (Math.abs(after - expected) > 0.009) throw new Error(`Inventory at ${takedate} would be ${after.toFixed(2)}, not ${expected.toFixed(2)}. Nothing was posted.`);

		await tx.commit();
		return {
			takeid, takedate, journalId: posted.id, lines: takeLines.length,
			value: plan.round2(takeLines.reduce((sum, line) => sum + line.costoverunder, 0)),
			placeholders: groups.placeholders.length, negatives: groups.negatives.length,
			openJobs: built.openJobs.jobs.length, cleared: built.inventoryBalance, inventoryAtCutover: after
		};
	} catch (err) {
		await tx.rollback();
		throw err;
	}
}

/**
 * Reverses the opening stock take while nothing has moved since: quantities
 * back to 0 with tagged ledger rows, then the adjustments, the journal, the
 * lines and the session are removed. A session the PWA already rolled back
 * (READY, no journal) is simply removed.
 */
async function undoOpeningStock({ schema }) {
	const tx = await companyTransaction();
	try {
		const s = `\`${schema}\``;
		const session = await readMigrateSession(schema, tx.query, true);
		if (!session) throw httpError(404, "not_posted", "There is no opening stock take to undo.");
		const takedate = session.stocktakeday;
		const sourceRef = `ST-${session.takeid}`;
		const finalised = String(session.set_type || "").toUpperCase() === "FINALISED";
		let restored = 0;
		let journalDeleted = false;
		if (finalised) {
			const [latest] = await tx.query(`SELECT MAX(takeid) AS takeid FROM ${s}.stock_takes`);
			if (Number(latest.takeid) !== Number(session.takeid)) throw httpError(409, "not_latest", "A later stock take exists. Only the latest stock take can be undone.");
			const lines = await tx.query(
				`SELECT st.stock_id, st.partnr, st.newquantity, s.quantity FROM ${s}.stock_take st
				 LEFT JOIN ${s}.stock s ON s.stock_id = st.stock_id WHERE st.takedate = ? FOR UPDATE`,
				[takedate]
			);
			const moved = lines.filter((line) => line.quantity == null || Number(line.quantity) !== Number(line.newquantity));
			if (moved.length) throw httpError(409, "stock_moved", `${moved.length} counted items have moved since the opening stock take, for example ${moved[0].partnr || moved[0].stock_id}.`);
			await setMovementContext(tx.query, { sourceType: plan.OPENING_STOCK_SOURCE_TYPE, sourceRef, notes: `Opening stocktake import ${takedate} undone ${LEDGER_NOTE_SUFFIX}` });
			try {
				for (const line of lines) {
					const result = await tx.query(`UPDATE ${s}.stock SET quantity = 0 WHERE stock_id = ? AND quantity = ?`, [line.stock_id, line.newquantity]);
					if (Number(result.affectedRows) !== 1) throw httpError(409, "stock_changed", `Stock item ${line.partnr || line.stock_id} changed during the undo.`);
					restored++;
				}
			} finally {
				await clearMovementContext(tx.query);
			}
			await tx.query(`DELETE FROM ${s}.adjust_stock WHERE reason = ? AND adjust_date = ?`, [`Stock Take ${takedate}`, takedate]);
			const [journal] = await tx.query(
				`SELECT p.status FROM ${s}.gl_journal_headers h LEFT JOIN ${s}.gl_periods p ON p.id = h.period_id WHERE h.source = ? AND h.source_id = ? LIMIT 1`,
				[plan.JOURNAL_SOURCE, sourceRef]
			);
			if (journal && journal.status !== "OPEN") throw httpError(409, "period_closed", `The GL period of ${takedate} is closed.`);
			journalDeleted = (await deleteGlJournalBySource(schema, plan.JOURNAL_SOURCE, sourceRef, tx.query)).deleted;
		} else {
			const [journal] = await tx.query(`SELECT id FROM ${s}.gl_journal_headers WHERE source = ? AND source_id = ? LIMIT 1`, [plan.JOURNAL_SOURCE, sourceRef]);
			if (journal) throw httpError(409, "journal_remains", `Journal ${sourceRef} still exists for a session that is not finalised. Remove it in the PWA first.`);
		}
		await tx.query(`DELETE FROM ${s}.stock_take WHERE takedate = ?`, [takedate]);
		await tx.query(`DELETE FROM ${s}.stock_takes WHERE takeid = ?`, [session.takeid]);
		await tx.commit();
		return { takeid: Number(session.takeid), takedate, restored, journalDeleted };
	} catch (err) {
		await tx.rollback();
		throw err;
	}
}

/** The date of the opening stock take Migrate posted, or null. */
async function readOpeningStockDate(schema) {
	const tables = await readTables(schema);
	if (!tables.has("stock_takes")) return null;
	const session = await readMigrateSession(schema);
	return session && String(session.set_type || "").toUpperCase() === "FINALISED" ? session.stocktakeday : null;
}

/** What the other cut-over steps share with this one: the tables, dates, last live backfill and control accounts. */
async function readCutoverContext(schema, queryFn = query) {
	const tables = await readTables(schema);
	const latestDocument = await readLatestDocumentDate(schema, tables);
	return {
		tables,
		latestDocument,
		defaultCutover: latestDocument ? addDays(latestDocument, 1) : todayYmd(),
		openingStockDate: await readOpeningStockDate(schema),
		backfill: await readBackfillStatus(schema, tables),
		controlsByKey: await readControlsByKey(schema, queryFn)
	};
}

module.exports = {
	ISSUED_INVOICE_STATUSES,
	readOpeningStock,
	postOpeningStock,
	undoOpeningStock,
	readOpeningStockDate,
	readOpenJobStock,
	readOpenJobNumbers,
	readCutoverContext,
	controlAccnrs,
	isYmd
};
