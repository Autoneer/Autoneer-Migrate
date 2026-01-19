const express = require("express");
const { state } = require("../config/state");
const mysql = require("../db/mysql");
const runStore = require("../migrate/runStore");

const router = express.Router();

router.get("/migration/history", async (req, res) => {
	const status = req.query.status || 'All';
	const range = req.query.range || '7';
	const source = req.query.source || null;
	const target = req.query.target || null;

	try {
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);

		const where = [];
		const params = [];
		if (status && status !== 'All') {
			where.push('status = ?');
			params.push(status.toUpperCase());
		}
		if (source) {
			where.push('source_conn_name = ?');
			params.push(source);
		}
		if (target) {
			where.push('target_schema_name = ?');
			params.push(target);
		}
		if (range && ['7', '30', '90'].includes(String(range))) {
			where.push('started_at >= date_sub(now(), interval ? day)');
			params.push(Number(range));
		}

		const sql = `select * from migration_runs ${where.length ? 'where ' + where.join(' and ') : ''} order by started_at desc limit 200`;
		const [rows] = await pool.query(sql, params);
		await pool.end();

		res.render('migration_history', { runs: rows, currentStep: 'migration' });
	} catch (err) {
		res.render('migration_history', { runs: [], error: err.message, currentStep: 'migration' });
	}
});

router.get('/migration/history/:run_id', async (req, res) => {
	const runId = Number(req.params.run_id);
	if (!runId) return res.redirect('/migration/history');
	try {
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);
		const run = await runStore.getRun(pool, runId);
		const tables = await runStore.getRunTables(pool, runId);
		const errors = await runStore.getRowErrors(pool, runId);
		await pool.end();

		res.render('migration_run', { run, tables, errors, currentStep: 'migration' });
	} catch (err) {
		res.render('migration_run', { run: null, tables: [], errors: [], error: err.message, currentStep: 'migration' });
	}
});

router.post('/migration/plans/:plan_id/reuse', async (req, res) => {
	const planId = Number(req.params.plan_id);
	if (!planId) return res.redirect('/mapping');
	try {
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);
		const plan = await runStore.getPlan(pool, planId);
		await pool.end();
		if (plan && plan.mapping_json) {
			state.mapping = JSON.parse(plan.mapping_json);
			state.mapping.profileId = null;
			state.mapping.profileName = plan.name;
			// attach plan id so runner can reference
			state.mapping.planId = plan.plan_id;
		}
		res.redirect('/mapping');
	} catch (err) {
		res.redirect('/mapping');
	}
});

router.post('/migration/history/:run_id/delete', async (req, res) => {
	const runId = Number(req.params.run_id);
	if (!runId) return res.redirect('/migration/history');
	try {
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);
		await runStore.deleteRun(pool, runId);
		await pool.end();
		res.redirect('/migration/history');
	} catch (err) {
		res.render('migration_history', { runs: [], error: `Failed to delete run: ${err.message}`, currentStep: 'migration' });
	}
});

module.exports = router;
