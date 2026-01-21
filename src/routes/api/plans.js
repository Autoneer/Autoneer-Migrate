/**
 * API Routes for Plan Management
 * RESTful endpoints for creating, retrieving, updating, and validating migration plans
 */

const express = require("express");
const mysql = require("../../db/mysql");
const firebird = require("../../db/firebird");
const { state } = require("../../config/state");
const { Plan, Mapping, Schema } = require("../../migrate/models");
const { PlanValidator } = require("../../migrate/validators");
const runStore = require("../../migrate/runStore");

const router = express.Router();

async function getPlanTableColumns(pool) {
	const [rows] = await pool.query(
		"select column_name from information_schema.columns where table_schema = database() and table_name = 'migration_plans'"
	);
	return new Set(rows.map(row => row.COLUMN_NAME || row.column_name));
}

function getPlanJsonColumn(columns) {
	if (columns.has('plan_json')) return 'plan_json';
	if (columns.has('mapping_json')) return 'mapping_json';
	return null;
}

/**
 * Helper to get plan table metadata to avoid scoping bugs
 * Returns: { planJsonColumn, hasMappingId, hasIsValidated, hasName, hasMappingName }
 */
async function getPlanTableMeta(pool) {
	const columns = await getPlanTableColumns(pool);
	return {
		columns,
		planJsonColumn: getPlanJsonColumn(columns),
		hasMappingId: columns.has('mapping_id'),
		hasMappingName: columns.has('mapping_name'),
		hasIsValidated: columns.has('is_validated'),
		hasName: columns.has('name')
	};
}

/**
 * Safely parse a JSON field that may already be an object
 * @param {string|object} raw - Raw value from database
 * @param {object} fallback - Fallback value if parsing fails
 * @returns {object}
 */
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
 * POST /plans
 * Create a new migration plan from a mapping
 * Body: { mappingId: string, name?: string }
 */
router.post("/plans", async (req, res) => {
	try {
		const { mappingId, name, mapping: mappingPayload } = req.body;
		const resolvedMappingId = mappingId ?? mappingPayload?.id;

		if (!resolvedMappingId) {
			return res.status(400).json({
				success: false,
				error: "mappingId is required"
			});
		}

		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);
		const meta = await getPlanTableMeta(pool);
		const { planJsonColumn, hasMappingId, hasMappingName, hasName, hasIsValidated } = meta;

		// Load the mapping
		const profile = await runStore.getMappingProfile(pool, resolvedMappingId);

		if (!profile) {
			await pool.end();
			return res.status(404).json({
				success: false,
				error: "Mapping profile not found"
			});
		}

		const mappingData = safeParseJson(profile.mapping_json);
		const mapping = Mapping.fromJSON(mappingData);

		// Create plan from mapping
		const plan = Plan.fromMapping(mapping, name);
		const resolvedPlanName = (name || plan.name || mapping.name || mapping.mappingName || `Plan ${new Date().toLocaleDateString()}`).trim();
		plan.name = resolvedPlanName;
		const planJson = JSON.stringify(plan.toJSON());

		if (!planJsonColumn) {
			await pool.end();
			return res.status(500).json({
				success: false,
				error: "migration_plans table missing plan_json/mapping_json column"
			});
		}

		const insertFields = [];
		const insertValues = [];
		if (hasMappingId) {
			insertFields.push('mapping_id');
			insertValues.push(resolvedMappingId);
		}
		if (hasMappingName) {
			insertFields.push('mapping_name');
			insertValues.push(mapping.name || mapping.mappingName || name || '');
		}
		if (hasName) {
			insertFields.push('name');
			insertValues.push(plan.name);
		}
		insertFields.push(planJsonColumn);
		insertValues.push(planJson);
		if (hasIsValidated) {
			insertFields.push('is_validated');
			insertValues.push(false);
		}

		const [planResult] = await pool.query(
			`INSERT INTO migration_plans (${insertFields.join(', ')}) VALUES (${insertFields.map(() => '?').join(', ')})`,
			insertValues
		);

		const planId = planResult.insertId;
		console.log('[Plans] Created plan', { id: planId, name: plan.name, mappingId: resolvedMappingId });

		await pool.end();

		res.status(201).json({
			success: true,
			message: "Migration plan created",
			plan: {
				id: planId,
				mappingId: resolvedMappingId,
				name: plan.name,
				createdAt: new Date(),
				tables: plan.toJSON().tables
			}
		});
	} catch (err) {
		res.status(500).json({
			success: false,
			error: err.message
		});
	}
});

