const express = require("express");
const firebird = require("../db/firebird");
const { state } = require("../config/state");
const migrationPlan = require("../migrate/migrationPlan");
const mysql = require("../db/mysql");

const router = express.Router();

router.get("/plan", async (req, res) => {
	try {
		if (!state.mapping) {
			state.mapping = migrationPlan.loadDefaultMapping();
		}

		const fbTables = (await firebird.listTables(state.firebird))
			.slice()
			.sort((a, b) => a.localeCompare(b));

		const expectedMySqlTables = migrationPlan.getExpectedTablesFromDDL()
			.slice()
			.sort((a, b) => a.localeCompare(b));
		const maxLen = Math.max(fbTables.length, expectedMySqlTables.length);
		const schemaPairs = Array.from({ length: maxLen }).map((_, index) => ({
			firebird: fbTables[index] || "",
			firebirdCount: fbTables[index] ? "—" : "",
			mysql: expectedMySqlTables[index] || ""
		}));
		let plan = migrationPlan.buildPlan({
			firebirdTables: fbTables,
			mysqlTables: expectedMySqlTables,
			mapping: state.mapping
		});

		plan = plan.slice().sort((a, b) => a.table.localeCompare(b.table));

		if (Array.isArray(state.plan) && state.plan.length) {
			const previousByTable = new Map(state.plan.map((p) => [p.table.toLowerCase(), p]));
			plan = plan.map((step) => {
				const previous = previousByTable.get(step.table.toLowerCase());
				if (!previous) return step;
				return {
					...step,
					include: previous.include,
					mode: previous.mode || step.mode,
					keyStrategy: previous.keyStrategy || step.keyStrategy,
					dedupeKeys: Array.isArray(previous.dedupeKeys) ? previous.dedupeKeys : [],
					onDuplicate: previous.onDuplicate || step.onDuplicate
				};
			});
		}

		const columnsByTable = new Map();
		try {
			const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
			await mysql.ensureMigrationTables(pool);
			for (const step of plan) {
				const cols = await mysql.listColumns(pool, step.table);
				const sorted = cols.map((c) => c.name).sort((a, b) => a.localeCompare(b));
				columnsByTable.set(step.table.toLowerCase(), sorted);
			}
			await pool.end();
		} catch (err) {
			// ignore column discovery issues
		}

		plan = plan.map((step) => ({
			...step,
			availableColumns: columnsByTable.get(step.table.toLowerCase()) || [],
			dedupeKeys: Array.isArray(step.dedupeKeys) ? step.dedupeKeys : []
		}));

		state.plan = plan;

		res.render("plan", {
			firebirdTables: fbTables,
			expectedMySqlTables,
			schemaPairs,
			plan,
			currentStep: "plan"
		});
	} catch (err) {
		res.render("plan", { error: err.message, plan: state.plan || [], currentStep: "plan" });
	}
});

router.post("/plan/save", (req, res) => {
	const plan = [];
	const tableNames = Array.isArray(req.body.table) ? req.body.table : [req.body.table];
	const modes = Array.isArray(req.body.mode) ? req.body.mode : [req.body.mode];
	const keyStrategies = Array.isArray(req.body.keyStrategy) ? req.body.keyStrategy : [req.body.keyStrategy];

	tableNames.forEach((table, index) => {
		const dedupeKeyField = `dedupeKeys__${table}`;
		const dedupeKeys = Array.isArray(req.body[dedupeKeyField])
			? req.body[dedupeKeyField]
			: req.body[dedupeKeyField]
				? [req.body[dedupeKeyField]]
				: [];
		const onDuplicate = req.body[`onDuplicate__${table}`] || "SKIP";
		plan.push({
			table,
			include: req.body[`include_${table}`] === "on",
			mode: modes?.[index] || "UPSERT",
			keyStrategy: keyStrategies?.[index] || "rekey",
			dedupeKeys,
			onDuplicate
		});
	});

	state.plan = plan.slice().sort((a, b) => a.table.localeCompare(b.table));
	res.redirect("/mapping");
});

module.exports = router;
