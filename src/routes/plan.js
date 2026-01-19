const express = require("express");
const firebird = require("../db/firebird");
const { state } = require("../config/state");
const migrationPlan = require("../migrate/migrationPlan");

const router = express.Router();

router.get("/plan", async (req, res) => {
	try {
		if (!state.mapping) {
			state.mapping = migrationPlan.loadDefaultMapping();
		}

		const fbTables = await firebird.listTables(state.firebird);

		const expectedMySqlTables = migrationPlan.getExpectedTablesFromDDL();
		const maxLen = Math.max(fbTables.length, expectedMySqlTables.length);
		const schemaPairs = Array.from({ length: maxLen }).map((_, index) => ({
			firebird: fbTables[index] || "",
			firebirdCount: fbTables[index] ? "—" : "",
			mysql: expectedMySqlTables[index] || ""
		}));
		const plan = migrationPlan.buildPlan({
			firebirdTables: fbTables,
			mysqlTables: expectedMySqlTables,
			mapping: state.mapping
		});

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
		plan.push({
			table,
			include: req.body[`include_${table}`] === "on",
			mode: modes?.[index] || "UPSERT",
			keyStrategy: keyStrategies?.[index] || "rekey"
		});
	});

	state.plan = plan;
	res.redirect("/mapping");
});

module.exports = router;