/**
 * GET /plans/:id
 * Retrieve a specific migration plan
 */
router.get("/plans/:id", async (req, res) => {
	try {
		const { id } = req.params;

		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);
		const meta = await getPlanTableMeta(pool);
		const { planJsonColumn, hasMappingId, hasIsValidated } = meta;

		const [rows] = await pool.query(
			"SELECT * FROM migration_plans WHERE plan_id = ?",
			[id]
		);

		await pool.end();

		if (!rows || rows.length === 0) {
			return res.status(404).json({
				success: false,
				error: "Plan not found"
			});
		}

		const planRow = rows[0];
		const rawPlanJson = planRow[planJsonColumn] || {};
		const planData = typeof rawPlanJson === 'string'
			? JSON.parse(rawPlanJson || '{}')
			: rawPlanJson;
		const plan = Plan.fromJSON(planData);

		res.json({
			success: true,
			plan: {
				id: planRow.plan_id,
				mappingId: hasMappingId ? planRow.mapping_id : plan.mappingId,
				name: plan.name,
				createdAt: planRow.created_at,
				isValidated: hasIsValidated ? planRow.is_validated : false,
				validationResult: plan.toJSON().validationResult,
				tables: plan.toJSON().tables
			}
		});
	} catch (err) {
		res.status(500).json({
			success: false,
			error: err.message
		});
	}
});

/**
 * PUT /plans/:id
 * Update an existing migration plan
 * Body: { name?: string, tables?: object }
 */
router.put("/plans/:id", async (req, res) => {
	try {
		const { id } = req.params;
		const { name, tables } = req.body;

		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);
		const meta = await getPlanTableMeta(pool);
		const { planJsonColumn, hasIsValidated, hasName } = meta;

		// Load existing plan
		const [rows] = await pool.query(
			"SELECT * FROM migration_plans WHERE plan_id = ?",
			[id]
		);

		if (!rows || rows.length === 0) {
			await pool.end();
			return res.status(404).json({
				success: false,
				error: "Plan not found"
			});
		}

		const planRow = rows[0];
		const rawPlanJson = planRow[planJsonColumn] || '{}';
		const planData = safeParseJson(rawPlanJson);
		const plan = Plan.fromJSON(planData);

		// Update name if provided
		if (name) {
			plan.name = name;
		}

		// Update table configurations if provided
		if (Array.isArray(tables)) {
			const normalizedTables = tables.filter(Boolean);
			const existingConfigs = {};
			for (const tableName of plan.getIncludedTables()) {
				existingConfigs[tableName] = plan.getTableConfig(tableName);
			}
			plan.tables = {};
			for (const tableName of normalizedTables) {
				const existing = existingConfigs[tableName];
				if (existing) {
					plan.addTable(tableName, existing);
				} else {
					plan.addTable(tableName, {});
				}
			}
		} else if (tables && typeof tables === "object") {
			for (const [tableName, config] of Object.entries(tables)) {
				if (plan.includesTable(tableName)) {
					plan.updateTable(tableName, config);
				} else {
					plan.addTable(tableName, config);
				}
			}
		}

		// Mark as not validated since it changed
		const updateFields = [];
		const updateValues = [];
		if (planJsonColumn) {
			updateFields.push(`${planJsonColumn} = ?`);
			updateValues.push(JSON.stringify(plan.toJSON()));
		}
		if (hasIsValidated) {
			updateFields.push(`is_validated = ?`);
			updateValues.push(false);
		}
		if (hasName && name) {
			updateFields.push(`name = ?`);
			updateValues.push(plan.name);
		}
		updateValues.push(id);
		await pool.query(
			`UPDATE migration_plans SET ${updateFields.join(', ')} WHERE plan_id = ?`,
			updateValues
		);

		await pool.end();

		res.json({
			success: true,
			message: "Plan updated",
			plan: {
				id: id,
				name: plan.name,
				isValidated: hasIsValidated ? false : false
			}
		});
	} catch (err) {
		res.status(500).json({
			success: false,
			error: err.message
		});
	}
});

