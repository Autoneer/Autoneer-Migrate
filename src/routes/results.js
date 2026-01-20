const express = require("express");
const mysql = require("../db/mysql");
const firebird = require("../db/firebird");
const runStore = require("../migrate/runStore");
const { state } = require("../config/state");
const { stringify } = require("csv-stringify/sync");

const router = express.Router();

router.get("/results/:runId", async (req, res) => {
	const runId = req.params.runId;
	try {
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);
		const run = await runStore.getRun(pool, runId);
		let tables = await runStore.getRunTables(pool, runId);
		tables = tables.slice().sort((a, b) => String(a.table_name || "").localeCompare(String(b.table_name || "")));
		let rawErrors = await runStore.getRowErrors(pool, runId);
		rawErrors = rawErrors.slice().sort((a, b) => {
			const tableCompare = String(a.table_name || "").localeCompare(String(b.table_name || ""));
			if (tableCompare !== 0) return tableCompare;
			return Number(a.row_offset || 0) - Number(b.row_offset || 0);
		});
		const errors = rawErrors.map((err) => ({
			...err,
			// normalize legacy/new fields
			error_message: err.error_message || err.message || null,
			row_offset: err.row_offset ?? null,
			hint: err.hint || null,
			row_json: err.row_json || null
		}));
		const errorsByTable = errors.reduce((acc, err) => {
			const key = err.table_name || "unknown";
			if (!acc[key]) acc[key] = [];
			acc[key].push(err);
			return acc;
		}, {});

		const columnCache = new Map();
		const getColumns = async (table) => {
			if (columnCache.has(table)) return columnCache.get(table);
			const cols = await mysql.listColumns(pool, table);
			const names = cols.map((c) => c.name.toLowerCase());
			columnCache.set(table, names);
			return names;
		};

		const validations = [];
		const samples = [];
		const checks = [
			{
				name: "invoices.cid -> customers.cid",
				table: "invoices",
				refTable: "customers",
				column: "cid",
				refColumn: "cid"
			},
			{
				name: "job_information.cid -> customers.cid",
				table: "job_information",
				refTable: "customers",
				column: "cid",
				refColumn: "cid"
			},
			{
				name: "invoice_items.stock_id -> stock.stock_id",
				table: "invoice_items",
				refTable: "stock",
				column: "stock_id",
				refColumn: "stock_id"
			}
		];

		for (const check of checks) {
			const cols = await getColumns(check.table);
			const refCols = await getColumns(check.refTable);
			if (cols.includes(check.column) && refCols.includes(check.refColumn)) {
				const [rows] = await pool.query(
					`select count(*) as cnt from \`${check.table}\` t left join \`${check.refTable}\` r on t.\`${check.column}\` = r.\`${check.refColumn}\` where t.\`${check.column}\` is not null and r.\`${check.refColumn}\` is null`
				);
				validations.push({ name: check.name, orphans: rows[0].cnt });
			}
		}

		try {
			const fbInvoice = await firebird.query(state.firebird, "select sum(INV_TOTALINCLVAT) as total from INVOICES");
			const [myInvoice] = await pool.query("select sum(inv_totalinclvat) as total from invoices");
			samples.push({
				name: "Invoice totals (sum inv_totalinclvat)",
				firebird: fbInvoice?.[0]?.total || 0,
				mysql: myInvoice?.[0]?.total || 0
			});
		} catch (err) {
			// optional
		}

		try {
			const fbTop = await firebird.query(
				state.firebird,
				"select first 10 name, balance from customers order by balance desc"
			);
			const [myTop] = await pool.query(
				"select name, balance from customers order by balance desc limit 10"
			);
			samples.push({
				name: "Top 10 customers by balance",
				firebirdTop: fbTop,
				mysqlTop: myTop
			});
		} catch (err) {
			// optional
		}
		await pool.end();

		validations.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
		samples.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
		res.render("results", { run, tables, errors, errorsByTable, validations, samples, currentStep: "results" });
	} catch (err) {
		res.render("results", { error: err.message, run: null, tables: [], errors: [], errorsByTable: {}, validations: [], samples: [], currentStep: "results" });
	}
});


router.get("/results/:runId/logs.json", async (req, res) => {
	const runId = req.params.runId;
	const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
	const tables = await runStore.getRunTables(pool, runId);
	const rawErrors = await runStore.getRowErrors(pool, runId);
	const errors = rawErrors.map((err) => ({
		...err,
		error_message: err.error_message || err.message || null
	}));
	await pool.end();
	res.setHeader("Content-Type", "application/json");
	res.send(JSON.stringify({ tables, errors }, null, 2));
});

router.get("/results/:runId/logs.csv", async (req, res) => {
	const runId = req.params.runId;
	const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
	const rawErrors = await runStore.getRowErrors(pool, runId);
	const errors = rawErrors.map((err) => ({
		...err,
		error_message: err.error_message || err.message || null
	}));
	await pool.end();
	const csv = stringify(errors, { header: true });
	res.setHeader("Content-Type", "text/csv");
	res.setHeader("Content-Disposition", "attachment; filename=migration-errors.csv");
	res.send(csv);
});

module.exports = router;
