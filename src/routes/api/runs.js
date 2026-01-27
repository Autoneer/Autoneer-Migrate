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
 * Normalize table status to UI-friendly values
 */
function normalizeTableStatus(s) {
	const st = String(s || '').toUpperCase();
	switch (st) {
		case 'QUEUED':
		case 'PENDING':
		case 'NOT_RUN':
			return 'pending';
		case 'RUNNING':
			return 'running';
		case 'COMPLETED':
		case 'SUCCESS':
			return 'completed';
		case 'FAILED':
			return 'failed';
		case 'CANCELLED':
		case 'STOPPED':
			return 'skipped';
		case 'SKIPPED':
			return 'skipped';
		default:
			return 'pending';
	}
}

function normalizeTables(runStateTables) {
	if (!Array.isArray(runStateTables)) return [];
	return runStateTables.map(t => {
		const migrated = Number(t.migrated ?? t.rowsMigrated ?? t.rows_migrated ?? 0) || 0;
		const total = (t.total == null ? null : Number(t.total));
		const progress = (total ? Math.min(100, Math.round((migrated / total) * 100)) : 0);

		return {
			table: t.name || t.table || t.table_name || '',
			status: normalizeTableStatus(t.status || t.state),
			rowsProcessed: migrated,
			totalRows: total,
			progress: progress,
			duration: Number(t.durationMs ?? t.duration_ms ?? t.duration ?? 0) || 0,
			inserted: Number(t.inserted ?? t.rowsInserted ?? t.rows_inserted ?? 0) || 0,
			updated: Number(t.updated ?? t.rowsUpdated ?? t.rows_updated ?? 0) || 0,
			skippedDuplicates: Number(t.skippedDuplicates ?? t.rowsSkipped ?? t.rows_skipped_duplicates ?? 0) || 0,
			errors: Number(t.errors ?? t.rowsError ?? t.rows_error ?? 0) || 0,
			lastError: t.lastError ?? t.error_message ?? null
		};
	});
}

