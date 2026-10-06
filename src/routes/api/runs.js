/**
 * API Routes for Run Management
 * RESTful endpoints for managing and tracking migration execution
 */

const express = require("express");
const fs = require("fs");
const { stringify } = require("csv-stringify/sync");
const mysql = require("../../db/mysql");
const { state } = require("../../config/state");
const { Run } = require("../../migrate/models");
const runStore = require("../../migrate/runStore");
const { getRunState } = require("../../migrate/runner");
const logger = require("../../migrate/logger");
const { buildRunSummary, normalizeRowError } = require("../../migrate/runDiagnostics");
const { buildRunProgress } = require("../../migrate/runProgress");

async function getPlannedTables(runId, runData) {
	const snapshot = safeParseJson(runData.table_summary_json);
	// The log contains the original selection even for runs created before snapshots.
	try {
		const content = await fs.promises.readFile(logger.getLogFilePath(runId), "utf8");
		const start = content.split(/\r?\n/).map(line => safeParseJson(line)).find(event => event.phase === "run_start");
		// Run IDs can be reused across schemas or after history is cleared.
		const sameRun = runData.started_at && start?.timestamp
			&& Math.abs(new Date(runData.started_at) - new Date(start.timestamp)) < 2000;
		if (sameRun && Array.isArray(start?.tables)) return start.tables.map(t => t.table);
	} catch { /* Saved table snapshot remains available without a log file. */ }
	return Object.keys(snapshot);
}

const router = express.Router();

function safeParseJson(raw, fallback = {}) {
	if (!raw) return fallback;
	if (typeof raw === 'object') return raw;
	try {
		return JSON.parse(raw);
	} catch {
		return fallback;
	}
}

/**
 * Normalize mapping from legacy shape (targetTable/targetColumn) to canonical shape (target).
 * Shared by the regular run handler and the retry handler.
 */
function normalizeMappingJson(mapping) {
	if (!mapping || !mapping.tables) return mapping;
	const tables = mapping.tables;
	const needsConversion = Object.values(tables).some((config) => {
		if (!config) return false;
		if (config.targetTable) return true;
		const sampleColumn = config.columns ? Object.values(config.columns)[0] : null;
		return !!sampleColumn?.targetColumn;
	});

	if (!needsConversion) return mapping;

	const converted = { ...mapping, tables: {} };
	for (const [sourceTable, config] of Object.entries(tables)) {
		const columns = {};
		for (const [srcCol, field] of Object.entries(config?.columns || {})) {
			columns[srcCol] = {
				target: field?.targetColumn || field?.target || srcCol,
				transform: field?.transform || null,
				defaultValue: field?.defaultValue ?? field?.default ?? null,
				lookup: field?.lookup || null,
				omit: field?.omit || false
			};
		}
		converted.tables[sourceTable] = {
			target: config?.targetTable || config?.target || sourceTable,
			columns,
			mode: config?.mode,
			keyStrategy: config?.keyStrategy
		};
	}
	return converted;
}


async function resolvePlanMappingProfileId(pool, planRow) {
	if (planRow.mapping_profile_id) {
		return planRow.mapping_profile_id;
	}
	const embeddedPlan = safeParseJson(planRow.plan_json || planRow.mapping_json);
	const embeddedProfileId = embeddedPlan.mappingProfileId || embeddedPlan.mappingId;
	if (embeddedProfileId) {
		const profile = await runStore.getMappingProfile(pool, embeddedProfileId);
		if (profile) return profile.id || profile.profile_id;
	}
	if (planRow.mapping_id) {
		const profile = await runStore.getMappingProfile(pool, planRow.mapping_id);
		if (profile) {
			await pool.query(
				"UPDATE migration_plans SET mapping_profile_id = ? WHERE plan_id = ?",
				[profile.id, planRow.plan_id]
			);
			return profile.id;
		}
	}
	if (planRow.mapping_json) {
		const mappingJson = typeof planRow.mapping_json === 'string'
			? planRow.mapping_json
			: JSON.stringify(planRow.mapping_json || {});
		const profileId = await runStore.saveMappingProfile(pool, {
			name: (planRow.name || `Migrated Profile ${planRow.plan_id}`).trim(),
			mappingJson
		});
		await pool.query(
			"UPDATE migration_plans SET mapping_profile_id = ? WHERE plan_id = ?",
			[profileId, planRow.plan_id]
		);
		return profileId;
	}

	const planJson = safeParseJson(planRow.plan_json || planRow.mapping_json || '{}');
	const legacyId = planJson.mappingProfileId || planJson.mappingId || null;
	if (legacyId) {
		const profile = await runStore.getMappingProfile(pool, legacyId);
		if (profile) {
			await pool.query(
				"UPDATE migration_plans SET mapping_profile_id = ? WHERE plan_id = ?",
				[profile.id, planRow.plan_id]
			);
			return profile.id;
		}
	}

	return null;
}


