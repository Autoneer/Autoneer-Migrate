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
 * POST /api/plans
 * Create a new migration plan from a mapping
 * Body: { mappingId: string, name?: string }
 */
router.post("/api/plans", async (req, res) => {
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
		const columns = await getPlanTableColumns(pool);
		const planJsonColumn = getPlanJsonColumn(columns);
		const hasMappingId = columns.has('mapping_id');
		const hasMappingName = columns.has('mapping_name');
		const hasName = columns.has('name');
		const hasIsValidated = columns.has('is_validated');

		// Load the mapping
		const profile = await runStore.getMappingProfile(pool, resolvedMappingId);

		if (!profile) {
			await pool.end();
			return res.status(404).json({
				success: false,
				error: "Mapping profile not found"
			});
		}

		const mappingData = JSON.parse(profile.mapping_json);
		const mapping = Mapping.fromJSON(mappingData);

		// Create plan from mapping
		const plan = Plan.fromMapping(mapping, name);
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

		const planResult = await pool.query(
			`INSERT INTO migration_plans (${insertFields.join(', ')}) VALUES (${insertFields.map(() => '?').join(', ')})`,
			insertValues
		);

		const planId = planResult.insertId;

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
 * GET /api/plans/:id
 * Retrieve a specific migration plan
 */
router.get("/api/plans/:id", async (req, res) => {
	try {
		const { id } = req.params;

		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);

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
		const rawPlanJson = planRow[planJsonColumn] || '{}';
		const planData = JSON.parse(rawPlanJson);
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
 * PUT /api/plans/:id
 * Update an existing migration plan
 * Body: { name?: string, tables?: object }
 */
router.put("/api/plans/:id", async (req, res) => {
	try {
		const { id } = req.params;
		const { name, tables } = req.body;

		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);

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
		const planData = JSON.parse(rawPlanJson);
		const plan = Plan.fromJSON(planData);

		// Update name if provided
		if (name) {
			plan.name = name;
		}

		// Update table configurations if provided
		if (tables && typeof tables === "object") {
			for (const [tableName, config] of Object.entries(tables)) {
				if (plan.hasTable(tableName)) {
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
 * DELETE /api/plans/:id
 * Delete a migration plan
 */
router.delete("/api/plans/:id", async (req, res) => {
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
 * POST /api/plans/:id/validate
 * Validate a migration plan
 */
router.post("/api/plans/:id/validate", async (req, res) => {
	try {
		const { id } = req.params;

		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);

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
		const planData = JSON.parse(rawPlanJson);
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

		const mappingData = JSON.parse(profile.mapping_json);
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
 * POST /api/plans/:id/dry-run
 * Perform a dry-run simulation of the migration plan
 */
router.post("/api/plans/:id/dry-run", async (req, res) => {
	try {
		const { id } = req.params;
		const { tableName } = req.body;

		if (!tableName) {
			return res.status(400).json({
				success: false,
				error: "tableName is required for dry-run"
			});
		}

		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);

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
		const planData = JSON.parse(rawPlanJson);
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

		const mappingData = JSON.parse(profile.mapping_json);
		const mapping = Mapping.fromJSON(mappingData);

		// Discover schemas
		const schema = new Schema();
		await schema.discoverFirebird(state.firebird);
		await schema.discoverMySQL(pool, state.schemaName);

		await pool.end();

		// Perform dry-run for specific table
		const dryRunResult = await PlanValidator.dryRun(
			plan,
			mapping,
			schema,
			tableName,
			{
				firebird: state.firebird,
				mysql: state.mysql,
				schemaName: state.schemaName
			}
		);

		res.json({
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
	} catch (err) {
		res.status(500).json({
			success: false,
			error: err.message
		});
	}
});

/**
 * POST /api/plans/estimate
 * Estimate migration time and resource requirements
 * Body: { planId: string }
 */
router.post("/api/plans/estimate", async (req, res) => {
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
 * GET /api/plans
 * List all migration plans
 */
router.get("/api/plans", async (req, res) => {
	try {
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);

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
