// Imports the parts and labour lines of general invoices that an earlier import
// left out. Legacy general invoices sell parts and labour without a job, so
// their SPARES_USED and WORKDONE lines carry job 0 and the invoice number; the
// data-quality check used to reject every line on job 0, so the invoice headers
// migrated without their lines.
//
//   node scripts/backfill_general_invoice_lines.js                   dry run: what would be added
//   node scripts/backfill_general_invoice_lines.js --write           add them, with a backup in logs/
//   node scripts/backfill_general_invoice_lines.js --undo <backup>   remove the lines a --write added
//
// Connects with the .env settings (MYSQL_*, FIREBIRD_*); --schema <name> picks
// another tenant. Lines are mapped with the mapping the tenant's import used
// (migration_run_mappings), costs are stored per unit like the import does, and
// legacy group account numbers are converted like sp_convert_transactional_accnr.
// Before adding anything, every line already imported is mapped the same way and
// compared with the tenant, so a mapping that no longer reproduces the import
// shows up in the dry run. Lines with job 0 and no invoice number stay out.
//
// AUTONEER-PWA shows and credits a general invoice from customer_invoice_lines,
// and legacy left general invoices at status DONE where job invoices are POSTED.
// So each general invoice with lines also gets its customer_invoice_lines, built
// the way POS writes them (cost per unit), and DONE becomes POSTED. Afterwards,
// run the GL backfill for customer invoices; these invoices have no journal yet.
// --undo puts the status back, but leaves any journal posted since: delete those first.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const mysql = require("mysql2/promise");
const firebird = require("../src/db/firebird");
const { state } = require("../src/config/state");
const { mapRow, convertLegacyGroupAccnr } = require("../src/migrate/rowMapping");
const sparesUnitCost = require("../src/migrate/sparesUnitCost");

const args = process.argv.slice(2);
const option = (name) => {
	const at = args.indexOf(name);
	return at === -1 ? null : args[at + 1];
};
const write = args.includes("--write");
const undoFile = option("--undo");
const schema = option("--schema") || state.schemaName;

const TABLES = [
	{ target: "spares_used", source: "SPARES_USED", mapping: "SPARES_USED", key: "spares_id", accounts: ["siid", "acc", "accasset"], money: "sales_price" },
	{ target: "work_done", source: "WORKDONE", mapping: "WORK_DONE", key: "wdid", accounts: ["siid", "acc"], money: "workprice" }
];

const money = (value) => Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const count = (value) => Number(value || 0).toLocaleString();
const lowerKeys = (row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]));

function connect() {
	return mysql.createConnection({
		host: state.mysql.host, port: Number(state.mysql.port || 3306), user: state.mysql.user, password: state.mysql.password, database: schema
	});
}

async function readLegacy() {
	const config = firebird.resolveFirebirdConfig(state.firebird);
	const problem = firebird.validateFirebirdConfig(config);
	if (problem) throw new Error(`Legacy database: ${problem}`);
	const db = await firebird.attachWithRetry(config);
	try {
		const rows = {};
		for (const table of TABLES) rows[table.target] = await firebird.queryWithDb(db, `SELECT * FROM ${table.source}`);
		return { database: path.basename(String(config.database).replace(/\\/g, "/")), rows };
	} finally {
		db.detach();
	}
}

async function loadMapping(conn, table) {
	const [rows] = await conn.query(
		"SELECT run_id, mapping_json FROM migration_run_mappings WHERE UPPER(table_name) = ? ORDER BY run_id DESC, id DESC LIMIT 1",
		[table.mapping]
	);
	if (!rows.length) throw new Error(`No import mapping for ${table.mapping} in ${schema}.migration_run_mappings`);
	const mapping = JSON.parse(rows[0].mapping_json);
	return { runId: rows[0].run_id, columns: mapping.columns || {} };
}

// sp_convert_transactional_accnr: a legacy group account (not class 7) becomes its new number.
async function loadGroupAccounts(conn) {
	const [rows] = await conn.query("SELECT accnr, acctype, accclass FROM accounts");
	const groups = new Set();
	for (const row of rows) {
		if (String(row.acctype || "").trim().toLowerCase() === "group account" && row.accclass != null && Number(row.accclass) !== 7) groups.add(Number(row.accnr));
	}
	return groups;
}