/**
 * GET /api/runs
 * List all migration runs
 */
router.get("/runs", async (req, res) => {
	try {
		const { limit = 50, status, planId } = req.query;

		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);

		let query = "SELECT * FROM migration_runs";
		const params = [];
		const conditions = [];

		if (status) {
			conditions.push("status = ?");
			params.push(status);
		}

		if (planId) {
			conditions.push("plan_id = ?");
			params.push(planId);
		}

		if (conditions.length > 0) {
			query += " WHERE " + conditions.join(" AND ");
		}

		query += " ORDER BY run_id DESC LIMIT ?";
		params.push(parseInt(limit, 10));

		const [rows] = await pool.query(query, params);

		await pool.end();

		res.json({
			success: true,
			count: rows.length,
			runs: rows.map(row => ({
				runId: row.run_id,
				planId: row.plan_id,
				mappingProfileId: row.mapping_profile_id || row.mapping_id || null,
				status: row.status,
				startedAt: row.started_at,
				completedAt: row.completed_at,
				dryRun: row.dry_run,
				tablesTotal: row.tables_total,
				tablesCompleted: row.tables_completed,
				rowsMigrated: row.rows_migrated,
				errorMessage: row.error_message
			}))
		});
	} catch (err) {
		const statusCode = ["GL_REBUILD_REQUIRED", "GL_PERIODS_REQUIRED"].includes(err?.code) ? 400 : 500;
		res.status(statusCode).json({
			success: false,
			error: err.message
		});
	}
});

/**
 * POST /runs
 * Start a new migration run (RESTful endpoint for client)
 */
router.post("/runs", async (req, res) => {
	try {
		const { planId, dryRun = false, tables } = req.body;

		if (!planId) {
			return res.status(400).json({
				success: false,
				error: "planId is required"
			});
		}

		// Load plan from database
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);

		const planData = await runStore.getPlan(pool, planId);
		if (!planData) {
			await pool.end();
			return res.status(404).json({
				success: false,
				error: "Plan not found"
			});
		}

		const mappingProfileId = await resolvePlanMappingProfileId(pool, planData);

		const planJson = safeParseJson(planData.plan_json || planData.mapping_json || '{}');

		// console.log('[Runs] Plan data:', {
		// 	planId,
		// 	hasMappingProfileId: !!planData.mapping_profile_id,
		// 	hasLegacyMappingId: !!planData.mapping_id,
		// 	resolvedMappingProfileId: mappingProfileId,
		// 	planDataKeys: Object.keys(planData)
		// });

		// CRITICAL: Enforce mapping requirement (defense-in-depth)
		if (!mappingProfileId) {
			await pool.end();
			return res.status(400).json({
				success: false,
				error: "MAPPING_REQUIRED",
				message: "Plan is missing a mapping profile. Open the plan and re-select a profile or rebuild mapping."
			});
		}

		// Get mapping profile
		const mappingData = await runStore.getMappingProfile(pool, mappingProfileId);
		if (!mappingData) {
			await pool.end();
			return res.status(404).json({
				success: false,
				error: "MAPPING_NOT_FOUND",
				message: "Mapping profile not found in database."
			});
		}

		// Validate mapping has tables
		const mappingJson = typeof mappingData.mapping_json === 'string'
			? JSON.parse(mappingData.mapping_json || '{}')
			: (mappingData.mapping_json || {});

		if (!mappingJson.tables || Object.keys(mappingJson.tables).length === 0) {
			await pool.end();
			return res.status(400).json({
				success: false,
				error: "MAPPING_EMPTY",
				message: "Mapping profile exists but contains no table mappings. Rebuild mapping in Step 2."
			});
		}

		// mappingJson already parsed in validation block above
		// console.log('[Runs] Raw mapping from DB:', {
		// 	mappingProfileId,
		// 	hasTables: !!mappingJson.tables,
		// 	tablesType: typeof mappingJson.tables,
		// 	tableCount: Object.keys(mappingJson.tables || {}).length,
		// 	tableKeys: Object.keys(mappingJson.tables || {}).slice(0, 3),
		// 	firstTableSample: Object.entries(mappingJson.tables || {}).slice(0, 1).map(([k, v]) => ({ source: k, targetTable: v?.targetTable, target: v?.target, hasColumns: !!v?.columns }))
		// });

		const { normalizePlanSteps } = require('../../migrate/planNormalize');

		const normalizedMapping = normalizeMappingJson(mappingJson);
		const normalizedPlan = normalizePlanSteps(planJson, normalizedMapping);

		// console.log('[Runs] Normalized plan (first 2):', JSON.stringify(normalizedPlan.slice(0, 2), null, 2));
		// console.log('[Runs] Normalized mapping sample:', JSON.stringify({
		// 	tableCount: Object.keys(normalizedMapping?.tables || {}).length,
		// 	firstTable: Object.entries(normalizedMapping?.tables || {}).slice(0, 1).map(([k, v]) => ({ source: k, target: v?.target, columnCount: Object.keys(v?.columns || {}).length }))
		// }, null, 2));

		await pool.end();

		// Add planId and profileId to mapping object so runner can store them
		normalizedMapping.planId = planId;
		normalizedMapping.profileId = mappingProfileId;

		// Start migration
		const { startMigration } = require("../../migrate/runner");
		const result = await startMigration({
			firebirdConfig: state.firebird,
			mysqlConfig: state.mysql,
			schemaName: state.schemaName,
			plan: normalizedPlan,
			planConfig: planJson.config || {},
			mapping: normalizedMapping,
			dryRun: dryRun,
			batchSize: planJson.config?.batchSize || 1000,
			fkChecks: true
		});

		res.status(201).json({
			success: true,
			run: {
				id: result.runId,
				planId: planId,
				status: 'running',
				dryRun: dryRun
			},
			message: dryRun ? "Dry run started" : "Migration started"
		});
	} catch (err) {
		console.error('[Runs] POST /runs error:', err);
		const statusCode = ["GL_REBUILD_REQUIRED", "GL_PERIODS_REQUIRED"].includes(err?.code) ? 400 : 500;
		res.status(statusCode).json({
			success: false,
			error: err.message
		});
	}
});

