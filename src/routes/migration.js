const express = require("express");
const { state } = require("../config/state");
const mysql = require("../db/mysql");
const runStore = require("../migrate/runStore");

const router = express.Router();

// History page filters: run statuses to pick from, and the periods (days) the query below accepts; 'all' applies no date filter.
const HISTORY_STATUSES = ['SUCCESS', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED', 'RUNNING'];
const HISTORY_RANGES = [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['all', 'All time']];

// "COMPLETED_WITH_ERRORS" -> "Completed with errors"
const statusLabel = (status) => {
	const text = String(status || '').toLowerCase().replace(/_/g, ' ');
	return text.charAt(0).toUpperCase() + text.slice(1);
};

const formatDuration = (startedAt, endedAt) => {
	if (!startedAt || !endedAt) return null;
	const ms = new Date(endedAt) - new Date(startedAt);
	if (Number.isNaN(ms)) return null;
	const secs = Math.max(0, Math.round(ms / 1000));
	if (secs < 60) return `${secs}s`;
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins}m ${secs % 60}s`;
	return `${Math.floor(mins / 60)}h ${mins % 60}m`;
};

const renderHistory = (res, { runs = [], error = null, status = 'All', range = '7' } = {}) => {
	const historyRuns = runs.map((run) => ({
		...run,
		status_key: String(run.status || '').toLowerCase(),
		status_label: statusLabel(run.status),
		duration: formatDuration(run.started_at, run.ended_at),
		warn_label: run.warn_count ? `${run.warn_count} warning${run.warn_count === 1 ? '' : 's'}` : null
	}));
	const filters = {
		status: String(status).toUpperCase(),
		range: String(range),
		statuses: HISTORY_STATUSES.map((value) => ({ value, label: statusLabel(value), selected: value === String(status).toUpperCase() })),
		ranges: HISTORY_RANGES.map(([value, label]) => ({ value, label, selected: value === String(range) }))
	};
	res.render('migration_history', {
		runs: historyRuns,
		runCountLabel: `${historyRuns.length} run${historyRuns.length === 1 ? '' : 's'}`,
		filtered: filters.status !== 'ALL' || filters.range !== 'all',
		filters,
		error,
		currentStep: 'migration'
	});
};

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

		// Newest first, so the limit keeps the latest runs; the stable label sort below keeps that order within each label.
		const sql = `select * from migration_runs ${where.length ? 'where ' + where.join(' and ') : ''} order by started_at desc, run_id desc limit 200`;
		let [rows] = await pool.query(sql, params);
		rows = rows
			.slice()
			.sort((a, b) => String(a.run_label || "").localeCompare(String(b.run_label || "")));
		await pool.end();

		renderHistory(res, { runs: rows, status, range });
	} catch (err) {
		renderHistory(res, { error: err.message, status, range });
	}
});

router.get('/migration/history/:run_id', async (req, res) => {
	const runId = Number(req.params.run_id);
	if (!runId) return res.redirect('/migration/history');
	try {
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);
		const run = await runStore.getRun(pool, runId);
		let tables = await runStore.getRunTables(pool, runId);
		tables = tables.slice().sort((a, b) => String(a.table_name || "").localeCompare(String(b.table_name || "")));
		let errors = await runStore.getRowErrors(pool, runId);
		errors = errors.slice().sort((a, b) => {
			const tableCompare = String(a.table_name || "").localeCompare(String(b.table_name || ""));
			if (tableCompare !== 0) return tableCompare;
			return Number(a.row_offset || 0) - Number(b.row_offset || 0);
		});
		await pool.end();

		res.render('migration_run', { run, tables, errors, currentStep: 'migration' });
	} catch (err) {
		res.render('migration_run', { run: null, tables: [], errors: [], error: err.message, currentStep: 'migration' });
	}
});

router.post('/migration/plans/:plan_id/reuse', async (req, res) => {
	const planId = Number(req.params.plan_id);
	if (!planId) return res.redirect('/wizard?step=3');
	try {
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);
		const plan = await runStore.getPlan(pool, planId);
		if (plan) {
			let mappingProfileId = plan.mapping_profile_id || null;
			if (!mappingProfileId && plan.mapping_json) {
				const mappingJson = typeof plan.mapping_json === 'string'
					? plan.mapping_json
					: JSON.stringify(plan.mapping_json || {});
				mappingProfileId = await runStore.saveMappingProfile(pool, {
					name: (plan.name || `Migrated Profile ${plan.plan_id}`).trim(),
					mappingJson
				});
				await pool.query(
					"update migration_plans set mapping_profile_id = ? where plan_id = ?",
					[mappingProfileId, plan.plan_id]
				);
			}
			if (mappingProfileId) {
				const profile = await runStore.getMappingProfile(pool, mappingProfileId);
				if (profile?.mapping_json) {
					state.mapping = JSON.parse(profile.mapping_json);
					state.mapping.profileId = mappingProfileId;
					state.mapping.profileName = profile.name;
					// attach plan id so runner can reference
					state.mapping.planId = plan.plan_id;
				}
			}
		}
		await pool.end();
		res.redirect(`/wizard?reusePlanId=${planId}&step=3`);
	} catch (err) {
		res.redirect('/wizard?step=3');
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
		renderHistory(res, { error: `Failed to delete run: ${err.message}` });
	}
});

router.post('/migration/history/delete', async (req, res) => {
	// Accepts one or more run_ids from the batch-delete form (same-name inputs)
	let runIds = req.body.run_ids || req.body.run_ids;
	if (!runIds) return res.redirect('/migration/history');
	try {
		if (!Array.isArray(runIds)) {
			// single value -> normalize to array
			runIds = [runIds];
		}
		// convert to numeric ids and filter invalid
		runIds = runIds.map(r => Number(r)).filter(n => !!n);
		if (!runIds.length) return res.redirect('/migration/history');

		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);
		for (const id of runIds) {
			try {
				await runStore.deleteRun(pool, id);
			} catch (e) {
				// continue deleting remaining runs but log the error to console
				console.error('Failed to delete run', id, e && e.message);
			}
		}
		await pool.end();
		res.redirect('/migration/history');
	} catch (err) {
		renderHistory(res, { error: `Failed to delete selected runs: ${err.message}` });
	}
});

// Flush all migration history - DANGEROUS: permanently deletes all migration tables
router.post('/migration/history/flush', async (req, res) => {
	try {
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);

		// Execute in transaction to ensure consistency
		await pool.query('START TRANSACTION');
		try {
			// Delete records from all migration-related tables
			await pool.query('delete from migration_run_errors');
			await pool.query('delete from migration_row_errors');
			await pool.query('delete from migration_table_runs');
			await pool.query('delete from migration_id_map');
			await pool.query('delete from migration_runs');
			await pool.query('delete from migration_runs_legacy');
			await pool.query('delete from migration_plans');
			await pool.query('delete from migration_mapping_profiles');
			await pool.query('COMMIT');
		} catch (e) {
			try { await pool.query('ROLLBACK'); } catch (r) { /* ignore */ }
			throw e;
		}

		await pool.end();
		res.redirect('/migration/history');
	} catch (err) {
		renderHistory(res, { error: `Failed to flush migration history: ${err.message}` });
	}
});

module.exports = router;
