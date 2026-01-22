/**
 * API Routes for Run Management
 * RESTful endpoints for managing and tracking migration execution
 */

const express = require("express");
const mysql = require("../../db/mysql");
const { state } = require("../../config/state");
const { Run, Plan, Mapping } = require("../../migrate/models");
const runStore = require("../../migrate/runStore");
const { getRunState } = require("../../migrate/runner");

const router = express.Router();

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
				mappingId: row.mapping_id,
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

		// Get mapping ID from plan - check both plan_json and mapping_json columns
		const rawPlanJson = planData.plan_json || planData.mapping_json || '{}';
		const planJson = typeof rawPlanJson === 'string'
			? JSON.parse(rawPlanJson)
			: (rawPlanJson || {});

		// Try multiple possible column names for mapping ID
		const mappingId = planData.mapping_id || planData.mappingId || planJson.mappingId || planJson.id;

		console.log('[Runs] Plan data:', {
			planId,
			hasMapping_id: !!planData.mapping_id,
			hasMappingId: !!planData.mappingId,
			jsonMappingId: planJson.mappingId,
			jsonId: planJson.id,
			resolvedMappingId: mappingId,
			planDataKeys: Object.keys(planData),
			planJsonKeys: Object.keys(planJson)
		});

		if (!mappingId) {
			await pool.end();
			return res.status(400).json({
				success: false,
				error: "Plan has no associated mapping"
			});
		}

		// Get mapping
		const mappingData = await runStore.getMappingProfile(pool, mappingId);
		if (!mappingData) {
			await pool.end();
			return res.status(404).json({
				success: false,
				error: "Mapping not found"
			});
		}

		const mappingJson = typeof mappingData.mapping_json === 'string'
			? JSON.parse(mappingData.mapping_json || '{}')
			: (mappingData.mapping_json || {});

		console.log('[Runs] Raw mapping from DB:', {
			mappingId,
			hasTables: !!mappingJson.tables,
			tablesType: typeof mappingJson.tables,
			tableCount: Object.keys(mappingJson.tables || {}).length,
			tableKeys: Object.keys(mappingJson.tables || {}).slice(0, 3),
			firstTableSample: Object.entries(mappingJson.tables || {}).slice(0, 1).map(([k, v]) => ({ source: k, targetTable: v?.targetTable, target: v?.target, hasColumns: !!v?.columns }))
		});

		const normalizePlanSteps = (plan, mappingForLookup) => {
			const defaultBatchSize = plan?.config?.batchSize || 1000;
			const defaults = {
				mode: 'INSERT',
				keyStrategy: 'preserve',
				dedupeKeys: [],
				onDuplicate: 'SKIP',
				cleanBefore: false,
				batchSize: defaultBatchSize
			};

			if (Array.isArray(plan)) {
				return plan;
			}

			const tables = plan?.tables;
			if (Array.isArray(tables)) {
				return tables.map((entry) => {
					if (typeof entry === 'string') {
						return { table: entry, include: true, ...defaults };
					}
					if (entry && typeof entry === 'object') {
						return {
							include: entry.include !== false,
							table: entry.table || entry.name || entry.targetTable || entry.target || entry.tableName,
							mode: entry.mode || defaults.mode,
							keyStrategy: entry.keyStrategy || defaults.keyStrategy,
							dedupeKeys: entry.dedupeKeys || defaults.dedupeKeys,
							onDuplicate: entry.onDuplicate || defaults.onDuplicate,
							cleanBefore: entry.cleanBefore || defaults.cleanBefore,
							batchSize: entry.batchSize || defaults.batchSize
						};
					}
					return null;
				}).filter(Boolean);
			}

			if (tables && typeof tables === 'object') {
				return Object.entries(tables).map(([tableName, config]) => {
					if (typeof config === 'string') {
						return { table: config, include: true, ...defaults };
					}
					// CRITICAL FIX: When loading from DB, tableName is SOURCE table
					// Look up target in mapping, fall back to config.target, then config.targetTable, then tableName
					let resolvedTable = config?.target || config?.targetTable;
					if (!resolvedTable && mappingForLookup?.tables?.[tableName]) {
						resolvedTable = mappingForLookup.tables[tableName].target ||
							mappingForLookup.tables[tableName].targetTable;
					}
					resolvedTable = resolvedTable || tableName;

					return {
						table: resolvedTable,
						include: config?.include !== false,
						mode: config?.mode || defaults.mode,
						keyStrategy: config?.keyStrategy || defaults.keyStrategy,
						dedupeKeys: config?.dedupeKeys || defaults.dedupeKeys,
						onDuplicate: config?.onDuplicate || defaults.onDuplicate,
						cleanBefore: config?.cleanBefore || defaults.cleanBefore,
						batchSize: config?.batchSize || defaults.batchSize
					};
				});
			}

			return [];
		};

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
						lookup: field?.lookup || null
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

		console.log('[Runs] Normalized plan (first 2):', JSON.stringify(normalizedPlan.slice(0, 2), null, 2));
		console.log('[Runs] Normalized mapping sample:', JSON.stringify({
			tableCount: Object.keys(normalizedMapping?.tables || {}).length,
			firstTable: Object.entries(normalizedMapping?.tables || {}).slice(0, 1).map(([k, v]) => ({ source: k, target: v?.target, columnCount: Object.keys(v?.columns || {}).length }))
		}, null, 2));

		await pool.end();

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
 * GET /api/runs/:runId
 * Get detailed information about a specific run
 */