/**
 * DELETE /plans/:id
 * Delete a migration plan
 */
router.delete("/plans/:id", async (req, res) => {
	try {
		const { id } = req.params;

		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);

		// Check if plan exists
		const [rows] = await pool.query(
			"SELECT plan_id FROM migration_plans WHERE plan_id = ?",
			[id]
		);

		if (!rows || rows.length === 0) {
			await pool.end();
			return res.status(404).json({
				success: false,
				error: "Plan not found"
			});
		}

		// Delete the plan
		await pool.query("DELETE FROM migration_plans WHERE plan_id = ?", [id]);

		await pool.end();

		res.json({
			success: true,
			message: "Plan deleted"
		});
	} catch (err) {
		res.status(500).json({
			success: false,
			error: err.message
		});
	}
});

/**
 * POST /plans/:id/validate
 * Validate a migration plan
 */
router.post("/plans/:id/validate", async (req, res) => {
	try {
		const { id } = req.params;

		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);
		const meta = await getPlanTableMeta(pool);
		const { planJsonColumn, hasMappingId, hasIsValidated } = meta;

		// Load plan
		const [planRows] = await pool.query(
			"SELECT * FROM migration_plans WHERE plan_id = ?",
			[id]
		);

		if (!planRows || planRows.length === 0) {
			await pool.end();
			return res.status(404).json({
				success: false,
				error: "Plan not found"
			});
		}

		const planRow = planRows[0];
		const rawPlanJson = planRow[planJsonColumn] || '{}';
		const planData = safeParseJson(rawPlanJson);
		const plan = Plan.fromJSON(planData);

		// Load mapping
		const mappingIdForPlan = hasMappingId ? planRow.mapping_id : plan.mappingId;
		const profile = await runStore.getMappingProfile(pool, mappingIdForPlan);

		if (!profile) {
			await pool.end();
			return res.status(404).json({
				success: false,
				error: "Associated mapping not found"
			});
		}

		const mappingData = safeParseJson(profile.mapping_json);
		const mapping = Mapping.fromJSON(mappingData);

		// Discover schemas
		const schema = new Schema();
		await schema.discoverFirebird(state.firebird);
		await schema.discoverMySQL(pool, state.schemaName);

		// Validate plan
		const validation = await PlanValidator.validate(plan, mapping, schema, {
			firebird: state.firebird,
			mysql: pool
		});

		// Record validation in plan
		plan.recordValidation(validation);

		// Update plan in database
		const updateFields = [];
		const updateValues = [];
		if (planJsonColumn) {
			updateFields.push(`${planJsonColumn} = ?`);
			updateValues.push(JSON.stringify(plan.toJSON()));
		}
		if (hasIsValidated) {
			updateFields.push(`is_validated = ?`);
			updateValues.push(validation.canProceed);
		}
		updateValues.push(id);
		await pool.query(
			`UPDATE migration_plans SET ${updateFields.join(', ')} WHERE plan_id = ?`,
			updateValues
		);

		await pool.end();

		res.json({
			success: true,
			validation: {
				canProceed: validation.canProceed,
				errors: validation.errors,
				warnings: validation.warnings,
				tables: validation.tables
			}
		});
	} catch (err) {
		res.status(500).json({
			success: false,
			error: err.message
		});
	}
});

/**
 * POST /plans/:id/dry-run
 * Perform a dry-run simulation of the migration plan
 * If tableName is provided: runs per-table dry run
 * If tableName is missing: runs plan-level dry run across all tables
 */
