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
const { normalizePlanTables, needsNormalization, resolveTargetTableName } = require("../../migrate/utils/tableNameCanonical");

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
 * Returns: { planJsonColumn, hasMappingProfileId, hasMappingId, hasIsValidated, hasName, hasMappingName, hasMappingJson }
 */
async function getPlanTableMeta(pool) {
	const columns = await getPlanTableColumns(pool);
	return {
		columns,
		planJsonColumn: getPlanJsonColumn(columns),
		hasMappingProfileId: columns.has('mapping_profile_id'),
		hasMappingId: columns.has('mapping_id'),
		hasMappingName: columns.has('mapping_name'),
		hasIsValidated: columns.has('is_validated'),
		hasName: columns.has('name'),
		hasMappingJson: columns.has('mapping_json')
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
 * Resolve mapping profile id for a plan row, migrating legacy data if needed.
 * @returns {Promise<{ mappingProfileId: number|null, migrated: boolean }>
 */
async function resolvePlanMappingProfileId(pool, planRow, meta) {
	const { planJsonColumn, hasMappingProfileId, hasMappingId, hasMappingJson } = meta;

	if (hasMappingProfileId && planRow.mapping_profile_id) {
		return { mappingProfileId: planRow.mapping_profile_id, migrated: false };
	}

	// Legacy mapping_id column pointing at mapping profiles
	if (hasMappingId && planRow.mapping_id) {
		const profile = await runStore.getMappingProfile(pool, planRow.mapping_id);
		if (profile) {
			if (hasMappingProfileId) {
				await pool.query(
					"UPDATE migration_plans SET mapping_profile_id = ? WHERE plan_id = ?",
					[profile.id, planRow.plan_id]
				);
			}
			return { mappingProfileId: profile.id, migrated: true };
		}
	}

	// Legacy mapping_json stored on plan
	if (hasMappingJson && planRow.mapping_json) {
		const mappingData = safeParseJson(planRow.mapping_json, null);
		if (mappingData) {
			const derivedName = (mappingData.name || planRow.name || `Migrated Profile ${planRow.plan_id}`).trim();
			const [result] = await pool.query(
				"INSERT INTO migration_mapping_profiles (name, mapping_json) VALUES (?, ?)",
				[derivedName, JSON.stringify(mappingData)]
			);
			const newProfileId = result.insertId;
			if (hasMappingProfileId) {
				await pool.query(
					"UPDATE migration_plans SET mapping_profile_id = ? WHERE plan_id = ?",
					[newProfileId, planRow.plan_id]
				);
			}
			return { mappingProfileId: newProfileId, migrated: true };
		}
	}

	// Legacy mapping id in plan_json
	if (planJsonColumn) {
		const planJson = safeParseJson(planRow[planJsonColumn], {});
		const legacyId = planJson.mappingProfileId || planJson.mappingId || null;
		if (legacyId) {
			const profile = await runStore.getMappingProfile(pool, legacyId);
			if (profile) {
				if (hasMappingProfileId) {
					await pool.query(
						"UPDATE migration_plans SET mapping_profile_id = ? WHERE plan_id = ?",
						[profile.id, planRow.plan_id]
					);
				}
				return { mappingProfileId: profile.id, migrated: true };
			}
		}
	}

	return { mappingProfileId: null, migrated: false };
}

/**
 * POST /plans
 * Create a new migration plan from a mapping or from full plan config
 * Body: { mappingProfileId: string, name?: string, tables?: Array|Object, config?: Object }
 * If 'plan' object with full config is provided, it will be persisted as-is.
 * Otherwise, fallback to creating from mapping (legacy behavior).
 */
router.post("/plans", async (req, res) => {
	try {
		// Support both req.body.plan and top-level fields for flexibility
		const bodyPlan = req.body.plan;
		const { mappingProfileId, mappingId, name, mapping: mappingPayload, tables, config, saveAsProfile } = req.body;
		const resolvedMappingProfileId = (bodyPlan?.mappingProfileId) ?? mappingProfileId ?? mappingId ?? mappingPayload?.mappingProfileId ?? mappingPayload?.id;

		if (saveAsProfile !== undefined) {
			console.debug('[Plans] Ignoring legacy saveAsProfile flag');
		}

		if (!resolvedMappingProfileId) {
			return res.status(400).json({
				success: false,
				error: "mappingProfileId is required"
			});
		}

		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);
		const meta = await getPlanTableMeta(pool);
		const { planJsonColumn, hasMappingProfileId, hasMappingName, hasName, hasIsValidated } = meta;

		if (!hasMappingProfileId) {
			await pool.end();
			return res.status(500).json({
				success: false,
				error: "migration_plans table missing mapping_profile_id column"
			});
		}

		// Load the mapping profile
		const profile = await runStore.getMappingProfile(pool, resolvedMappingProfileId);

		if (!profile) {
			await pool.end();
			return res.status(404).json({
				success: false,
				error: "Mapping profile not found"
			});
		}

		const mappingData = safeParseJson(profile.mapping_json);
		const mapping = Mapping.fromJSON(mappingData);

		// Determine if we have a full plan config to persist
		// Priority: req.body.plan > top-level fields from wizard
		let plan;
		if (bodyPlan && bodyPlan.config && Array.isArray(bodyPlan.tables)) {
			// Full plan config provided - use it as-is
			console.log('[Plans] Creating plan from full config payload');
			plan = Plan.fromJSON(bodyPlan);
			plan.mappingProfileId = resolvedMappingProfileId;
		} else if ((tables || config) && resolvedMappingProfileId) {
			// Partial full config from wizard - merge with mapping defaults
			console.log('[Plans] Creating plan from partial wizard config');
			plan = Plan.fromMapping(mapping, {});

			// Apply config overrides
			if (config) {
				plan.config = { ...plan.config, ...config };
			}

			// Apply table config overrides with canonical normalization
			if (Array.isArray(tables)) {
				// Build enriched table objects from array
				const enrichedTables = tables.map(entry => {
					if (typeof entry === 'string') {
						return { table: entry };
					}
					return entry;
				}).filter(e => e.table);

				// Normalize to target table names ONLY
				const normalized = normalizePlanTables(
					enrichedTables.reduce((acc, e) => {
						const key = e.table || e.name || e.targetTable;
						if (key) {
							acc[key] = {
								mode: e.mode || 'INSERT',
								keyStrategy: e.keyStrategy || 'preserve',
								onDuplicate: e.onDuplicate || 'SKIP',
								dedupeKeys: e.dedupeKeys || [],
								batchSize: e.batchSize,
								cleanBefore: e.cleanBefore
							};
						}
						return acc;
					}, {}),
					mappingData
				);

				// Replace plan.tables with normalized (TARGET names only)
				plan.tables = normalized.tablesObject;
				console.log('[Plans] Normalized table keys to targets:', Object.keys(normalized.tablesObject));
			}
		} else {
			// Legacy behavior - create from mapping only (already uses target names)
			console.log('[Plans] Creating plan from mapping only (legacy)');
			plan = Plan.fromMapping(mapping, {});
		}

		// Ensure plan uses config object if provided
		if (config) {
			plan.config = { ...plan.config, ...config };
		}

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
		insertFields.push('mapping_profile_id');
		insertValues.push(resolvedMappingProfileId);
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
		console.log('[Plans] Created plan', { id: planId, name: plan.name, mappingProfileId: resolvedMappingProfileId });

		await pool.end();

		res.status(201).json({
			success: true,
			message: "Migration plan created",
			plan: {
				id: planId,
				mappingProfileId: resolvedMappingProfileId,
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
		const { planJsonColumn, hasMappingProfileId, hasIsValidated } = meta;

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
		const rawPlanJson = planRow[planJsonColumn] || {};
		const planData = typeof rawPlanJson === 'string'
			? JSON.parse(rawPlanJson || '{}')
			: rawPlanJson;
		const plan = Plan.fromJSON(planData);
		const { mappingProfileId } = await resolvePlanMappingProfileId(pool, planRow, meta);
		let mappingProfileName = null;
		let mappingData = null;

		if (mappingProfileId) {
			const profile = await runStore.getMappingProfile(pool, mappingProfileId);
			mappingProfileName = profile?.name || null;
			if (profile) {
				mappingData = safeParseJson(profile.mapping_json);
			}
		}

		// SELF-HEAL: Normalize plan tables to target names if needed
		let normalized = null;
		if (mappingData && plan.tables) {
			normalized = normalizePlanTables(plan.tables, mappingData);

			// Check if normalization changed keys
			if (needsNormalization(plan.tables, mappingData)) {
				console.warn('[Plans] Auto-repairing plan tables to target-table keys', {
					planId: id,
					before: Object.keys(plan.tables),
					after: Object.keys(normalized.tablesObject)
				});

				// Update plan in-memory
				plan.tables = normalized.tablesObject;

				// Write back to DB (self-heal)
				const repairedPlanJson = JSON.stringify(plan.toJSON());
				await pool.query(
					`UPDATE migration_plans SET ${planJsonColumn} = ? WHERE plan_id = ?`,
					[repairedPlanJson, id]
				);
			}
		}

		await pool.end();

		// Prepare response: tables as ARRAY (for UI), tableConfigs as OBJECT (for per-table settings)
		const planJson = plan.toJSON();
		const tableConfigs = planJson.tables || {};
		const tableList = Object.keys(tableConfigs); // Extract target table names as array

		res.json({
			success: true,
			plan: {
				id: planRow.plan_id,
				mappingProfileId: mappingProfileId || plan.mappingProfileId,
				mappingProfileName,
				name: plan.name,
				createdAt: planRow.created_at,
				isValidated: hasIsValidated ? planRow.is_validated : false,
				validationResult: planJson.validationResult,
				tables: tableList,        // ARRAY of target table names for UI
				tableConfigs: tableConfigs, // OBJECT with per-table configs
				config: planJson.config || null // Global config (batchSize, continueOnError, etc.)
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

		// Load mapping for normalization
		const { mappingProfileId } = await resolvePlanMappingProfileId(pool, planRow, meta);
		let mappingData = null;
		if (mappingProfileId) {
			const profile = await runStore.getMappingProfile(pool, mappingProfileId);
			if (profile) {
				mappingData = safeParseJson(profile.mapping_json);
			}
		}

		// Update name if provided
		if (name) {
			plan.name = name;
		}

		// Update table configurations if provided with normalization
		if (tables && mappingData) {
			// Normalize tables to target names
			const normalized = normalizePlanTables(tables, mappingData);
			plan.tables = normalized.tablesObject;
			console.log('[Plans] Normalized tables on update:', Object.keys(normalized.tablesObject));
		} else if (tables) {
			// Fallback without mapping (try to preserve structure)
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
			} else if (typeof tables === "object") {
				for (const [tableName, config] of Object.entries(tables)) {
					if (plan.includesTable(tableName)) {
						plan.updateTable(tableName, config);
					} else {
						plan.addTable(tableName, config);
					}
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
		const { planJsonColumn, hasIsValidated } = meta;

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

		// Load mapping profile
		const { mappingProfileId } = await resolvePlanMappingProfileId(pool, planRow, meta);
		if (!mappingProfileId) {
			await pool.end();
			return res.status(400).json({
				success: false,
				error: "Plan is missing a mapping profile. Open the plan and re-select a profile or rebuild mapping."
			});
		}
		const profile = await runStore.getMappingProfile(pool, mappingProfileId);

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
		const { planJsonColumn } = meta;

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

		// Load mapping profile
		const { mappingProfileId } = await resolvePlanMappingProfileId(pool, planRow, meta);
		if (!mappingProfileId) {
			await pool.end();
			return res.status(400).json({
				success: false,
				error: "Plan is missing a mapping profile. Open the plan and re-select a profile or rebuild mapping."
			});
		}
		const profile = await runStore.getMappingProfile(pool, mappingProfileId);

		if (!profile) {
			await pool.end();
			return res.status(404).json({
				success: false,
				error: "Associated mapping not found"
			});
		}

		const mappingData = safeParseJson(profile.mapping_json);
		const mapping = Mapping.fromJSON(mappingData);

		// SELF-HEAL: Normalize plan tables before dry-run
		if (plan.tables && mappingData) {
			const normalized = normalizePlanTables(plan.tables, mappingData);
			if (needsNormalization(plan.tables, mappingData)) {
				console.warn('[Dry Run] Auto-repairing plan tables to target-table keys', {
					planId: id,
					before: Object.keys(plan.tables),
					after: Object.keys(normalized.tablesObject)
				});

				// Update plan in-memory for this request
				plan.tables = normalized.tablesObject;

				// Write back to DB (self-heal for future requests)
				const repairedPlanJson = JSON.stringify(plan.toJSON());
				const poolForUpdate = await mysql.connectToSchema(state.mysql, state.schemaName);
				await poolForUpdate.query(
					`UPDATE migration_plans SET ${planJsonColumn} = ? WHERE plan_id = ?`,
					[repairedPlanJson, id]
				);
				await poolForUpdate.end();
			}
		}

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

			const dryRunResult = await PlanValidator.dryRun(sampleRow, mapping, sourceTable, targetTable, schema);
			const transformedRow = {};
			for (const [srcCol, field] of fieldMaps) {
				// Skip omitted fields - they won't be in the actual migration
				if (field.omit) {
					continue;
				}

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
				warnings: dryRunResult.warnings || []
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

		// Attach to Firebird once and reuse for all count queries
		let fbDb = null;
		try {
			fbDb = await firebird.attachWithRetry(state.firebird);

			for (const table of tables) {
				try {
					const result = await runTableDryRun(table);

					// Get actual row count from Firebird
					let estimatedRows = 0;
					try {
						const sourceTable = mapping.getSourceTable(table);
						if (sourceTable) {
							estimatedRows = await firebird.countRowsWithDb(fbDb, sourceTable);
						}
					} catch (countErr) {
						console.warn(`[Dry Run] Failed to count rows for ${table}:`, countErr.message);
						estimatedRows = 0;
					}

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
		} finally {
			// Detach Firebird connection
			if (fbDb) {
				try {
					fbDb.detach();
				} catch (err) {
					console.warn('[Dry Run] Error detaching Firebird:', err.message);
				}
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
		const { hasMappingProfileId, hasIsValidated } = meta;

		const selectFields = ['p.plan_id', 'p.created_at'];
		if (hasMappingProfileId) selectFields.push('p.mapping_profile_id');
		if (hasIsValidated) selectFields.push('p.is_validated');
		selectFields.push('mp.name as mapping_profile_name');
		const [rows] = await pool.query(
			`SELECT ${selectFields.join(', ')} FROM migration_plans p LEFT JOIN migration_mapping_profiles mp ON p.mapping_profile_id = mp.id ORDER BY p.created_at DESC`
		);

		await pool.end();

		res.json({
			success: true,
			count: rows.length,
			plans: rows.map(row => ({
				id: row.plan_id,
				mappingProfileId: hasMappingProfileId ? row.mapping_profile_id : null,
				mappingProfileName: row.mapping_profile_name || null,
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
