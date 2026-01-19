const express = require("express");
const { state } = require("../config/state");
const { startMigration, resumeMigration } = require("../migrate/runner");
const mysql = require("../db/mysql");
const runStore = require("../migrate/runStore");
const firebird = require("../db/firebird");

const router = express.Router();

function validateFirebirdConfig() {
	const resolved = firebird.resolveFirebirdConfig(state.firebird, process.env);
	const validationError = firebird.validateFirebirdConfig(resolved);
	if (validationError) {
		return { error: validationError, resolved };
	}
	if (!resolved.password || !String(resolved.password).trim()) {
		return { error: "Firebird password is empty. Provide a password or enable default SYSDBA/masterkey.", resolved };
	}
	return { error: null, resolved };
}

router.get("/run", async (req, res) => {
	const runId = req.query.runId || null;
	let run = null;
	if (runId) {
		try {
			const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
			await mysql.ensureMigrationTables(pool);
			run = await runStore.getRun(pool, runId);
			await pool.end();
		} catch (err) {
			run = null;
		}
	}

	res.render("run", {
		plan: state.plan || [],
		runId,
		run,
		currentStep: "run"
	});
});

router.post("/run/start", async (req, res) => {
	const { error: configError, resolved } = validateFirebirdConfig();
	// console.log("Firebird run config:", firebird.maskFirebirdConfig(resolved || state.firebird));
	if (configError) {
		res.render("run", {
			plan: state.plan || [],
			runId: null,
			run: null,
			error: configError,
			currentStep: "run"
		});
		return;
	}

	const dryRun = req.body.dry_run === "on";
	const batchSize = Number(req.body.batch_size || 500);
	const fkChecks = req.body.fk_checks === "on";

	const { runId } = await startMigration({
		firebirdConfig: resolved,
		mysqlConfig: state.mysql,
		schemaName: state.schemaName,
		plan: state.plan || [],
		mapping: state.mapping || {},
		dryRun,
		batchSize,
		fkChecks
	});

	res.redirect(`/run?runId=${runId}`);
});

router.post("/run/rerun", async (req, res) => {
	const { error: configError, resolved } = validateFirebirdConfig();
	// console.log("Firebird run config:", firebird.maskFirebirdConfig(resolved || state.firebird));
	if (configError) {
		res.render("run", {
			plan: state.plan || [],
			runId: null,
			run: null,
			error: configError,
			currentStep: "run"
		});
		return;
	}

	const runId = req.body.run_id;
	const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
	await mysql.ensureMigrationTables(pool);
	const tables = await runStore.getRunTables(pool, runId);
	await pool.end();

	const failed = tables.filter((t) => t.status !== "success");
	const plan = failed.map((t) => ({
		table: t.table_name,
		include: true,
		mode: t.mode,
		keyStrategy: t.key_strategy
	}));

	const { runId: newRunId } = await startMigration({
		firebirdConfig: resolved,
		mysqlConfig: state.mysql,
		schemaName: state.schemaName,
		plan,
		mapping: state.mapping || {},
		dryRun: false,
		batchSize: 500,
		fkChecks: true
	});

	res.redirect(`/run?runId=${newRunId}`);
});

router.post("/run/resume", async (req, res) => {
	const { error: configError, resolved } = validateFirebirdConfig();
	// console.log("Firebird run config:", firebird.maskFirebirdConfig(resolved || state.firebird));
	if (configError) {
		res.render("run", {
			plan: state.plan || [],
			runId: null,
			run: null,
			error: configError,
			currentStep: "run"
		});
		return;
	}

	const runId = req.body.run_id;
	const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
	await mysql.ensureMigrationTables(pool);
	const run = await runStore.getRun(pool, runId);
	await pool.end();

	if (!run) {
		res.redirect("/run");
		return;
	}

	const plan = run.plan_json ? JSON.parse(run.plan_json) : state.plan || [];

	await resumeMigration({
		firebirdConfig: resolved,
		mysqlConfig: state.mysql,
		schemaName: state.schemaName,
		plan,
		mapping: state.mapping || {},
		dryRun: !!run.dry_run,
		batchSize: run.batch_size || 500,
		fkChecks: !!run.fk_checks,
		runId
	});

	res.redirect(`/run?runId=${runId}`);
});

module.exports = router;