router.post("/plans/:id/dry-run", async (req, res) => {
	try {
		const { id } = req.params;
		const { tableName } = req.body;

		console.log(`[Dry Run] Request for plan ${id}`, { tableName: tableName || '(all tables)' });

		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);

		// Get plan table metadata
		const meta = await getPlanTableMeta(pool);
		const { planJsonColumn, hasMappingId } = meta;

		// Load plan
		const [planRows] = await pool.query(
			"SELECT * FROM migration_plans WHERE plan_id = ?",
			[id]
		);

		if (!planRows || planRows.length === 0) {
			await pool.end();
			return res.status(404).json({
				success: false,
				error: "Plan not found"
			});
		}

		const planRow = planRows[0];
		const rawPlanJson = planRow[planJsonColumn] || '{}';
		const planData = safeParseJson(rawPlanJson);
		const plan = Plan.fromJSON(planData);

		// Load mapping
		const mappingIdForPlan = hasMappingId ? planRow.mapping_id : plan.mappingId;
		const profile = await runStore.getMappingProfile(pool, mappingIdForPlan);

		if (!profile) {
			await pool.end();
			return res.status(404).json({
				success: false,
				error: "Associated mapping not found"
			});
		}

		const mappingData = safeParseJson(profile.mapping_json);
		const mapping = Mapping.fromJSON(mappingData);

		// Discover schemas
		const schema = new Schema();
		await schema.discoverFirebird(state.firebird);
		await schema.discoverMySQL(state.mysql, state.schemaName);

		await pool.end();

		const runTableDryRun = async (targetTable) => {
			const sourceTable = mapping.getSourceTable(targetTable);
			if (!sourceTable) {
				return {
					success: false,
					sampleRow: null,
					transformedRow: null,
					errors: [`No mapping found for target table: ${targetTable}`],
					warnings: []
				};
			}

			const fieldMaps = mapping.getFieldMaps(sourceTable);
			if (!fieldMaps || fieldMaps.size === 0) {
				return {
					success: false,
					sampleRow: null,
					transformedRow: null,
					errors: [`No field mapping found for source table: ${sourceTable}`],
					warnings: []
				};
			}

			const columns = Array.from(fieldMaps.keys());
			let sampleRow = null;
			try {
				const rows = await firebird.fetchBatch(state.firebird, sourceTable, columns, 0, 1);
				sampleRow = rows?.[0] || null;
			} catch (err) {
				return {
					success: false,
					sampleRow: null,
					transformedRow: null,
					errors: [`Failed to fetch sample row from ${sourceTable}: ${err.message}`],
					warnings: []
				};
			}

			if (!sampleRow) {
				return {
					success: true,
					sampleRow: null,
					transformedRow: null,
					errors: [],
					warnings: [`No rows found in source table ${sourceTable}`]
				};
			}

			const dryRunResult = await PlanValidator.dryRun(sampleRow, mapping, sourceTable);
			const transformedRow = {};
			for (const [srcCol, field] of fieldMaps) {
				const sourceValue = sampleRow[srcCol.toLowerCase()] ?? sampleRow[srcCol.toUpperCase()] ?? sampleRow[srcCol];
				let value = sourceValue;
				if (field.transform && value !== null && value !== undefined) {
					try {
						value = PlanValidator.applyTransform(field.transform, value);
					} catch (err) {
						// Leave value as-is; dryRunResult will include transform errors
					}
				}
				if ((value === null || value === undefined) && field.defaultValue !== null && field.defaultValue !== undefined) {
					value = field.defaultValue;
				}
				transformedRow[field.targetColumn] = value;
			}

			return {
				success: dryRunResult.migratable,
				sampleRow,
				transformedRow,
				errors: dryRunResult.issues || [],
				warnings: []
			};
		};

		// If tableName provided: run per-table dry run
		if (tableName) {
			const dryRunResult = await runTableDryRun(tableName);

			return res.json({
				success: true,
				dryRun: {
					tableName: tableName,
					success: dryRunResult.success,
					sampleRow: dryRunResult.sampleRow,
					transformedRow: dryRunResult.transformedRow,
					errors: dryRunResult.errors,
					warnings: dryRunResult.warnings
				}
			});
		}

		// Plan-level dry run across all tables
		const tables = typeof plan.getIncludedTables === 'function'
			? plan.getIncludedTables()
			: (Array.isArray(plan.tables) ? plan.tables : Object.keys(plan.tables || {}));
		const perTableResults = [];
		let totalEstimatedRows = 0;
		let totalWarnings = 0;
		let totalErrors = 0;

		for (const table of tables) {
			try {
				const result = await runTableDryRun(table);

				const estimatedRows = result.sampleRow ? 1000 : 0; // Default estimate
				totalEstimatedRows += estimatedRows;
				totalWarnings += (result.warnings || []).length;
				totalErrors += (result.errors || []).length;

				perTableResults.push({
					tableName: table,
					estimatedRows,
					warnings: result.warnings || [],
					errors: result.errors || []
				});
			} catch (err) {
				perTableResults.push({
					tableName: table,
					estimatedRows: 0,
					warnings: [],
					errors: [`Failed to validate: ${err.message}`]
				});
				totalErrors++;
			}
		}

		res.json({
			success: true,
			results: {
				tableCount: tables.length,
				estimatedRows: totalEstimatedRows,
				estimatedTime: `${Math.ceil(totalEstimatedRows / 100)} seconds`,
				perTable: perTableResults,
				totals: {
					estimatedRows: totalEstimatedRows,
					warningsCount: totalWarnings,
					errorsCount: totalErrors
				},
				warnings: perTableResults.flatMap(t => t.warnings.map(w => `${t.tableName}: ${w}`)),
				errors: perTableResults.flatMap(t => t.errors.map(e => `${t.tableName}: ${e}`))
			}
		});
	} catch (err) {
		console.error('[Dry Run] Error:', err);
		res.status(500).json({
			success: false,
			error: { message: err.message, details: err.stack }
		});
	}
});