router.get("/runs/:runId", async (req, res) => {
	try {
		const { runId } = req.params;

		const buildPlanAdapter = (tableNames = [], mappingId = null) => ({
			mappingId,
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
			const plan = buildPlanAdapter(includedTables, state.plan?.mappingId || null);
			const run = new Run(runId, plan);

			// Populate with current state data
			run.status = runState.status;
			run.startedAt = runState.startedAt || new Date();
			run.completedAt = runState.completedAt || null;
			run.dryRun = runState.dryRun || false;

			// Add table results
			(runState.tables || []).forEach(table => {
				if (table.status === "COMPLETED") {
					run.recordTableSuccess(table.name, {
						rowsMigrated: table.migrated,
						rowsInserted: table.inserted || 0,
						rowsUpdated: table.updated || 0,
						rowsSkipped: table.skippedDuplicates || 0,
						durationMs: table.durationMs || 0
					});
				} else if (table.status === "FAILED") {
					run.recordTableFailure(table.name, table.lastError?.message || "Unknown error", "Check logs");
				}
			});

			return res.json({
				success: true,
				run: run.toJSON(),
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
		const plan = buildPlanAdapter(tableNames, runData.plan_id || null);
		const run = new Run(runId, plan);
		run.status = runData.status;
		run.startedAt = runData.started_at;
		run.completedAt = runData.completed_at;
		run.dryRun = runData.dry_run;

		// Add table results
		(tables || []).forEach(table => {
			if (table.status === "COMPLETED") {
				run.recordTableSuccess(table.table_name, {
					rowsMigrated: table.rows_migrated || 0,
					rowsInserted: table.rows_inserted || 0,
					rowsUpdated: table.rows_updated || 0,
					rowsSkipped: table.rows_skipped_duplicates || 0,
					durationMs: 0
				});
			} else if (table.status === "FAILED") {
				run.recordTableFailure(table.table_name, table.error_message || "Unknown error", "");
			}
		});

		res.json({
			success: true,
			run: run.toJSON(),
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
				mappingId: state.plan?.mappingId || null,
				getIncludedTables: () => includedTables
			};
			const run = new Run(runKey, planAdapter);

			run.status = runState.status;
			run.startedAt = runState.startedAt || new Date();

			(runState.tables || []).forEach(table => {
				if (table.status === "COMPLETED") {
					run.recordTableSuccess(table.name, {
						rowsMigrated: table.migrated,
						rowsInserted: table.inserted || 0,
						rowsUpdated: table.updated || 0,
						rowsSkipped: table.skippedDuplicates || 0,
						durationMs: table.durationMs || 0
					});
				}
			});

			return res.json({
				success: true,
				runId: runKey,
				status: run.status,
				progress: run.getProgress(),
				percent: run.getProgress(),
				estimatedSecondsRemaining: run.getEstimatedSecondsRemaining(),
				tables: runState.tables || [],
				tablesCompleted: run.getCompletedTables().length,
				tablesTotal: includedTables.length,
				tablesFailed: run.getFailedTables().length
			});
		}

		// Load from database
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);

		const runData = await runStore.getRun(pool, runId);

		await pool.end();

		if (!runData) {
			return res.status(404).json({
				success: false,
				error: "Run not found"
			});
		}

		const progress = runData.tables_completed && runData.tables_total
			? Math.round((runData.tables_completed / runData.tables_total) * 100)
			: 0;

		res.json({
			success: true,
			runId: runKey,
			status: runData.status,
			progress: progress,
			percent: progress,
			tablesCompleted: runData.tables_completed || 0,
			tablesTotal: runData.tables_total || 0,
			tablesFailed: 0
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
			tables: {
				total: tables.length,
				completed: tables.filter(t => t.status === "COMPLETED").length,
				failed: tables.filter(t => t.status === "FAILED").length,
				pending: tables.filter(t => t.status === "PENDING").length
			},
			rows: {
				migrated: tables.reduce((sum, t) => sum + (t.rows_migrated || 0), 0),
				inserted: tables.reduce((sum, t) => sum + (t.rows_inserted || 0), 0),
				updated: tables.reduce((sum, t) => sum + (t.rows_updated || 0), 0),
				skipped: tables.reduce((sum, t) => sum + (t.rows_skipped_duplicates || 0), 0),
				errors: tables.reduce((sum, t) => sum + (t.rows_error || 0), 0)
			},
			errors: tables
				.filter(t => t.error_message)
				.map(t => ({
					tableName: t.table_name,
					message: t.error_message
				}))
		};

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
 * POST /api/runs/start
 * Start a new migration run
 */
router.post("/runs/start", async (req, res) => {
	try {
		const { planId, mappingId, dryRun = false } = req.body;

		if (!planId || !mappingId) {
			return res.status(400).json({
				success: false,
				error: "planId and mappingId are required"
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

		// Get mapping
		const mappingData = await runStore.getMappingProfile(pool, mappingId);
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

		// Request abort using runner
		const { requestAbort } = require("../../migrate/runner");
		requestAbort(runKey);

		res.json({
			success: true,
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

		// Get failed tables
		const tables = await runStore.getRunTables(pool, runId);
		const failedTables = tables.filter(t => t.status === "FAILED");

		if (failedTables.length === 0) {
			await pool.end();
			return res.status(400).json({
				success: false,
				error: "No failed tables to retry"
			});
		}

		// Load plan and mapping
		const planData = await runStore.getPlan(pool, runData.plan_id);
		const mappingData = await runStore.getMappingProfile(pool, runData.mapping_id);

		if (!planData || !mappingData) {
			await pool.end();
			return res.status(404).json({
				success: false,
				error: "Plan or mapping not found"
			});
		}

		await pool.end();

		// Update state with only failed tables
		const fullPlan = JSON.parse(planData.plan_json || "[]");
		const failedTableNames = failedTables.map(t => t.table_name);
		state.plan = fullPlan.filter(step => failedTableNames.includes(step.target || step.table));
		state.mapping = JSON.parse(mappingData.mapping_json || "{}");

		// Start new migration run for failed tables
		const { startMigration } = require("../../migrate/runner");
		const newRunId = await startMigration(runData.dry_run);

		res.json({
			success: true,
			runId: newRunId,
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