/**
 * GET /api/runs/:runId/metadata
 * Return plan and mapping profile names associated with a run (best-effort)
 */
router.get('/runs/:runId/metadata', async (req, res) => {
	try {
		const { runId } = req.params;
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);

		const runData = await runStore.getRun(pool, runId);
		if (!runData) {
			await pool.end();
			return res.status(404).json({ success: false, error: 'Run not found' });
		}

		let planName = null;
		let planId = runData.plan_id || null;
		let mappingProfileId = null;
		let mappingName = null;

		// Look up plan name and mapping profile id if plan_id is available
		if (planId) {
			try {
				const planRow = await runStore.getPlan(pool, planId);
				if (planRow) {
					planName = planRow.name || null;
					mappingProfileId = planRow.mapping_profile_id || null;
				}
			} catch (e) {
				// ignore plan lookup errors
			}
		}

		// If plan_id is null, try legacy table
		if (!planId && !mappingProfileId) {
			try {
				const [legacyRows] = await pool.query(
					'select mapping_profile_id, plan_json from migration_runs_legacy order by created_at desc limit 1'
				);
				const legacy = legacyRows && legacyRows[0] ? legacyRows[0] : null;
				if (legacy) {
					mappingProfileId = legacy.mapping_profile_id || null;
					if (legacy.plan_json) {
						try {
							const pj = typeof legacy.plan_json === 'string' ? JSON.parse(legacy.plan_json) : legacy.plan_json;
							planName = pj?.name || null;
						} catch (e) {
							// ignore parse errors
						}
					}
				}
			} catch (e) {
				// ignore legacy lookup errors
			}
		}

		// Look up mapping profile name if mapping_profile_id is available
		if (mappingProfileId) {
			try {
				const mappingRow = await runStore.getMappingProfile(pool, mappingProfileId);
				if (mappingRow) {
					mappingName = mappingRow.name || null;
				}
			} catch (e) {
				// ignore mapping lookup errors
			}
		}

		await pool.end();

		return res.json({
			success: true,
			metadata: {
				planId: planId || null,
				planName: planName || null,
				mappingProfileId: mappingProfileId || null,
				mappingName: mappingName || null
			}
		});
	} catch (err) {
		res.status(500).json({ success: false, error: err.message });
	}
});

/**
 * GET /api/runs/:runId
 * Get detailed information about a specific run
 */
