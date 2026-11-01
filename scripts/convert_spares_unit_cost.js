// Converts job part costs that were imported before the import stored them per
// unit (src/migrate/sparesUnitCost.js): legacy SPARES_USED.COST_PRICE is a line
// total, and AUTONEER-PWA reads spares_used.cost_price per unit.
//
//   node scripts/convert_spares_unit_cost.js                   dry run: what would change
//   node scripts/convert_spares_unit_cost.js --write           convert, with a backup in logs/
//   node scripts/convert_spares_unit_cost.js --undo <backup>   put the backed-up costs back
//
// Connects with the .env settings (MYSQL_*, FIREBIRD_*); --schema <name> picks
// another tenant. A line is converted only while it still holds its legacy
// cost, so a second run changes nothing. Afterwards, run the GL backfill again
// for customer invoices with "Delete existing journals in this range first".

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const firebird = require("../src/db/firebird");
const { state } = require("../src/config/state");
const sparesUnitCost = require("../src/migrate/sparesUnitCost");

const args = process.argv.slice(2);
const option = (name) => {
	const at = args.indexOf(name);
	return at === -1 ? null : args[at + 1];
};
const write = args.includes("--write");
const undoFile = option("--undo");
const schema = option("--schema") || state.schemaName;

const money = (value) => Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const count = (value) => Number(value || 0).toLocaleString();
const round2 = (value) => Math.round(value * 100) / 100;

async function readLegacy() {
	const config = firebird.resolveFirebirdConfig(state.firebird);
	const problem = firebird.validateFirebirdConfig(config);
	if (problem) throw new Error(`Legacy database: ${problem}`);
	const db = await firebird.attachWithRetry(config);
	try {
		const rows = await firebird.queryWithDb(db, "SELECT SPARES_ID, JOB_NR, QUANTITY, COST_PRICE, MARKUP, SALES_PRICE FROM SPARES_USED");
		const legacy = new Map();
		for (const row of rows) {
			legacy.set(Number(row.spares_id), {
				job_number: row.job_nr, quantity: row.quantity, cost_price: row.cost_price, markup: row.markup, sales_price: row.sales_price
			});
		}
		return { database: path.basename(String(config.database).replace(/\\/g, "/")), legacy };
	} finally {
		db.detach();
	}
}

function connect() {
	return mysql.createConnection({
		host: state.mysql.host, port: Number(state.mysql.port || 3306), user: state.mysql.user, password: state.mysql.password, database: schema
	});
}

function report(plan, database, targetRows) {
	const before = plan.convert.reduce((sum, line) => sum + line.before * line.quantity, 0);
	const after = plan.convert.reduce((sum, line) => sum + line.after * line.quantity, 0);
	const drift = plan.convert.reduce((max, line) => Math.max(max, Math.abs(round2(line.after * line.quantity) - round2(line.before))), 0);
	console.log(`Tenant ${schema}, legacy database ${database}: ${count(targetRows)} job part lines.\n`);
	console.log(`To convert:            ${count(plan.convert.length)} lines on ${count(new Set(plan.convert.map((l) => l.job_number)).size)} jobs ` +
		`(${count(plan.convert.filter((l) => l.invoice_nr > 0).length)} invoiced)`);
	console.log(`  cost × quantity now: ${money(before)}`);
	console.log(`  after:               ${money(after)}  (${money(after - before)})`);
	console.log(`  largest rounding difference against the line total: ${money(drift)}`);
	console.log(`Already per unit:      ${count(plan.converted)}`);
	console.log(`Legacy unit costs kept: ${count(plan.keptUnitCost.length)}`);
	console.log(`Edited since import:   ${count(plan.edited.length)} (left alone)`);
	console.log(`Quantity 0 or 1, or no cost: ${count(plan.unchanged)}`);
	console.log(`Not in the legacy data: ${count(plan.notLegacy)}; legacy id on another job: ${count(plan.otherJob)}`);

	const largest = [...plan.convert].sort((a, b) => (b.before * b.quantity - b.before) - (a.before * a.quantity - a.before)).slice(0, 10);
	if (largest.length) {
		console.log("\nLargest conversions:");
		console.table(largest.map((l) => ({ spares_id: l.spares_id, job: l.job_number, invoice: l.invoice_nr, qty: l.quantity, cost: l.before, unit_cost: l.after, "cost × qty was": round2(l.before * l.quantity) })));
	}
	if (plan.keptUnitCost.length) {
		console.log("\nKept: their cost is already per unit (cost × quantity, marked up, is the sale):");
		console.table(plan.keptUnitCost.map((l) => ({ spares_id: l.spares_id, job: l.job_number, invoice: l.invoice_nr, qty: l.quantity, cost: l.cost, markup: l.markup, sale: l.sale })));
	}
	if (plan.edited.length) {
		console.log("\nEdited since import, left alone:");
		console.table(plan.edited.slice(0, 20));
	}
}

