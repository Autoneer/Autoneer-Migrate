"use strict";

// Prepare only the tables needed for the general-invoice repair rehearsal.
// Default: read-only preflight. --create: create a NEW scratch schema and verify
// its contents. --resume checks an interrupted copy; --resume --create continues
// only after existing rows match both the manifest and a fresh source snapshot.
// Never posts a journal or modifies the source tenant.
// CREATE TABLE LIKE deliberately excludes triggers, routines and foreign keys;
// this is a data/repair rehearsal, not a full PWA integration environment.
require("dotenv").config();
const mysql = require("mysql2/promise");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { state } = require("../src/config/state");

const SOURCE = "dm_service_centre";
const TARGET = "glbf_test_general_invoices_20261102";
const REQUIRED = [
	"migration_run_mappings", "accounts", "spares_used", "work_done",
	"invoices", "customer_invoice_lines", "job_information", "stock",
	"gl_account_types", "gl_accounts", "gl_control_accounts", "gl_periods",
	"tax_codes", "gl_journal_headers", "gl_journal_lines",
	"gl_backfill_runs", "gl_backfill_run_items", "company_prefferences",
	"customers", "invoice_adjustments", "manual_journal_headers", "manual_journal_lines",
	"stock_takes", "stock_take"
];
const OPTIONAL = ["customer_credits", "dealer_accounting_postings", "banks"];
const quote = name => {
	if (!/^[a-zA-Z0-9_]+$/.test(name)) throw new Error("Invalid identifier");
	return `\`${name}\``;
};
const qualified = (schema, table) => `${quote(schema)}.${quote(table)}`;
const reportPath = path.join(__dirname, "..", "logs", `${TARGET}-copy.json`);

function copySqlMode(mode) {
	// Preserve legacy zero dates on THIS scratch-writing connection only. Keep
	// strict type/truncation checks and never change global or source settings.
	const modes = String(mode).split(",").map(value => value.trim().toUpperCase()).filter(Boolean);
	return [...new Set([...modes.filter(value => !["NO_ZERO_DATE", "NO_ZERO_IN_DATE"].includes(value)), "NO_AUTO_VALUE_ON_ZERO"])].join(",");
}

function sameFingerprint(a, b) {
	return a.count === b.count && a.checksum === b.checksum;
}

// Order-independent 256-bit sum of SHA-256 row hashes, with an exact row count.
// All selected columns participate; generated columns are checked separately by
// the database's generated expressions rather than explicitly inserted.
async function scan(conn, schema, table, columns, onBatch) {
	const checksum = Buffer.alloc(32);
	let count = 0;
	let batch = [];
	const stream = conn.connection.query(
		`SELECT ${columns.map(quote).join(",")} FROM ${qualified(schema, table)}`
	).stream({ highWaterMark: 500 });
	for await (const row of stream) {
		const values = columns.map(column => row[column]);
		const digest = createHash("sha256").update(JSON.stringify(values)).digest();
		let carry = 0;
		for (let i = 31; i >= 0; i--) {
			const sum = checksum[i] + digest[i] + carry;
			checksum[i] = sum & 255;
			carry = sum >>> 8;
		}
		count++;
		if (onBatch) {
			batch.push(values);
			if (batch.length === 500) { await onBatch(batch); batch = []; }
		}
	}
	if (onBatch && batch.length) await onBatch(batch);
	return { count, checksum: checksum.toString("hex") };
}