router.get("/runs/:runId", async (req, res) => {
	try {
		const { runId: rawRunId } = req.params;
		// Normalize runId to numeric when possible to match in-memory keys
		const numericRunId = Number(rawRunId);
		const runId = Number.isNaN(numericRunId) ? rawRunId : numericRunId;

		const buildPlanAdapter = (tableNames = [], planId = null, mappingProfileId = null) => ({
			id: planId,
			mappingProfileId,
			getIncludedTables: () => tableNames
		});

		// First check in-memory state (active run)
		const runState = getRunState(runId);
		if (runState) {
			// Create a Run instance from the active state
			const planSteps = Array.isArray(state.plan) ? state.plan : [];
			let includedTables = planSteps.filter(step => step?.include).map(step => step.table).filter(Boolean);
			if (includedTables.length === 0) {
				includedTables = (runState.tables || []).map(table => table.name).filter(Boolean);
			}
			const plan = buildPlanAdapter(
				includedTables,
				state.plan?.id || null,
				state.plan?.mappingProfileId || state.plan?.mappingId || null
			);
			const run = new Run(runId, plan);

			// Populate with current state data
			run.status = runState.status;
			run.startedAt = runState.startedAt ? new Date(runState.startedAt) : new Date();
			run.completedAt = runState.finishedAt || runState.completedAt || null;
			run.finishedAt = run.completedAt ? new Date(run.completedAt) : null;
			run.dryRun = runState.dryRun || false;

			// Add table results
			(runState.tables || []).forEach(table => {
				const s = String(table.status || '').toUpperCase();
				if (s === 'COMPLETED' || s === 'SUCCESS') {
					const stats = {
						inserted: table.inserted || table.rowsInserted || 0,
						updated: table.updated || table.rowsUpdated || 0,
						skipped: table.skippedDuplicates || table.rowsSkipped || 0,
						errors: table.rowsError || table.rows_error || 0,
						durationMs: table.durationMs || table.duration_ms || 0
					};
					run.recordTableSuccess(table.name, stats);
				} else if (s === 'FAILED') {
					run.recordTableFailure(table.name, table.lastError?.message || "Unknown error", "Check logs");
				}
			});

			run.status = runState.status;
			const runJson = run.toJSON();
			// UI-friendly aliases expected by client-side RunUI
			runJson.tablesCompleted = (runState.tables || []).filter(t => ['SUCCESS', 'COMPLETED'].includes(String(t.status).toUpperCase())).length;
			runJson.tablesFailed = (runState.tables || []).filter(t => String(t.status || '').toUpperCase() === 'FAILED').length;
			runJson.rowsMigrated = (runState.tables || []).reduce((sum, table) => sum + Number(table.migrated || 0), 0);
			runJson.duration = run.completedAt ? (new Date(run.completedAt) - new Date(run.startedAt)) : (Date.now() - new Date(run.startedAt));
			// Include error message from in-memory state
			runJson.errorMessage = runState.lastError?.message || runJson.lastError?.message || null;

			return res.json({
				success: true,
				run: runJson,
				progress: run.getProgress(),
				estimatedSecondsRemaining: run.getEstimatedSecondsRemaining()
			});
		}

		// Load from database if not active
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);

		const runData = await runStore.getRun(pool, runId);

		if (!runData) {
			await pool.end();
			return res.status(404).json({
				success: false,
				error: "Run not found"
			});
		}

		// Load table results
		const tables = await runStore.getRunTables(pool, runId);

		// Look up plan/mapping ids before closing the pool
		let resolvedPlanId = runData.plan_id || null;
		let resolvedMappingProfileId = null;
		if (resolvedPlanId) {
			try {
				const planRow = await runStore.getPlan(pool, resolvedPlanId);
				resolvedMappingProfileId = planRow?.mapping_profile_id || null;
			} catch (e) {
				resolvedMappingProfileId = null;
			}
		}

		await pool.end();

		// Reconstruct Run instance
		const tableNames = (tables || []).map(table => table.table_name).filter(Boolean);
		const plan = buildPlanAdapter(tableNames, runData.plan_id || null, null);
		const run = new Run(runId, plan);
		run.status = runData.status;
		run.startedAt = new Date(runData.started_at);
		run.completedAt = runData.ended_at || runData.completed_at;
		run.finishedAt = run.completedAt ? new Date(run.completedAt) : null;
		run.dryRun = runData.dry_run;

		// Add table results
		(tables || []).forEach(table => {
			const s = String(table.status || '').toUpperCase();
			if (s === 'COMPLETED' || s === 'SUCCESS') {
				const stats = {
					inserted: table.rows_inserted || table.rowsInserted || 0,
					updated: table.rows_updated || table.rowsUpdated || 0,
					skipped: table.rows_skipped_duplicates || table.rowsSkipped || 0,
					errors: table.rows_error || table.rowsError || 0,
					durationMs: table.duration_ms || 0
				};
				run.recordTableSuccess(table.table_name, stats);
			} else if (s === 'FAILED') {
				run.recordTableFailure(table.table_name, table.error_message || "Unknown error", "");
			}
		});

		run.status = runData.status;
		const runJson = run.toJSON();
		runJson.tablesCompleted = (tables || []).filter(t => ['SUCCESS', 'COMPLETED'].includes(String(t.status).toUpperCase())).length;
		runJson.tablesFailed = (tables || []).filter(t => String(t.status || '').toUpperCase() === 'FAILED').length;
		runJson.rowsMigrated = (tables || []).reduce((sum, table) => sum + Number(table.rows_migrated || 0), 0);
		runJson.duration = run.completedAt ? (new Date(run.completedAt) - new Date(run.startedAt)) : (Date.now() - new Date(run.startedAt));
		// Include the error message from the DB row so the UI can display it
		runJson.errorMessage = runData.error_message || runJson.lastError?.message || null;
		// Attach plan/mapping ids for metadata lookup
		runJson.planId = resolvedPlanId;
		runJson.mappingProfileId = resolvedMappingProfileId;

		res.json({
			success: true,
			run: runJson,
			progress: run.getProgress(),
			estimatedSecondsRemaining: run.getEstimatedSecondsRemaining()
		});
	} catch (err) {
		const statusCode = ["GL_REBUILD_REQUIRED", "GL_PERIODS_REQUIRED"].includes(err?.code) ? 400 : 500;
		res.status(statusCode).json({
			success: false,
			error: err.message
		});
	}
});