async function mapLine(table, legacyRow, mapping, columnTypes, groupAccounts) {
	const mapped = lowerKeys(await mapRow(lowerKeys(legacyRow), mapping.columns, async (_table, value) => value, { targetTable: table.target, columnTypes }));
	if (table.target === "spares_used") sparesUnitCost.toUnitCost(mapped);
	for (const column of table.accounts) {
		const value = mapped[column];
		if (value != null && value !== "" && groupAccounts.has(Number(value))) mapped[column] = convertLegacyGroupAccnr(value);
	}
	return mapped;
}

const isGeneralInvoiceLine = (row) => Number(row.job_nr) === 0 && Number(row.invnr) > 0;
const dateText = (value) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
const validId = (value) => /^\d+$/.test(String(value ?? "").trim()) && Number(value) > 0;

// A line's content without its id, so a line that was given a new id is still recognised.
function signature(row, columns, key) {
	return JSON.stringify(columns.filter((col) => col !== key).map((col) => {
		const value = row[col];
		if (value == null || value === "") return "";
		if (value instanceof Date) return dateText(value);
		const number = Number(value);
		return String(value).trim() !== "" && Number.isFinite(number) ? number.toFixed(4) : String(value).trim();
	}));
}

function sameValue(mapped, stored) {
	if (mapped == null || stored == null) return (mapped == null || mapped === "") && (stored == null || stored === "");
	if (mapped instanceof Date || stored instanceof Date) {
		const text = (value) => value instanceof Date ? dateText(value) : String(value).slice(0, 10);
		return text(mapped) === text(stored);
	}
	const a = Number(mapped);
	const b = Number(stored);
	if (Number.isFinite(a) && Number.isFinite(b) && String(mapped).trim() !== "" && String(stored).trim() !== "") return Math.abs(a - b) < 0.005;
	return String(mapped).trim() === String(stored).trim();
}

