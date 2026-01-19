const express = require("express");
const { state } = require("../config/state");
const { startMigration, requestAbort } = require("../migrate/runner");
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
		if (req.accepts(["html", "json"]) === "json") {
			res.status(400).json({ error: configError });
			return;
		}
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

	if (req.accepts(["html", "json"]) === "json") {
		res.json({ runId });
		return;
	}

	res.redirect(`/run?runId=${runId}`);
});

router.post("/run/abort", (req, res) => {
	const runId = req.body?.runId || req.body?.run_id;
	const reason = req.body?.reason || "Migration stopped";
	if (!runId) {
		res.status(400).json({ ok: false, error: "runId is required" });
		return;
	}
	requestAbort(runId, reason);
	res.json({ ok: true });
});

module.exports = router;