/**
 * GET /api/runs/:runId/progress
 * Get real-time progress for an active run
 */
router.get("/runs/:runId/progress", async (req, res) => {
	let pool;
	try {
		const { runId } = req.params;
		const numericRunId = Number(runId);
		const runKey = Number.isNaN(numericRunId) ? runId : numericRunId;
		const runState = getRunState(runKey);
		if (runState) {
			// Use this run's immutable selection and actual execution order.
			return res.json(buildRunProgress({ ...runState, runId: runKey }, runState.tables));
		}
		pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		const runData = await runStore.getRun(pool, runId);
		if (!runData) return res.status(404).json({ success: false, error: "Run not found" });
		const dbTables = await runStore.getRunTables(pool, runId);
		const plannedTables = await getPlannedTables(runId, runData);
		const snapshot = safeParseJson(runData.table_summary_json);
		// Attempted rows are stored in execution order. Append all unattempted tables.
		const attempted = new Set(dbTables.map(table => table.table_name.toLowerCase()));
		const tables = [...dbTables, ...plannedTables.filter(name => !attempted.has(name.toLowerCase())).map(name => ({
			status: 'NOT_RUN', ...snapshot[name], table_name: name
		}))];
		res.json(buildRunProgress({ ...runData, runId: runKey }, tables));
	} catch (err) {
		res.status(500).json({ success: false, error: err.message });
	} finally {
		if (pool) await pool.end();
	}
});

/**
 * GET /api/runs/:runId/tables
 * Get table-level results for a run
 */
router.get("/runs/:runId/tables", async (req, res) => {
	try {
		const { runId } = req.params;

		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);

		const tables = await runStore.getRunTables(pool, runId);

		await pool.end();

		res.json({
			success: true,
			count: tables.length,
			tables: tables.map(table => ({
				tableName: table.table_name,
				status: table.status,
				mode: table.mode,
				keyStrategy: table.key_strategy,
				rowsSource: table.rows_source,
				rowsMigrated: table.rows_migrated,
				rowsInserted: table.rows_inserted,
				rowsUpdated: table.rows_updated,
				rowsError: table.rows_error,
				rowsSkippedDuplicates: table.rows_skipped_duplicates,
				errorMessage: table.error_message,
				startedAt: table.started_at,
				completedAt: table.completed_at
			}))
		});
	} catch (err) {
		res.status(500).json({
			success: false,
			error: err.message
		});
	}
});

/**
 * GET /api/runs/:runId/summary
 * Get summary statistics for a completed run
 */
router.get("/runs/:runId/summary", async (req, res) => {
	try {
		const { runId } = req.params;

		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);

		const runData = await runStore.getRun(pool, runId);

		if (!runData) {
			await pool.end();
			return res.status(404).json({
				success: false,
				error: "Run not found"
			});
		}

		let summary;
		try {
			const tables = await runStore.getRunTables(pool, runId);
			const errors = await runStore.getRowErrors(pool, runId);
			const plannedTables = await getPlannedTables(runId, runData);
			summary = buildRunSummary(runData, tables, plannedTables, errors);
		} finally { await pool.end(); }

		res.json({
			success: true,
			summary: summary
		});
	} catch (err) {
		res.status(500).json({
			success: false,
			error: err.message
		});
	}
});