async function convert() {
	const { database, legacy } = await readLegacy();
	const conn = await connect();
	try {
		const [targetRows] = await conn.query("SELECT spares_id, job_number, invoice_nr, quantity, cost_price FROM spares_used");
		const plan = sparesUnitCost.planRepair(targetRows, legacy);
		report(plan, database, targetRows.length);
		if (!write) {
			console.log("\nDry run: nothing was changed. Add --write to convert.");
			return;
		}
		if (!plan.convert.length) {
			console.log("\nNothing to convert.");
			return;
		}
		const backup = path.join(__dirname, "..", "logs", `spares-unit-cost-${schema}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
		fs.mkdirSync(path.dirname(backup), { recursive: true });
		fs.writeFileSync(backup, JSON.stringify({
			schema, legacyDatabase: database, createdAt: new Date().toISOString(),
			columns: ["spares_id", "before", "after"], lines: plan.convert.map((l) => [l.spares_id, l.before, l.after])
		}));
		await conn.beginTransaction();
		try {
			for (const line of plan.convert) {
				const [result] = await conn.query(
					"UPDATE spares_used SET cost_price = ? WHERE spares_id = ? AND job_number = ? AND quantity = ? AND ABS(cost_price - ?) < 0.0000005",
					[line.after, line.spares_id, line.job_number, line.quantity, line.before]
				);
				if (result.affectedRows !== 1) throw new Error(`Line ${line.spares_id} changed while converting. Nothing was saved; run it again.`);
			}
			await conn.commit();
		} catch (err) {
			await conn.rollback();
			throw err;
		}
		console.log(`\nConverted ${count(plan.convert.length)} lines. Backup: ${backup}`);
		console.log("Next: run the GL backfill again for Customer invoices with \"Delete existing journals in this range first\", then Validate GL.");
	} finally {
		await conn.end();
	}
}

async function undo() {
	const backup = JSON.parse(fs.readFileSync(undoFile, "utf8"));
	if (backup.schema !== schema) throw new Error(`The backup is for ${backup.schema}, not ${schema}. Add --schema ${backup.schema}.`);
	const conn = await connect();
	let restored = 0;
	try {
		await conn.beginTransaction();
		for (const [sparesId, before, after] of backup.lines) {
			const [result] = await conn.query(
				"UPDATE spares_used SET cost_price = ? WHERE spares_id = ? AND ABS(cost_price - ?) < 0.0000005",
				[before, sparesId, after]
			);
			restored += result.affectedRows;
		}
		await conn.commit();
	} catch (err) {
		await conn.rollback();
		throw err;
	} finally {
		await conn.end();
	}
	console.log(`Restored ${count(restored)} of ${count(backup.lines.length)} lines; the others have changed since.`);
}

(undoFile ? undo() : convert()).catch((err) => {
	console.error(err.message);
	process.exit(1);
});