/**
 * POST /plans/estimate
 * Estimate migration time and resource requirements
 * Body: { planId: string }
 */
router.post("/plans/estimate", async (req, res) => {
	try {
		const { planId } = req.body;

		if (!planId) {
			return res.status(400).json({
				success: false,
				error: "planId is required"
			});
		}

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

		const planJson = planData[planJsonColumn] || planData.plan_json || planData.mapping_json || "[]";
		const plan = JSON.parse(planJson || "[]");
		const includedTables = plan.filter(step => step.include !== false);

		await pool.end();

		// Estimate row counts and duration
		let totalRows = 0;
		let estimatedSeconds = 0;
		const ROWS_PER_SECOND = 100; // Conservative estimate

		for (const step of includedTables) {
			const rowCount = step.rowCount || 1000; // Default estimate
			totalRows += rowCount;
			estimatedSeconds += Math.ceil(rowCount / ROWS_PER_SECOND);
		}

		res.json({
			success: true,
			estimate: {
				totalTables: includedTables.length,
				totalRows: totalRows,
				estimatedSeconds: estimatedSeconds,
				estimatedMinutes: Math.ceil(estimatedSeconds / 60),
				estimatedHours: Math.ceil(estimatedSeconds / 3600)
			}
		});
	} catch (err) {
		res.status(500).json({
			success: false,
			error: err.message
		});
	}
});

/**
 * GET /plans
 * List all migration plans
 */
router.get("/plans", async (req, res) => {
	try {
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);
		const meta = await getPlanTableMeta(pool);
		const { hasMappingId, hasIsValidated } = meta;

		const selectFields = ['plan_id', 'created_at'];
		if (hasMappingId) selectFields.push('mapping_id');
		if (hasIsValidated) selectFields.push('is_validated');
		const [rows] = await pool.query(
			`SELECT ${selectFields.join(', ')} FROM migration_plans ORDER BY created_at DESC`
		);

		await pool.end();

		res.json({
			success: true,
			count: rows.length,
			plans: rows.map(row => ({
				id: row.plan_id,
				mappingId: hasMappingId ? row.mapping_id : null,
				createdAt: row.created_at,
				isValidated: hasIsValidated ? row.is_validated : false
			}))
		});
	} catch (err) {
		res.status(500).json({
			success: false,
			error: err.message
		});
	}
});

module.exports = router;