/**
 * GET /api/runs/:runId/errors
 * Get row-level errors for a run
 */
router.get("/runs/:runId/errors", async (req, res) => {
	try {
		const { runId } = req.params;
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);

		const rawErrors = await runStore.getRowErrors(pool, runId);
		await pool.end();

		const errors = (rawErrors || []).map(normalizeRowError);

		res.json({
			success: true,
			count: errors.length,
			errors
		});
	} catch (err) {
		res.status(500).json({
			success: false,
			error: err.message
		});
	}
});

/**
 * GET /api/runs/:runId/logs
 * Get log entries for a run
 */
router.get("/runs/:runId/logs", async (req, res) => {
	try {
		const { runId } = req.params;
		const sinceMs = req.query.since ? Number(req.query.since) : null;
		const limit = Math.min(Math.max(Number(req.query.limit || 200), 1), 1000);
		const tableResultsOnly = req.query.view === 'table-results';
		let logs = tableResultsOnly ? logger.getTableResultBuffer(runId) : logger.getLogBuffer(runId);
		if (logs == null || (!tableResultsOnly && !logs.length)) {
			const logPath = logger.getLogFilePath(runId);
			try {
				const raw = await fs.promises.readFile(logPath, "utf8");
				logs = raw
					.split("\n")
					.filter(Boolean)
					.map(line => {
						try {
							return JSON.parse(line);
						} catch (e) {
							return { timestamp: null, level: "info", message: line };
						}
					});
			} catch (err) {
				logs = [];
			}
		}

		if (tableResultsOnly) {
			// Filter before applying limits: row-error bursts must not crowd out table results.
			const results = new Map();
			for (const event of logs) {
				if (event.phase !== 'table_finalize' || !['success', 'failed'].includes(String(event.status).toLowerCase())) continue;
				const key = String(event.tableName || event.table || '').trim().toLowerCase();
				if (key) results.set(key, event);
			}
			logs = Array.from(results.values());
		}

		if (Number.isFinite(sinceMs) && sinceMs > 0) {
			logs = logs.filter((entry) => {
				const ts = entry?.timestamp ? new Date(entry.timestamp).getTime() : 0;
				return ts > sinceMs;
			});
		}
		if (logs.length > limit) {
			logs = logs.slice(-limit);
		}

		res.json({
			success: true,
			count: logs.length,
			logs
		});
	} catch (err) {
		res.status(500).json({
			success: false,
			error: err.message
		});
	}
});

/**
 * GET /api/runs/:runId/export
 * Export run results as JSON or CSV
 */
router.get("/runs/:runId/export", async (req, res) => {
	try {
		const { runId } = req.params;
		const { format = 'json' } = req.query;

		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);

		const run = await runStore.getRun(pool, runId);
		const tables = await runStore.getRunTables(pool, runId);
		const rawErrors = await runStore.getRowErrors(pool, runId);
		await pool.end();

		const errors = (rawErrors || []).map((err) => ({
			...err,
			error_message: err.error_message || err.message || null
		}));

		if (String(format).toLowerCase() === 'csv') {
			const csv = stringify(errors, { header: true });
			res.setHeader("Content-Type", "text/csv");
			res.setHeader("Content-Disposition", "attachment; filename=migration-errors.csv");
			return res.send(csv);
		}

		res.json({
			success: true,
			run,
			tables,
			errors
		});
	} catch (err) {
		res.status(500).json({
			success: false,
			error: err.message
		});
	}
});

/**
 * POST /api/runs/start
 * Start a new migration run
 */