async function main() {
	const args = process.argv.slice(2);
	if (args.some(arg => !["--create", "--resume"].includes(arg)) || new Set(args).size !== args.length) throw new Error("Usage: node scripts/general_invoice_scratch.js [--resume] [--create]");
	const create = args.includes("--create");
	const resume = args.includes("--resume");
	if (!TARGET.startsWith("glbf_test_") || TARGET === SOURCE) throw new Error("Unsafe scratch target");
	const config = { ...state.mysql, database: SOURCE, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true };
	const source = await mysql.createConnection(config);
	let destination;
	try {
		await source.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
		await source.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
		const [existing] = await source.query("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", [TARGET]);
		if (existing.length && !resume) throw new Error(`${TARGET} already exists; refusing to overwrite it. Use --resume for a read-only continuation check.`);
		if (!existing.length && resume) throw new Error("No scratch database to resume.");
		const [running] = await source.query(`SELECT id FROM ${qualified(SOURCE, "gl_backfill_runs")} WHERE status='RUNNING'`);
		if (running.length) throw new Error(`Source has RUNNING backfill(s): ${running.map(row => row.id).join(", ")}`);
		const [available] = await source.query("SELECT TABLE_NAME name, ENGINE engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE'", [SOURCE]);
		const tables = new Map(available.map(row => [row.name, row.engine]));
		for (const name of REQUIRED) if (!tables.has(name)) throw new Error(`Missing source table ${name}`);
		const selected = [...REQUIRED, ...OPTIONAL.filter(name => tables.has(name))];
		const plan = [];
		for (const table of selected) {
			if (tables.get(table) !== "InnoDB") throw new Error(`${table} is not InnoDB; cannot guarantee snapshot consistency`);
			const [metadata] = await source.query(`SHOW COLUMNS FROM ${qualified(SOURCE, table)}`);
			const columns = metadata.filter(row => !/VIRTUAL GENERATED|STORED GENERATED/i.test(row.Extra)).map(row => row.Field);
			const generated = metadata.filter(row => !columns.includes(row.Field)).map(row => row.Field);
			const [[{ n }]] = await source.query(`SELECT COUNT(*) n FROM ${qualified(SOURCE, table)}`);
			plan.push({ table, columns, generated, count: Number(n) });
		}
		let manifest;
		const completed = new Set();
		const existingTables = new Set();
		if (resume) {
			manifest = JSON.parse(fs.readFileSync(reportPath, "utf8"));
			if (manifest.source !== SOURCE || manifest.target !== TARGET || manifest.status !== "CREATING" || !Array.isArray(manifest.tables)) throw new Error("Manifest is not an interrupted copy for this source/target.");
			const [present] = await source.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=?", [TARGET]);
			for (const { name } of present) {
				if (!selected.includes(name)) throw new Error(`Unexpected scratch table: ${name}`);
				existingTables.add(name);
			}
			const [[{ n: triggers }]] = await source.query("SELECT COUNT(*) n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=?", [TARGET]);
			if (Number(triggers)) throw new Error("Unexpected scratch triggers");
			for (const saved of manifest.tables) {
				if (!existingTables.has(saved.table) || completed.has(saved.table)) throw new Error(`Invalid manifest table: ${saved.table}`);
				const item = plan.find(row => row.table === saved.table);
				if (JSON.stringify(saved.columns) !== JSON.stringify(item.columns)) throw new Error(`Source columns changed: ${saved.table}`);
				const sourceHash = await scan(source, SOURCE, saved.table, item.columns);
				const scratchHash = await scan(source, TARGET, saved.table, item.columns);
				if (!sameFingerprint(saved, sourceHash) || !sameFingerprint(saved, scratchHash)) throw new Error(`Source or scratch changed since copy: ${saved.table}`);
				completed.add(saved.table);
				console.log(`RESUME VERIFIED ${saved.table}: ${sourceHash.count}`);
			}
			for (const table of existingTables) {
				if (completed.has(table)) continue;
				const [[{ n }]] = await source.query(`SELECT COUNT(*) n FROM ${qualified(TARGET, table)}`);
				if (Number(n)) throw new Error(`Unverified scratch table is not empty: ${table}`);
				const [actual] = await source.query(`SHOW COLUMNS FROM ${qualified(TARGET, table)}`);
				const [expected] = await source.query(`SHOW COLUMNS FROM ${qualified(SOURCE, table)}`);
				if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Scratch structure differs: ${table}`);
				console.log(`RESUME EMPTY ${table}: safe to copy`);
			}
		}
		console.log(`${SOURCE} -> ${TARGET}`);
		console.log(`${plan.length} tables, ${plan.reduce((sum, row) => sum + row.count, 0)} rows; source connection is READ ONLY.`);
		for (const item of plan) console.log(`${item.table}: ${item.count}${item.generated.length ? `; skip generated: ${item.generated.join(", ")}` : ""}`);
		if (!create) {
			console.log(`PREFLIGHT PASSED. No database changes. Use ${resume ? "--resume --create" : "--create"} to ${resume ? "continue" : "create"} and verify the scratch copy.`);
			return;
		}
		if (!resume && fs.existsSync(reportPath)) throw new Error(`Copy manifest already exists: ${reportPath}`);
		manifest = manifest || { source: SOURCE, target: TARGET, createdAt: new Date().toISOString(), status: "CREATING", tables: [] };
		const save = () => fs.writeFileSync(reportPath, JSON.stringify(manifest, null, 2));
		save();
		destination = await mysql.createConnection(config);
		const [[{ sql_mode: mode }]] = await destination.query("SELECT @@session.sql_mode sql_mode");
		await destination.query("SET SESSION sql_mode = ?", [copySqlMode(mode)]);
		const [[defaults]] = await source.query("SELECT DEFAULT_CHARACTER_SET_NAME charset, DEFAULT_COLLATION_NAME collation FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", [SOURCE]);
		if (!resume) await destination.query(`CREATE DATABASE ${quote(TARGET)} CHARACTER SET ${quote(defaults.charset)} COLLATE ${quote(defaults.collation)}`);
		// A separate connection performs DDL and scratch inserts so the source
		// read-only consistent snapshot is never implicitly committed by DDL.
		for (const item of plan) {
			if (completed.has(item.table)) continue;
			if (!existingTables.has(item.table)) await destination.query(`CREATE TABLE ${qualified(TARGET, item.table)} LIKE ${qualified(SOURCE, item.table)}`);
			await destination.beginTransaction();
			let copied;
			try {
				copied = await scan(source, SOURCE, item.table, item.columns, async rows => {
					// mysql2 returns JSON columns as objects. Serialize them explicitly
					// so the bulk formatter does not treat them as SQL assignments.
					const values = rows.map(row => row.map(value => value !== null && typeof value === "object" && !Buffer.isBuffer(value) ? JSON.stringify(value) : value));
					await destination.query(`INSERT INTO ${qualified(TARGET, item.table)} (${item.columns.map(quote).join(",")}) VALUES ?`, [values]);
				});
				await destination.commit();
			} catch (error) { await destination.rollback(); throw error; }
			const verified = await scan(destination, TARGET, item.table, item.columns);
			if (copied.count !== item.count || JSON.stringify(copied) !== JSON.stringify(verified)) throw new Error(`Copy mismatch: ${item.table}`);
			manifest.tables.push({ ...item, ...copied });
			save();
			console.log(`VERIFIED ${item.table}: ${copied.count}`);
		}
		const [[{ n: triggers }]] = await destination.query("SELECT COUNT(*) n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=?", [TARGET]);
		if (Number(triggers)) throw new Error("Unexpected scratch triggers");
		manifest.status = "VERIFIED";
		save();
		console.log(`SCRATCH COPY VERIFIED: ${TARGET}`);
		console.log(`Manifest: ${reportPath}`);
		console.log("No repair or posting has run. Keep this copy for the rehearsal; remove it after the undo checks.");
	} finally {
		await source.rollback();
		await source.end();
		if (destination) await destination.end();
	}
}

if (require.main === module) main().catch(error => { console.error(`${error.code || "ERROR"}: ${error.message}`); process.exitCode = 1; });
module.exports = { copySqlMode, sameFingerprint };