async function plan(conn, legacy) {
	const groupAccounts = await loadGroupAccounts(conn);
	const [invoiceRows] = await conn.query("SELECT invoice_nr, job_number FROM invoices");
	const invoices = new Map(invoiceRows.map((row) => [Number(row.invoice_nr), Number(row.job_number)]));
	// Legacy WDID is not unique. Like the import's line-id repair, a missing or repeated
	// WDID gets a new id unless a part line refers to it, which leaves it ambiguous.
	const wdidCounts = new Map();
	for (const row of legacy.rows.work_done) {
		const id = lowerKeys(row).wdid;
		if (validId(id)) wdidCounts.set(Number(id), (wdidCounts.get(Number(id)) || 0) + 1);
	}
	const wdidReferences = new Set(legacy.rows.spares_used.map((row) => lowerKeys(row).wdid).filter(validId).map(Number));
	const result = [];
	for (const table of TABLES) {
		const mapping = await loadMapping(conn, table);
		const [columnRows] = await conn.query(`SHOW COLUMNS FROM \`${table.target}\``);
		const targetColumns = new Set(columnRows.map((col) => col.Field));
		const columnTypes = new Map(columnRows.map((col) => [col.Field, String(col.Type).replace(/\(.*$/, "").toLowerCase()]));
		const [storedRows] = await conn.query(`SELECT * FROM \`${table.target}\``);
		const stored = new Map(storedRows.map((row) => [Number(row[table.key]), row]));

		const entry = { table, runId: mapping.runId, add: [], present: 0, keyTaken: [], ambiguous: [], newIds: 0, noInvoice: [], notGeneral: 0, checked: 0, mismatches: new Map(), columns: null };
		const general = [];
		for (const legacyRow of legacy.rows[table.target]) {
			const row = lowerKeys(legacyRow);
			const mapped = await mapLine(table, row, mapping, columnTypes, groupAccounts);
			entry.columns = entry.columns || Object.keys(mapped).filter((col) => targetColumns.has(col));
			const existing = stored.get(Number(mapped[table.key]));
			if (!isGeneralInvoiceLine(row)) {
				entry.notGeneral += 1;
				// Replay check: an imported line must come out of this mapping as it is stored.
				if (existing && Number(existing.job_number) === Number(mapped.job_number)) {
					entry.checked += 1;
					for (const column of entry.columns) {
						if (sameValue(mapped[column], existing[column])) continue;
						const seen = entry.mismatches.get(column) || { count: 0, examples: [], all: [] };
						seen.count += 1;
						seen.all.push({ spares_id: Number(mapped[table.key]), job_number: Number(existing.job_number), column, mapped: mapped[column], stored: existing[column] });
						if (seen.examples.length < 3) seen.examples.push({ [table.key]: mapped[table.key], mapped: mapped[column], stored: existing[column] });
						entry.mismatches.set(column, seen);
					}
				}
				continue;
			}
			general.push(mapped);
		}

		// Lines on job 0 already in the tenant, by content (a re-run adds nothing).
		const inTenant = new Map();
		for (const row of storedRows) {
			if (Number(row.job_number) !== 0) continue;
			const sig = signature(row, entry.columns, table.key);
			inTenant.set(sig, (inTenant.get(sig) || 0) + 1);
		}
		const reserved = new Set();
		for (const mapped of general) {
			const sig = signature(mapped, entry.columns, table.key);
			if (inTenant.get(sig) > 0) {
				inTenant.set(sig, inTenant.get(sig) - 1);
				entry.present += 1;
				continue;
			}
			const line = { [table.key]: mapped[table.key], invoice_nr: mapped.invoice_nr };
			if (!invoices.has(Number(mapped.invoice_nr))) {
				entry.noInvoice.push(line);
				continue;
			}
			const id = Number(mapped[table.key]);
			if (table.target === "work_done" && (!validId(mapped.wdid) || wdidCounts.get(id) > 1)) {
				if (validId(mapped.wdid) && wdidReferences.has(id)) {
					entry.ambiguous.push(line);
					continue;
				}
				mapped.wdid = null;
				entry.newIds += 1;
			} else if (stored.has(id) || reserved.has(id)) {
				const holder = stored.get(id);
				entry.keyTaken.push({ ...line, heldBy: holder ? { job_number: holder.job_number, invoice_nr: holder.invoice_nr } : "another line in this backfill" });
				continue;
			} else {
				reserved.add(id);
			}
			entry.add.push(mapped);
		}
		result.push(entry);
	}
	return result;
}

function report(entries, database) {
	console.log(`Tenant ${schema}, legacy database ${database}.\n`);
	for (const entry of entries) {
		const { table } = entry;
		const invoicesTouched = new Set(entry.add.map((row) => Number(row.invoice_nr)));
		console.log(`${table.target} (mapping from import run ${entry.runId}):`);
		console.log(`  To add:                 ${count(entry.add.length)} general-invoice lines on ${count(invoicesTouched.size)} invoices` +
			(table.target === "spares_used"
				? `, cost ${money(entry.add.reduce((sum, row) => sum + Number(row.cost_price || 0) * Number(row.quantity || 0), 0))}, sales ${money(entry.add.reduce((sum, row) => sum + Number(row.sales_price || 0), 0))}`
				: `, labour ${money(entry.add.reduce((sum, row) => sum + Number(row.workprice || 0), 0))}`));
		if (entry.newIds) console.log(`    of which ${count(entry.newIds)} get a new ${table.key}: legacy repeats it on other lines`);
		console.log(`  Already in the tenant:  ${count(entry.present)}`);
		console.log(`  Id held by another line (left out): ${count(entry.keyTaken.length)}`);
		for (const line of entry.keyTaken.slice(0, 5)) console.log(`    ${JSON.stringify(line)}`);
		if (entry.ambiguous.length) {
			console.log(`  Repeated ${table.key} that part lines refer to (left out): ${count(entry.ambiguous.length)}`);
			for (const line of entry.ambiguous.slice(0, 5)) console.log(`    ${JSON.stringify(line)}`);
		}
		console.log(`  Invoice not in the tenant (left out): ${count(entry.noInvoice.length)}`);
		for (const line of entry.noInvoice.slice(0, 5)) console.log(`    ${JSON.stringify(line)}`);
		console.log(`  Replay check: ${count(entry.checked)} imported lines mapped again and compared, ` +
			(entry.mismatches.size ? `differences in ${entry.mismatches.size} column(s):` : "all columns match."));
		for (const [column, seen] of [...entry.mismatches].sort((a, b) => b[1].count - a[1].count)) {
			console.log(`    ${column}: ${count(seen.count)} line(s), e.g. ${JSON.stringify(seen.examples)}`);
		}
		console.log("");
	}
}

const round2 = (value) => (Math.round((Number(value) || 0) * 100) / 100) || 0;
const rate2 = (vat, exVat) => Math.round((vat / exVat) * 100) / 100;

/** One customer_invoice_lines row per job-0 line, as AUTONEER-PWA's POS writes them. */
function displayLines(invoice, parts, labour) {
	const headerRate = Number(invoice.inv_totalexlvat) > 0 ? rate2(Number(invoice.inv_totalvat), Number(invoice.inv_totalexlvat)) : 0.15;
	const line = (type, { stockId = null, partnr = null, description, qty, gross, discount, vat, cost }) => {
		const totalExVat = round2(gross - discount);
		const units = Number.isFinite(qty) && qty !== 0 ? qty : 1;
		return {
			invoice_nr: Number(invoice.invoice_nr), cid: Number(invoice.cid), line_type: type, stock_id: stockId || null,
			partnr: partnr ? String(partnr).trim().slice(0, 70) || null : null,
			description: String(description || partnr || type).trim().slice(0, 254) || type,
			qty: units, unit_price_exvat: round2(gross / units), discount_amount: round2(discount),
			vat_rate: totalExVat > 0 && vat > 0 ? rate2(vat, totalExVat) : headerRate,
			vat_amount: round2(vat), total_exvat: totalExVat, total_incvat: round2(totalExVat + vat), cost_exvat: round2(cost)
		};
	};
	const rows = [];
	// Legacy sales_price is the line total; cost_price is already per unit.
	for (const part of parts) {
		rows.push(line("PART", {
			stockId: Number(part.stock_id) || null, partnr: part.partnr, description: part.spare,
			qty: Number(part.quantity) || 0, gross: Number(part.sales_price) || 0, discount: Number(part.discountamount) || 0,
			vat: Number(part.vat) || 0, cost: Number(part.cost_price) || 0
		}));
	}
	for (const work of labour) {
		const totalExVat = round2((Number(work.workprice) || 0) - (Number(work.discountamount) || 0));
		const incVat = Number(work.workpriceincvat) || 0;
		// Legacy rarely filled workpriceincvat on labour; the invoice's VAT rate applies then.
		const vat = incVat > (Number(work.workprice) || 0) ? round2(incVat - Number(work.workprice)) : round2(totalExVat * headerRate);
		rows.push(line("LABOUR", {
			description: work.description, qty: Number(work.hoursworked) || 0,
			gross: Number(work.workprice) || 0, discount: Number(work.discountamount) || 0, vat, cost: 0
		}));
	}
	return rows;
}

/** General invoices with job-0 lines that still lack customer_invoice_lines; pending adds included. */
async function planDocuments(conn, entries = []) {
	const [invoices] = await conn.query(
		"SELECT invoice_nr, cid, status, invoice_date, posted_at, inv_totalexlvat, inv_totalvat FROM invoices WHERE job_number = 0 AND UPPER(TRIM(COALESCE(status, ''))) IN ('DONE', 'POSTED')"
	);
	const [shown] = await conn.query("SELECT DISTINCT invoice_nr FROM customer_invoice_lines");
	const hasDisplayLines = new Set(shown.map((row) => Number(row.invoice_nr)));
	const [storedParts] = await conn.query("SELECT * FROM spares_used WHERE job_number = 0 AND invoice_nr > 0 ORDER BY spares_id");
	const [storedLabour] = await conn.query("SELECT * FROM work_done WHERE job_number = 0 AND invoice_nr > 0 ORDER BY wdid");
	const pending = (target) => entries.find((entry) => entry.table.target === target)?.add || [];
	const byInvoice = (rows) => {
		const map = new Map();
		for (const row of rows) map.set(Number(row.invoice_nr), [...(map.get(Number(row.invoice_nr)) || []), row]);
		return map;
	};
	const parts = byInvoice([...storedParts, ...pending("spares_used")]);
	const labour = byInvoice([...storedLabour, ...pending("work_done")]);

	const plan = { lines: [], statuses: [], shownAlready: 0, differ: [] };
	for (const invoice of invoices) {
		const nr = Number(invoice.invoice_nr);
		if (!parts.has(nr) && !labour.has(nr)) continue;
		if (hasDisplayLines.has(nr)) {
			plan.shownAlready += 1;
		} else {
			const rows = displayLines(invoice, parts.get(nr) || [], labour.get(nr) || []);
			plan.lines.push(...rows);
			const exVat = round2(rows.reduce((sum, row) => sum + row.total_exvat, 0));
			if (Math.abs(exVat - Number(invoice.inv_totalexlvat)) >= 1) plan.differ.push({ invoice_nr: nr, header_exvat: Number(invoice.inv_totalexlvat), lines_exvat: exVat });
		}
		if (String(invoice.status).trim().toUpperCase() === "DONE") {
			plan.statuses.push({ invoice_nr: nr, status: invoice.status, posted_at: invoice.posted_at, invoice_date: invoice.invoice_date });
		}
	}
	return plan;
}

function reportDocuments(plan) {
	const invoices = new Set(plan.lines.map((row) => row.invoice_nr));
	console.log("customer_invoice_lines and status (what AUTONEER-PWA shows and the GL backfill posts):");
	console.log(`  To add:                 ${count(plan.lines.length)} lines on ${count(invoices.size)} general invoices ` +
		`(${count(plan.lines.filter((row) => row.line_type === "PART").length)} parts, ${count(plan.lines.filter((row) => row.line_type === "LABOUR").length)} labour)`);
	console.log(`  Already shown:          ${count(plan.shownAlready)} invoices`);
	console.log(`  DONE to POSTED:         ${count(plan.statuses.length)} invoices`);
	console.log(`  Lines not adding up to the header ex VAT (by R1 or more): ${count(plan.differ.length)}; they show as legacy recorded them`);
	for (const item of plan.differ.slice(0, 5)) console.log(`    ${JSON.stringify(item)}`);
	console.log("");
}

const DISPLAY_COLUMNS = ["invoice_nr", "cid", "line_type", "stock_id", "partnr", "description", "qty", "unit_price_exvat", "discount_amount", "vat_rate", "vat_amount", "total_exvat", "total_incvat", "cost_exvat"];

async function writeDocuments(conn, plan) {
	const result = { customer_invoice_lines: [], statuses: plan.statuses };
	try {
		const sql = `INSERT INTO customer_invoice_lines (${DISPLAY_COLUMNS.map((col) => `\`${col}\``).join(", ")}) VALUES ?`;
		for (const row of plan.lines) {
			const [inserted] = await conn.query(sql, [[DISPLAY_COLUMNS.map((col) => row[col])]]);
			result.customer_invoice_lines.push(Number(inserted.insertId));
		}
		const done = plan.statuses.map((item) => item.invoice_nr);
		if (done.length) {
			// Job invoices carry their legacy posting date; a general invoice posts on its invoice date.
			await conn.query("UPDATE invoices SET status = 'POSTED', posted_at = COALESCE(posted_at, invoice_date) WHERE job_number = 0 AND status = 'DONE' AND invoice_nr IN (?)", [done]);
		}
	} catch (err) {
		throw err;
	}
	return result;
}

async function insert(conn, entries) {
	const added = {};
	try {
		for (const { table, add, columns } of entries) {
			added[table.target] = [];
			const sql = `INSERT INTO \`${table.target}\` (${columns.map((col) => `\`${col}\``).join(", ")}) VALUES ?`;
			const values = (row) => columns.map((col) => row[col] ?? null);
			const kept = add.filter((row) => row[table.key] != null);
			for (let at = 0; at < kept.length; at += 500) {
				const chunk = kept.slice(at, at + 500);
				await conn.query(sql, [chunk.map(values)]);
				added[table.target].push(...chunk.map((row) => Number(row[table.key])));
			}
			// One at a time, so each line's new id is known for --undo.
			for (const row of add.filter((line) => line[table.key] == null)) {
				const [result] = await conn.query(sql, [[values(row)]]);
				added[table.target].push(Number(result.insertId));
			}
		}
	} catch (err) {
		throw err;
	}
	return added;
}

async function undo(conn, file) {
	const backup = JSON.parse(fs.readFileSync(file, "utf8"));
	if (backup.schema !== schema) throw new Error(`Backup is for ${backup.schema}, not ${schema}; pass --schema ${backup.schema}`);
	await conn.beginTransaction();
	try {
		const shownIds = backup.documents?.customer_invoice_lines || [];
		if (shownIds.length) {
			const [result] = await conn.query("DELETE FROM customer_invoice_lines WHERE id IN (?)", [shownIds]);
			console.log(`customer_invoice_lines: removed ${count(result.affectedRows)} of ${count(shownIds.length)} lines.`);
		}
		for (const item of backup.documents?.statuses || []) {
			await conn.query("UPDATE invoices SET status = ?, posted_at = ? WHERE invoice_nr = ? AND job_number = 0 AND status = 'POSTED'", [item.status, item.posted_at ? new Date(item.posted_at) : null, item.invoice_nr]);
		}
		if (backup.documents?.statuses?.length) console.log(`invoices: put ${count(backup.documents.statuses.length)} back to their legacy status.`);
		for (const table of TABLES) {
			const ids = backup.added?.[table.target] || [];
			if (!ids.length) continue;
			const [result] = await conn.query(`DELETE FROM \`${table.target}\` WHERE job_number = 0 AND \`${table.key}\` IN (?)`, [ids]);
			console.log(`${table.target}: removed ${count(result.affectedRows)} of ${count(ids.length)} lines.`);
		}
		await conn.commit();
	} catch (err) {
		await conn.rollback();
		throw err;
	}
}