router.post("/runs/start", async (req, res) => {
	try {
		const { planId, dryRun = false } = req.body;

		if (!planId) {
			return res.status(400).json({
				success: false,
				error: "planId is required"
			});
		}

		// Load plan and mapping from state or database
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);

		// Get plan
		const planData = await runStore.getPlan(pool, planId);
		if (!planData) {
			await pool.end();
			return res.status(404).json({
				success: false,
				error: "Plan not found"
			});
		}

		const mappingProfileId = await resolvePlanMappingProfileId(pool, planData);
		if (!mappingProfileId) {
			await pool.end();
			return res.status(400).json({
				success: false,
				error: "Plan is missing a mapping profile. Open the plan and re-select a profile or rebuild mapping."
			});
		}

		// Get mapping
		const mappingData = await runStore.getMappingProfile(pool, mappingProfileId);
		if (!mappingData) {
			await pool.end();
			return res.status(404).json({
				success: false,
				error: "Mapping not found"
			});
		}

		await pool.end();

		// Set state for migration
		state.plan = JSON.parse(planData.plan_json || "[]");
		state.mapping = JSON.parse(mappingData.mapping_json || "{}");

		// Start migration (assuming startMigration is available)
		const { startMigration } = require("../../migrate/runner");
		const runId = await startMigration(dryRun);

		res.json({
			success: true,
			runId: runId,
			message: dryRun ? "Dry run started" : "Migration started"
		});
	} catch (err) {
		res.status(500).json({
			success: false,
			error: err.message
		});
	}
});

/**
 * POST /api/runs/:runId/stop
 * Stop an active migration run
 */
router.post("/runs/:runId/stop", async (req, res) => {
	try {
		const { runId } = req.params;
		const numericRunId = Number(runId);
		const runKey = Number.isNaN(numericRunId) ? runId : numericRunId;

		// Validate run exists (in-memory or DB)
		const { requestAbort, getRunState } = require("../../migrate/runner");
		const inMemory = getRunState(runKey);
		if (!inMemory) {
			// Check DB as best-effort
			const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
			await mysql.ensureMigrationTables(pool);
			const runData = await runStore.getRun(pool, runKey);
			await pool.end();
			if (!runData) {
				return res.status(404).json({ success: false, error: 'Run not found' });
			}
			// If run is not running, still accept request but inform client
			if (String(runData.status || '').toUpperCase() !== 'RUNNING') {
				requestAbort(runKey);
				return res.json({ success: true, status: 'STOP_REQUESTED', message: 'Stop requested; run is not actively running' });
			}
		}

		// Request abort using runner
		console.log(`[API] Stop requested for run ${runKey}`);
		requestAbort(runKey);

		res.json({
			success: true,
			status: 'STOP_REQUESTED',
			message: "Stop requested for run " + runKey
		});
	} catch (err) {
		res.status(500).json({
			success: false,
			error: err.message
		});
	}
});

/**
 * POST /api/runs/:runId/retry
 * Retry failed tables in a migration run
 */
