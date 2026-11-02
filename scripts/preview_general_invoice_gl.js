"use strict";

// Scratch-only targeted preview. Uses the real Migrate mirror and creates its
// run row first. Seed/run-log writes share ONE transaction and are rolled back.
// DDL, journal writes and all other changes are refused by the query adapter.
// No src edits or PWA changes are needed. Reports are saved only under logs/.
require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const mysql = require("mysql2/promise");
const { state } = require("../src/config/state");

const EXPECTED_COUNT = 290;
const CUTOVER = "2026-10-31";
const SEED_TABLES = ["gl_account_types", "gl_accounts", "gl_control_accounts", "tax_codes", "gl_periods"];
const cents = value => {
	const n = Number(value || 0);
	if (!Number.isFinite(n)) throw new Error("Non-finite journal amount");
	return Math.round(n * 100);
};
const amount = value => (value / 100).toFixed(2);

function assertPreviewSql(sql, schema, allowMigrationCopy = false) {
	if (!/^glbf_test_[a-zA-Z0-9_]+$/.test(schema) && !(allowMigrationCopy && schema === "dm_service_centre")) throw new Error("Preview is restricted to scratch or the explicitly authorized migration copy");
	if (/^\s*(SELECT|SHOW)\b/i.test(sql)) return;
	const match = String(sql).match(/^\s*(?:INSERT(?:\s+IGNORE)?\s+INTO|UPDATE)\s+`?([a-zA-Z0-9_]+)`?\.`?([a-zA-Z0-9_]+)`?(?=\s|\()/i);
	const allowed = [...SEED_TABLES, "gl_backfill_runs", "gl_backfill_run_items"];
	if (!match || match[1] !== schema || !allowed.includes(match[2])) throw new Error(`Preview refused SQL: ${String(sql).slice(0, 160)}`);
}

function inspectJournal(invoice, lines) {
	const net = account => lines.filter(line => Number(line.accnr) === account).reduce((sum, line) => sum + cents(line.debit) - cents(line.credit), 0);
	const issues = [];
	const cost = cents(invoice.parts_cost);
	const subletCost = cents(invoice.sublet_cost);
	const inventoryCost = cost - subletCost;
	if (lines.some(line => Number(line.accnr) === 3250)) issues.push("Contains WIP 3250");
	if (lines.some(line => Number(line.job_number || 0) !== 0 || Number(line.invoice_nr) !== Number(invoice.invoice_nr))) issues.push("References another invoice or job");
	if (lines.some(line => cents(line.debit) < 0 || cents(line.credit) < 0)) issues.push("Negative debit/credit instead of reversing sides");
	if (lines.reduce((sum, line) => sum + cents(line.debit) - cents(line.credit), 0) !== 0) issues.push("Unbalanced journal");
	if (net(3100) !== cents(invoice.inv_totalinclvat)) issues.push("AR differs from invoice header");
	if (-net(5100) !== cents(invoice.inv_totalvat)) issues.push("VAT differs from invoice header");
	if (-net(3200) !== inventoryCost) issues.push(`Inventory credit ${amount(-net(3200))}; signed inventory-part cost ${amount(inventoryCost)}`);
	if (net(6050) !== inventoryCost) issues.push(`COS 6050 debit ${amount(net(6050))}; signed inventory-part cost ${amount(inventoryCost)}`);
	if (-net(3400) !== subletCost) issues.push(`Sublet asset credit ${amount(-net(3400))}; signed sublet cost ${amount(subletCost)}`);
	if (net(6300) !== subletCost) issues.push(`Sublet COS debit ${amount(net(6300))}; signed sublet cost ${amount(subletCost)}`);
	return issues;
}

async function main() {
	const args = process.argv.slice(2);
	if (args.length !== 2 || args[0] !== "--schema" || !/^(glbf_test_[a-zA-Z0-9_]+|dm_service_centre)$/.test(args[1])) throw new Error("Usage: node scripts/preview_general_invoice_gl.js --schema <migration-copy-or-scratch>");
	const schema = args[1];
	const logs = path.join(__dirname, "..", "logs");
	// Only a completed line-write backup for this exact scratch schema qualifies.
	const files = fs.readdirSync(logs).filter(name => name.startsWith(`general-invoice-lines-${schema}-`) && name.endsWith(".json")).sort();
	const backupFile = files.at(-1);
	if (!backupFile) throw new Error("No line-repair backup for this scratch schema");
	const backup = JSON.parse(fs.readFileSync(path.join(logs, backupFile), "utf8"));
	assert.equal(backup.schema, schema);
	const ids = backup.documents?.statuses?.map(row => Number(row.invoice_nr)) || [];
	assert.equal(ids.length, EXPECTED_COUNT, "Backup must identify exactly 290 repaired invoices");
	assert.equal(new Set(ids).size, EXPECTED_COUNT);
	assert.ok(ids.every(id => Number.isSafeInteger(id) && id > 0));

	const conn = await mysql.createConnection({ ...state.mysql, database: schema, dateStrings: true });
	const writes = {};
	const bound = {
		query: async (sql, params = []) => {
			assertPreviewSql(sql, schema, true);
			if (!/^\s*(SELECT|SHOW)\b/i.test(sql)) {
				const table = String(sql).match(/\.`?([a-zA-Z0-9_]+)/)[1];
				writes[table] = (writes[table] || 0) + 1;
			}
			return conn.query(sql, params);
		},
		getConnection: async () => { throw new Error("Unexpected nested transaction in preview"); }
	};
	const database = require("../src/migrate/gl/glBackfill/mirror/database/database");
	const engine = require("../src/migrate/gl/glBackfill/mirror/lib/finance/postingEngine");
	const original = { validateLines: engine.validateLines, postJournal: engine.postJournal, deleteGlJournalBySource: engine.deleteGlJournalBySource };
	const captured = new Map();
	const selection = new Set(ids);
	engine.validateLines = (lines, ...rest) => {
		const nr = Number(lines[0]?.invoice_nr);
		assert.ok(selection.has(nr), `Unexpected invoice ${nr}`);
		assert.ok(!captured.has(nr), `Invoice ${nr} built twice`);
		captured.set(nr, JSON.parse(JSON.stringify(lines)));
		return original.validateLines(lines, ...rest);
	};
	engine.postJournal = async () => { throw new Error("Preview must never post a journal"); };
	engine.deleteGlJournalBySource = async () => { throw new Error("Preview must never delete a journal"); };
	// Must load AFTER the collector is installed: the mirror destructures it.
	const mirror = require("../src/migrate/gl/glBackfill/mirror/lib/finance/glBackfill");
	const report = { schema, lineBackup: backupFile, cutover: CUTOVER, mode: "ROLLED_BACK_GL_PREVIEW", targetIds: ids.sort((a, b) => a - b) };
	try {
		await conn.query("START TRANSACTION WITH CONSISTENT SNAPSHOT");
		await database.withPool(bound, async () => {
			const query = async (sql, params = []) => (await bound.query(sql, params))[0];
			assert.equal((await query(`SELECT id FROM ${schema}.gl_backfill_runs WHERE status='RUNNING'`)).length, 0, "A backfill is already running");
			for (const [table, key, keys, expected] of [
				["spares_used", "spares_id", backup.added.spares_used, 479],
				["work_done", "wdid", backup.added.work_done, 11],
				["customer_invoice_lines", "id", backup.documents.customer_invoice_lines, 490]
			]) {
				assert.equal(keys.length, expected);
				const [row] = await query(`SELECT COUNT(*) n FROM ${schema}.${table} WHERE ${key} IN (?)`, [keys]);
				assert.equal(Number(row.n), expected, `Backup rows missing in ${table}`);
			}
			const invoices = await query(`SELECT i.invoice_nr,i.job_number,i.status,i.invoice_date,i.posted_at,i.inv_totalinclvat,i.inv_totalexlvat,i.inv_totalvat,
				(SELECT COALESCE(SUM(ROUND(p.cost_price*p.quantity,2)),0) FROM ${schema}.spares_used p WHERE p.job_number=0 AND p.invoice_nr=i.invoice_nr) parts_cost,
				(SELECT COALESCE(SUM(ROUND(p.cost_price*p.quantity,2)),0) FROM ${schema}.spares_used p WHERE p.job_number=0 AND p.invoice_nr=i.invoice_nr AND p.siid=6300 AND p.accasset=3400) sublet_cost
				FROM ${schema}.invoices i WHERE i.invoice_nr IN (?) ORDER BY i.invoice_nr`, [ids]);
			assert.equal(invoices.length, EXPECTED_COUNT);
			for (const inv of invoices) {
				assert.equal(Number(inv.job_number), 0);
				assert.equal(inv.status, "POSTED");
				assert.equal(String(inv.posted_at).slice(0, 10), inv.invoice_date);
				assert.ok(inv.invoice_date < CUTOVER);
			}
			const existing = await query(`SELECT id,source,source_id FROM ${schema}.gl_journal_headers WHERE source IN ('DEBTOR_INVOICE','DEBTOR_INVOICE_CREDIT') AND source_id IN (?)`, [ids.map(String)]);
			assert.equal(existing.length, 0, "This initial preview expects unposted target invoices");
			const seedBefore = {};
			for (const table of SEED_TABLES) seedBefore[table] = await query(`SELECT * FROM ${schema}.${table} ORDER BY id`);
			report.baseline = await query(`SELECT l.accnr,SUM(l.debit-l.credit) balance FROM ${schema}.gl_journal_headers h JOIN ${schema}.gl_journal_lines l ON l.header_id=h.id WHERE h.status='POSTED' AND h.trxdate<=? AND l.accnr IN (3200,3250,4900) GROUP BY l.accnr`, [CUTOVER]);
			const dates = invoices.map(row => row.invoice_date).sort();
			const options = { companyDb: schema, schema, staffId: 0, fromDate: dates[0], toDate: dates.at(-1), types: ["DEBTOR_INVOICE"], dryRun: true };
			report.runId = await mirror.createRun(options);
			assert.ok(report.runId);
			await mirror.runBackfillJob({ ...options, runId: report.runId, targetedSourceIds: { DEBTOR_INVOICE: ids } });
			const [run] = await query(`SELECT status,summary_json FROM ${schema}.gl_backfill_runs WHERE id=?`, [report.runId]);
			report.run = run;
			report.items = await query(`SELECT source_id,status,message FROM ${schema}.gl_backfill_run_items WHERE run_id=? ORDER BY id`, [report.runId]);
			report.seedChanges = [];
			for (const table of SEED_TABLES) if (JSON.stringify(seedBefore[table]) !== JSON.stringify(await query(`SELECT * FROM ${schema}.${table} ORDER BY id`))) report.seedChanges.push(table);
			report.journals = invoices.map(inv => ({ invoice_nr: inv.invoice_nr, date: inv.invoice_date, signedPartsCost: inv.parts_cost, subletCost: inv.sublet_cost, lines: captured.get(Number(inv.invoice_nr)) || [], issues: captured.has(Number(inv.invoice_nr)) ? inspectJournal(inv, captured.get(Number(inv.invoice_nr))) : ["Journal was not built"] }));
			const accounts = new Map();
			for (const journal of report.journals) for (const line of journal.lines) {
				const accnr = Number(line.accnr);
				const sum = accounts.get(accnr) || { accnr, debit: 0, credit: 0 };
				sum.debit += cents(line.debit); sum.credit += cents(line.credit); accounts.set(accnr, sum);
			}
			report.accounts = [...accounts.values()].sort((a, b) => a.accnr - b.accnr).map(row => ({ accnr: row.accnr, debit: amount(row.debit), credit: amount(row.credit), netDebit: amount(row.debit-row.credit) }));
			const inventory = accounts.get(3200) || { debit: 0, credit: 0 };
			report.proposedClearing = { date: CUTOVER, debitAccount: 3200, creditAccount: 4900, amount: amount(inventory.credit-inventory.debit), posted: false };
			report.signedPartsCost = amount(invoices.reduce((sum, row) => sum + cents(row.parts_cost), 0));
			report.subletCost = amount(invoices.reduce((sum, row) => sum + cents(row.sublet_cost), 0));
			report.captured = captured.size;
			report.issues = report.journals.filter(journal => journal.issues.length).map(({ invoice_nr, issues }) => ({ invoice_nr, issues }));
			report.ready = run.status === "DONE" && report.items.length === EXPECTED_COUNT && report.items.every(item => item.status === "SKIPPED" && item.message === "Dry run - would post") && report.issues.length === 0 && report.seedChanges.length === 0;
		});
	} finally {
		try { await conn.rollback(); } finally { await conn.end(); Object.assign(engine, original); }
	}
	const file = path.join(logs, `general-invoice-gl-preview-${schema}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
	fs.writeFileSync(file, JSON.stringify(report, null, 2));
	console.log(`Built ${report.captured}/${EXPECTED_COUNT} targeted general-invoice journals.`);
	console.table(report.accounts);
	console.log(`Signed source parts cost: ${report.signedPartsCost}`);
	console.log(`Included service/sublet cost retained on 6300 / 3400: ${report.subletCost}`);
	console.log(`Proposed cut-over clearing: Dr 3200 / Cr 4900 ${report.proposedClearing.amount} (NOT POSTED)`);
	console.log(`Journals needing review: ${report.issues.length}; seed tables changed during preview: ${report.seedChanges.join(", ") || "none"}`);
	for (const item of report.issues) console.log(`Invoice ${item.invoice_nr}: ${item.issues.join("; ")}`);
	console.log(`Preview status: ${report.ready ? "PASS" : "REVIEW REQUIRED"}`);
	console.log(`Report: ${file}`);
	console.log("Transaction rolled back: no journals, run rows or seed changes retained. Auto-increment counters may advance.");
	if (!report.ready) process.exitCode = 2;
}

if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
module.exports = { assertPreviewSql, inspectJournal };