async function main() {
	const conn = await connect();
	try {
		if (undoFile) return await undo(conn, undoFile);
		const { database, rows } = await readLegacy();
		const entries = await plan(conn, { rows });
		report(entries, database);
		const documents = await planDocuments(conn, entries);
		reportDocuments(documents);
		const comparable = {
			tables: entries.map(entry => ({ table: entry.table.target, add: entry.add.length, present: entry.present, noInvoice: entry.noInvoice,
				keyTaken: entry.keyTaken, ambiguous: entry.ambiguous, newIds: entry.newIds,
				replay: [...entry.mismatches].map(([column, seen]) => ({ column, count: seen.count, hash: createHash("sha256").update(JSON.stringify(seen.all)).digest("hex") })),
				cost: round2(entry.add.reduce((sum,row)=>sum+Number(row.cost_price||0)*Number(row.quantity||0),0)),
				sales: round2(entry.add.reduce((sum,row)=>sum+Number(row[entry.table.money]||0),0)),
				rowsHash: createHash("sha256").update(JSON.stringify(entry.add)).digest("hex") })),
			posLines: documents.lines.length, posHash: createHash("sha256").update(JSON.stringify(documents.lines)).digest("hex"),
			invoiceIds: documents.statuses.map(row=>row.invoice_nr).sort((a,b)=>a-b), discrepancies: documents.differ
		};
		const auditFile=path.join(__dirname,"..","logs","general-invoice-replay-audit.json");
		if (fs.existsSync(auditFile)) {
			const expected=JSON.parse(fs.readFileSync(auditFile,"utf8")).differences;
			const normalize=rows=>rows.map(({spares_id,job_number,column,mapped,stored})=>({spares_id,job_number,column,mapped,stored})).sort((a,b)=>a.spares_id-b.spares_id||a.column.localeCompare(b.column));
			assert.deepEqual(normalize(entries.flatMap(entry=>[...entry.mismatches.values()].flatMap(seen=>seen.all))),normalize(expected),"Replay differences changed since the reviewed scratch audit");
		}
		if(option("--report")) fs.writeFileSync(option("--report"),JSON.stringify({schema,comparable},null,2));
		if(option("--reference") && (documents.lines.length||documents.statuses.length||entries.some(entry=>entry.add.length))) {
			assert.deepEqual(comparable,JSON.parse(fs.readFileSync(option("--reference"),"utf8")).comparable,"Line dry run differs from the approved scratch reference");
		}
		if (!write) {
			console.log("Dry run: nothing changed. Run again with --write to add the lines.");
			return;
		}
		if (!entries.some((entry) => entry.add.length) && !documents.lines.length && !documents.statuses.length) {
			console.log("Nothing to add.");
			return;
		}
		const file = path.join(__dirname, "..", "logs", `general-invoice-lines-${schema}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
		const backup = { schema, database, at: new Date().toISOString(), added: {} };
		const save = () => fs.writeFileSync(file, JSON.stringify(backup, null, 1));
		await conn.beginTransaction();
		try {
			backup.added = await insert(conn, entries);
			// Both phases are atomic. Save exact generated IDs before committing.
			backup.documents = await writeDocuments(conn, await planDocuments(conn));
			backup.status="PREPARED"; save();
			await conn.commit();
			backup.status="COMMITTED"; save();
		} catch(err) { await conn.rollback(); throw err; }
		for (const table of TABLES) console.log(`${table.target}: added ${count(backup.added[table.target]?.length)} lines.`);
		console.log(`customer_invoice_lines: added ${count(backup.documents.customer_invoice_lines.length)} lines; ${count(backup.documents.statuses.length)} invoices now POSTED.`);
		console.log(`Backup: ${file}\nUndo with: node scripts/backfill_general_invoice_lines.js --undo "${file}"${schema !== state.schemaName ? ` --schema ${schema}` : ""}`);
	} finally {
		await conn.end();
	}
}

if (require.main === module) main().catch((err) => {
	console.error(err.message || err);
	process.exit(1);
});

module.exports = { displayLines };