router.post("/runs/:runId/retry", async (req, res) => {
	try {
		const { runId } = req.params;

		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);

		// Get run data
		const runData = await runStore.getRun(pool, runId);
		if (!runData) {
			await pool.end();
			return res.status(404).json({
				success: false,
				error: "Run not found"
			});
		}

		// Get failed tables (case-insensitive) and honor requested list
		let tables = await runStore.getRunTables(pool, runId);
		// fallback: older runs may have summary JSON in migration_runs.table_summary_json
		if ((!tables || tables.length === 0) && runData && runData.table_summary_json) {
			try {
				const summary = JSON.parse(runData.table_summary_json || "{}") || {};
				const summaryTables = Object.keys(summary).map(name => {
					const entry = summary[name] || {};
					// entry might be a status string or an object with status
					const status = typeof entry === 'string' ? entry : (entry.status || entry.state || entry.status_text || null);
					return { table_name: name, status };
				});
				if (summaryTables.length) tables = summaryTables;
			} catch (e) {
				// ignore parse errors and continue with empty tables
			}
		}

		// fallback: if DB still has no table records, check in-memory run state
		// (covers preflight failures where tables were never persisted)
		if ((!tables || tables.length === 0)) {
			const { getRunState: getMemState } = require("../../migrate/runner");
			const numericRunId = Number(runId);
			const memKey = Number.isNaN(numericRunId) ? runId : numericRunId;
			const memState = getMemState(memKey);
			if (memState && Array.isArray(memState.tables)) {
				tables = memState.tables.map(t => ({
					table_name: t.name,
					status: t.status || 'FAILED'
				}));
			}
		}

		const plannedTables = await getPlannedTables(runId, runData);
		const attempted = new Set((tables || []).map(t => String(t.table_name).toUpperCase()));
		tables = [...(tables || []), ...plannedTables.filter(name => !attempted.has(String(name).toUpperCase())).map(table_name => ({ table_name, status: 'NOT_RUN' }))];

		const requested = Array.isArray(req.body?.tables) ? req.body.tables.map(t => String(t).toUpperCase()) : null;
		// consider several statuses as retryable: failed, error, cancelled, not_run, queued
		const retryableStatuses = ['FAILED', 'ERROR', 'CANCELLED', 'STOPPED', 'NOT_RUN', 'QUEUED', 'PENDING'];
		const failedTables = (tables || []).filter(t => {
			const s = String((t.status || t.state || '') || '').toUpperCase();
			return retryableStatuses.includes(s);
		});

		let toRetry = failedTables.map(t => t.table_name || t.table);
		if (requested) {
			// intersect requested with actually failed
			toRetry = requested.filter(r => toRetry.map(x => x.toUpperCase()).includes(r));
			if (toRetry.length === 0) {
				await pool.end();
				return res.status(400).json({
					success: false,
					error: `No requested tables match failed tables. Available failed tables: ${failedTables.map(t => t.table_name).join(', ')}`
				});
			}
		}

		if (!toRetry || toRetry.length === 0) {
			await pool.end();
			return res.status(400).json({
				success: false,
				error: "No failed tables to retry"
			});
		}

		// Load plan and mapping
		const planData = await runStore.getPlan(pool, runData.plan_id);
		if (!planData) {
			await pool.end();
			return res.status(404).json({
				success: false,
				error: "Plan not found"
			});
		}

		const mappingProfileId = await resolvePlanMappingProfileId(pool, planData);
		if (!mappingProfileId) {
			await pool.end();
			return res.status(400).json({
				success: false,
				error: "Plan is missing a mapping profile. Open the plan and re-select a profile or rebuild mapping."
			});
		}

		const mappingData = await runStore.getMappingProfile(pool, mappingProfileId);
		if (!mappingData) {
			await pool.end();
			return res.status(404).json({
				success: false,
				error: "Mapping profile not found"
			});
		}

		await pool.end();

		// Normalize plan and mapping the same way as a fresh run
		const { normalizePlanSteps } = require('../../migrate/planNormalize');
		const rawMappingJson = safeParseJson(mappingData.mapping_json || '{}');
		const normalizedMapping = normalizeMappingJson(rawMappingJson);
		normalizedMapping.planId = runData.plan_id || null;
		normalizedMapping.profileId = mappingProfileId;

		// plan_json may be stored in either 'plan_json' or 'mapping_json' column
		const rawPlanJson = safeParseJson(planData.plan_json || planData.mapping_json || '{}');
		const normalizedFullPlan = normalizePlanSteps(rawPlanJson, normalizedMapping);

		const failedTableNames = toRetry.map(t => String(t));
		// Filter to only the retry tables and force include:true so the runner processes them
		state.plan = normalizedFullPlan
			.filter(step => failedTableNames.map(f => f.toUpperCase()).includes(String(step.target || step.table).toUpperCase()))
			.map(step => ({ ...step, include: true, cleanBefore: false }));
		state.mapping = normalizedMapping;

		console.log(`[API] Retry requested for run ${runId}, tables: ${failedTableNames.join(', ')}`);
		// Start new migration run for failed tables using state.plan and state.mapping
		const { startMigration } = require("../../migrate/runner");
		const startResp = await startMigration({
			retryOfRunId: runId,
			firebirdConfig: state.firebird,
			mysqlConfig: state.mysql,
			schemaName: state.schemaName,
			plan: state.plan,
			mapping: state.mapping,
			dryRun: !!runData.dry_run,
			planConfig: rawPlanJson.config || {},
			batchSize: rawPlanJson?.config?.batchSize || 1000,
			fkChecks: true
		});

		res.json({
			success: true,
			runId: startResp.runId,
			retriedTables: failedTableNames,
			message: `Retrying ${failedTableNames.length} failed or unattempted table(s)`
		});
	} catch (err) {
		res.status(500).json({
			success: false,
			error: err.message
		});
	}
});

/**
 * DELETE /api/runs/:runId
 * Delete a run record
 */
router.delete("/runs/:runId", async (req, res) => {
	try {
		const { runId } = req.params;

		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);

		// Check if run exists
		const runData = await runStore.getRun(pool, runId);

		if (!runData) {
			await pool.end();
			return res.status(404).json({
				success: false,
				error: "Run not found"
			});
		}

		// Don't allow deletion of active runs
		if (runData.status === "RUNNING") {
			await pool.end();
			return res.status(400).json({
				success: false,
				error: "Cannot delete an active run"
			});
		}

		// Delete run and associated table records
		await pool.query("DELETE FROM migration_run_tables WHERE run_id = ?", [runId]);
		await pool.query("DELETE FROM migration_runs WHERE run_id = ?", [runId]);

		await pool.end();

		res.json({
			success: true,
			message: "Run deleted successfully"
		});
	} catch (err) {
		res.status(500).json({
			success: false,
			error: err.message
		});
	}
});

module.exports = router;