async function resolvePlanMappingProfileId(pool, planRow) {
	if (planRow.mapping_profile_id) {
		return planRow.mapping_profile_id;
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
		res.status(500).json({
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

		const normalizeMapping = (mapping) => {
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
						omit: field?.omit || false  // Preserve omit flag
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
		};

		const normalizedMapping = normalizeMapping(mappingJson);
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
		res.status(500).json({
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
			run.completedAt = runState.completedAt ? new Date(runState.completedAt) : null;
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

			const runJson = run.toJSON();
			// UI-friendly aliases expected by client-side RunUI
			runJson.tablesCompleted = run.getCompletedTables().length;
			runJson.rowsMigrated = run.totals?.migrated ?? ((run.totals?.inserted || 0) + (run.totals?.updated || 0));
			runJson.duration = run.finishedAt ? (new Date(run.finishedAt) - new Date(run.startedAt)) : (Date.now() - new Date(run.startedAt));

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

		await pool.end();

		// Reconstruct Run instance
		const tableNames = (tables || []).map(table => table.table_name).filter(Boolean);
		const plan = buildPlanAdapter(tableNames, runData.plan_id || null, null);
		const run = new Run(runId, plan);
		run.status = runData.status;
		run.startedAt = runData.started_at;
		run.completedAt = runData.completed_at;
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

		const runJson = run.toJSON();
		runJson.tablesCompleted = run.getCompletedTables().length;
		runJson.rowsMigrated = run.totals?.migrated ?? ((run.totals?.inserted || 0) + (run.totals?.updated || 0));
		runJson.duration = run.finishedAt ? (new Date(run.finishedAt) - new Date(run.startedAt)) : (Date.now() - new Date(run.startedAt));
		// Attach plan/mapping ids for metadata lookup
		runJson.planId = runData.plan_id || null;
		if (runData.plan_id) {
			try {
				const planRow = await runStore.getPlan(pool, runData.plan_id);
				runJson.mappingProfileId = planRow?.mapping_profile_id || null;
			} catch (e) {
				runJson.mappingProfileId = null;
			}
		} else {
			runJson.mappingProfileId = null;
		}

		res.json({
			success: true,
			run: runJson,
			progress: run.getProgress(),
			estimatedSecondsRemaining: run.getEstimatedSecondsRemaining()
		});
	} catch (err) {
		res.status(500).json({
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
	try {
		const { runId } = req.params;
		const numericRunId = Number(runId);
		const runKey = Number.isNaN(numericRunId) ? runId : numericRunId;

		// Check in-memory state first (active run)
		const runState = getRunState(runKey);
		if (runState) {
			const planSteps = Array.isArray(state.plan) ? state.plan : [];
			let includedTables = planSteps.filter(step => step?.include).map(step => step.table).filter(Boolean);
			if (includedTables.length === 0) {
				includedTables = (runState.tables || []).map(table => table.name).filter(Boolean);
			}
			const planAdapter = {
				mappingProfileId: state.plan?.mappingProfileId || state.plan?.mappingId || null,
				getIncludedTables: () => includedTables
			};
			const run = new Run(runKey, planAdapter);

			run.status = runState.status;
			run.startedAt = runState.startedAt ? new Date(runState.startedAt) : new Date();

			(runState.tables || []).forEach(table => {
				if (table.status === "COMPLETED") {
					const stats = {
						inserted: table.inserted || table.rowsInserted || 0,
						updated: table.updated || table.rowsUpdated || 0,
						skipped: table.skippedDuplicates || table.rowsSkipped || 0,
						errors: table.rowsError || table.rows_error || 0,
						durationMs: table.durationMs || table.duration_ms || 0
					};
					run.recordTableSuccess(table.name, stats);
				}
			});

			// Normalize table rows for UI
			const normalizedTables = normalizeTables(runState.tables || []);

			// compute overall percent based on normalized tables and includedTables
			const tablesTotal = (includedTables && includedTables.length) || normalizedTables.length || 0;
			let fractionSum = 0;
			let countCompleted = 0;
			let countFailed = 0;
			for (const t of normalizedTables) {
				if (t.status === 'completed') {
					fractionSum += 1;
					countCompleted += 1;
				} else if (t.status === 'running') {
					if (t.totalRows && t.totalRows > 0) {
						fractionSum += (t.rowsProcessed / t.totalRows);
					} else {
						fractionSum += 0;
					}
				} else if (t.status === 'failed') {
					countFailed += 1;
					// do not count failed as completed
				} else {
					// pending/skipped => 0
				}
			}

			const overallPercent = tablesTotal > 0 ? Math.round((fractionSum / tablesTotal) * 100) : 0;

			return res.json({
				success: true,
				runId: runKey,
				status: run.status,
				progress: overallPercent,
				percent: overallPercent,
				estimatedSecondsRemaining: run.getEstimatedSecondsRemaining(),
				tables: normalizedTables,
				tablesCompleted: countCompleted,
				tablesTotal: tablesTotal,
				tablesFailed: countFailed
			});
		}

		// Load from database
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);

		const runData = await runStore.getRun(pool, runId);

		// Load table rows so UI can render details for DB-loaded runs
		const dbTables = await runStore.getRunTables(pool, runId);

		await pool.end();

		if (!runData) {
			return res.status(404).json({
				success: false,
				error: "Run not found"
			});
		}

		// Normalize DB tables for UI
		const normalizedTables = normalizeTables(dbTables || []);

		// Compute overall percent similarly to in-memory path
		const tablesTotal = (runData.tables_total && Number(runData.tables_total)) || normalizedTables.length || 0;
		let fractionSum = 0;
		let countCompleted = 0;
		let countFailed = 0;
		for (const t of normalizedTables) {
			if (t.status === 'completed') {
				fractionSum += 1;
				countCompleted += 1;
			} else if (t.status === 'running') {
				if (t.totalRows && t.totalRows > 0) {
					fractionSum += (t.rowsProcessed / t.totalRows);
				} else {
					fractionSum += 0;
				}
			} else if (t.status === 'failed') {
				countFailed += 1;
			}
		}

		const overallPercent = tablesTotal > 0 ? Math.round((fractionSum / tablesTotal) * 100) : 0;

		res.json({
			success: true,
			runId: runKey,
			status: runData.status,
			progress: overallPercent,
			percent: overallPercent,
			estimatedSecondsRemaining: null,
			tables: normalizedTables,
			tablesCompleted: countCompleted || (runData.tables_completed || 0),
			tablesTotal: tablesTotal,
			tablesFailed: countFailed || 0
		});
	} catch (err) {
		res.status(500).json({
			success: false,
			error: err.message
		});
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

		const tables = await runStore.getRunTables(pool, runId);

		await pool.end();

		// Ensure tables is always an array
		const tableArray = Array.isArray(tables) ? tables : [];

		// Calculate summary statistics
		const summary = {
			runId: runId,
			status: runData.status,
			dryRun: runData.dry_run,
			startedAt: runData.started_at,
			completedAt: runData.completed_at,
			durationMs: runData.completed_at && runData.started_at
				? new Date(runData.completed_at) - new Date(runData.started_at)
				: null,
			tableCount: tableArray.length,
			successCount: tableArray.filter(t => {
				const s = String(t.status || '').toUpperCase();
				return s === 'COMPLETED' || s === 'SUCCESS';
			}).length,
			failedCount: tableArray.filter(t => String(t.status || '').toUpperCase() === 'FAILED').length,
			errorCount: tableArray.filter(t => t.error_message).length,
			tables: {
				total: tableArray.length,
				completed: tableArray.filter(t => {
					const s = String(t.status || '').toUpperCase();
					return s === 'COMPLETED' || s === 'SUCCESS';
				}).length,
				failed: tableArray.filter(t => String(t.status || '').toUpperCase() === 'FAILED').length,
				pending: tableArray.filter(t => String(t.status || '').toUpperCase() === 'PENDING').length
			},
			tableDetails: tableArray.map(t => ({
				name: t.table_name,
				status: t.status,
				rowsMigrated: t.rows_migrated || 0,
				rowsInserted: t.rows_inserted || 0,
				rowsUpdated: t.rows_updated || 0,
				rowsSkipped: t.rows_skipped_duplicates || 0,
				rowsError: t.rows_error || 0,
				duration: t.duration_ms || 0,
				errorCount: t.rows_error || 0,
				errorMessage: t.error_message || null
			})),
			rows: {
				migrated: tableArray.reduce((sum, t) => sum + (t.rows_migrated || 0), 0),
				inserted: tableArray.reduce((sum, t) => sum + (t.rows_inserted || 0), 0),
				updated: tableArray.reduce((sum, t) => sum + (t.rows_updated || 0), 0),
				skipped: tableArray.reduce((sum, t) => sum + (t.rows_skipped_duplicates || 0), 0),
				errors: tableArray.reduce((sum, t) => sum + (t.rows_error || 0), 0)
			},
			errors: tableArray
				.filter(t => t.error_message)
				.map(t => ({
					tableName: t.table_name,
					message: t.error_message
				}))
		};

		// Backwards-compatible aliases expected by frontend
		summary.totalTables = summary.tableCount;
		summary.tablesMigrated = summary.successCount;
		summary.rowsMigrated = summary.rows?.migrated ?? 0;
		summary.totalRows = summary.rows?.migrated ?? 0;
		summary.errors = summary.rows?.errors ?? summary.errorCount ?? 0;
		summary.duration = summary.durationMs;

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

		const errors = (rawErrors || []).map(err => ({
			table: err.table_name || err.table || null,
			message: err.message || err.error_message || err.error || 'Unknown error',
			timestamp: err.created_at || err.timestamp || null,
			row: err.source_pk || err.row_offset || null,
			column: err.field_name || null,
			value: err.value || null,
			stack: err.stack || null
		}));

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
		let logs = logger.getLogBuffer(runId) || [];
		if (!logs.length) {
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
		const tables = await runStore.getRunTables(pool, runId);
		const requested = Array.isArray(req.body?.tables) ? req.body.tables.map(t => String(t).toUpperCase()) : null;
		const failedTables = (tables || []).filter(t => String(t.status || '').toUpperCase() === 'FAILED');

		let toRetry = failedTables.map(t => t.table_name);
		if (requested) {
			// intersect requested with actually failed
			toRetry = requested.filter(r => toRetry.map(x => x.toUpperCase()).includes(r));
			if (toRetry.length === 0) {
				await pool.end();
				return res.status(400).json({
					success: false,
					error: `No requested tables match failed tables. Available failed tables: ${failedTables.map(t=>t.table_name).join(', ')}`
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

		// Update state with only failed tables
		const fullPlan = JSON.parse(planData.plan_json || "[]");
		const failedTableNames = toRetry.map(t => String(t));
		state.plan = fullPlan.filter(step => failedTableNames.map(f=>f.toUpperCase()).includes(String(step.target || step.table).toUpperCase()));
		state.mapping = JSON.parse(mappingData.mapping_json || "{}");

		console.log(`[API] Retry requested for run ${runId}, tables: ${failedTableNames.join(', ')}`);
		// Start new migration run for failed tables using state.plan and state.mapping
		const { startMigration } = require("../../migrate/runner");
		const startResp = await startMigration({
			firebirdConfig: state.firebird,
			mysqlConfig: state.mysql,
			schemaName: state.schemaName,
			plan: state.plan,
			mapping: state.mapping,
			dryRun: !!runData.dry_run,
			batchSize: state.plan?.config?.batchSize || 1000,
			fkChecks: true
		});

		res.json({
			success: true,
			runId: startResp.runId,
			retriedTables: failedTableNames,
			message: `Retrying ${failedTableNames.length} failed table(s)`
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
