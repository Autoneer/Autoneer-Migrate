/**
 * API Routes for Mapping Management
 * RESTful endpoints for creating, retrieving, updating, and deleting mapping profiles
 */

const express = require("express");
const { v4: uuidv4 } = require("uuid");
const mysql = require("../../db/mysql");
const { state } = require("../../config/state");
const { Mapping, Schema } = require("../../migrate/models");
const { MappingValidator } = require("../../migrate/validators");
const runStore = require("../../migrate/runStore");

const router = express.Router();

/**
 * GET /api/mappings
 * List all saved mapping profiles
 */
router.get("/api/mappings", async (req, res) => {
	try {
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);

		const profiles = await runStore.listMappingProfiles(pool);

		await pool.end();

		res.json({
			success: true,
			count: profiles.length,
			mappings: profiles.map(p => ({
				id: p.id,
				name: p.name,
				createdAt: p.created_at,
				updatedAt: p.updated_at
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
 * GET /api/mappings/:id
 * Retrieve a specific mapping profile by ID
 */
router.get("/api/mappings/:id", async (req, res) => {
	try {
		const { id } = req.params;
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);

		const profile = await runStore.getMappingProfile(pool, id);

		await pool.end();

		if (!profile) {
			return res.status(404).json({
				success: false,
				error: "Mapping profile not found"
			});
		}

		// Parse the JSON and convert to Mapping model
		const mappingData = JSON.parse(profile.mapping_json);
		const mapping = Mapping.fromJSON(mappingData);

		res.json({
			success: true,
			mapping: {
				id: mapping.id,
				name: mapping.name,
				createdAt: mapping.createdAt,
				updatedAt: mapping.updatedAt,
				tables: mapping.toJSON().tables
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
 * POST /api/mappings
 * Create a new mapping profile
 * Body: { name: string, tables?: object }
 */
router.post("/api/mappings", async (req, res) => {
	try {
		const { name, tables } = req.body;

		if (!name) {
			return res.status(400).json({
				success: false,
				error: "Mapping name is required"
			});
		}

		// Create new mapping
		const mappingId = uuidv4();
		const mapping = new Mapping(mappingId, name);

		// If tables are provided, add them
		if (tables && typeof tables === "object") {
			for (const [sourceTable, tableConfig] of Object.entries(tables)) {
				if (tableConfig.target && tableConfig.columns) {
					const fieldMaps = new Map();
					for (const [sourceCol, colConfig] of Object.entries(tableConfig.columns)) {
						const { FieldMap } = require("../../migrate/models");
						fieldMaps.set(
							sourceCol,
							new FieldMap(sourceCol, colConfig.target, colConfig)
						);
					}
					mapping.addTable(sourceTable, tableConfig.target, fieldMaps);
				}
			}
		}

		// Save to database
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);

		const insertId = await runStore.saveMappingProfile(pool, {
			name: mapping.name,
			mappingJson: JSON.stringify(mapping.toJSON())
		});

		// Align mapping ID with stored profile ID
		mapping.id = insertId;
		await runStore.updateMappingProfile(pool, insertId, {
			name: mapping.name,
			mappingJson: JSON.stringify(mapping.toJSON())
		});

		await pool.end();

		res.status(201).json({
			success: true,
			message: "Mapping profile created",
			mapping: {
				id: mapping.id,
				name: mapping.name,
				createdAt: mapping.createdAt
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
 * PUT /api/mappings/:id
 * Update an existing mapping profile
 * Body: { name?: string, tables?: object }
 */
router.put("/api/mappings/:id", async (req, res) => {
	try {
		const { id } = req.params;
		const { name, tables } = req.body;

		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);

		// Load existing mapping
		const profile = await runStore.getMappingProfile(pool, id);

		if (!profile) {
			await pool.end();
			return res.status(404).json({
				success: false,
				error: "Mapping profile not found"
			});
		}

		// Parse and update
		const mappingData = JSON.parse(profile.mapping_json);
		const mapping = Mapping.fromJSON(mappingData);

		if (name) {
			mapping.name = name;
		}

		if (tables && typeof tables === "object") {
			// Clear existing tables and rebuild
			mapping._tables = new Map();

			for (const [sourceTable, tableConfig] of Object.entries(tables)) {
				if (tableConfig.target && tableConfig.columns) {
					const fieldMaps = new Map();
					for (const [sourceCol, colConfig] of Object.entries(tableConfig.columns)) {
						const { FieldMap } = require("../../migrate/models");
						fieldMaps.set(
							sourceCol,
							new FieldMap(sourceCol, colConfig.target, colConfig)
						);
					}
					mapping.addTable(sourceTable, tableConfig.target, fieldMaps);
				}
			}
		}

		mapping.updatedAt = new Date();

		// Save updated mapping
		await runStore.updateMappingProfile(pool, id, {
			name: mapping.name,
			mappingJson: JSON.stringify(mapping.toJSON())
		});

		await pool.end();

		res.json({
			success: true,
			message: "Mapping profile updated",
			mapping: {
				id: mapping.id,
				name: mapping.name,
				updatedAt: mapping.updatedAt
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
 * DELETE /api/mappings/:id
 * Delete a mapping profile
 */
router.delete("/api/mappings/:id", async (req, res) => {
	try {
		const { id } = req.params;

		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);

		// Check if mapping exists
		const profile = await runStore.getMappingProfile(pool, id);

		if (!profile) {
			await pool.end();
			return res.status(404).json({
				success: false,
				error: "Mapping profile not found"
			});
		}

		// Delete the mapping
		await runStore.deleteMappingProfile(pool, id);

		await pool.end();

		res.json({
			success: true,
			message: "Mapping profile deleted"
		});
	} catch (err) {
		res.status(500).json({
			success: false,
			error: err.message
		});
	}
});

/**
 * POST /api/mappings/:id/validate
 * Validate a mapping against current database schemas
 */
router.post("/api/mappings/:id/validate", async (req, res) => {
	try {
		const { id } = req.params;

		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);

		// Load mapping
		const profile = await runStore.getMappingProfile(pool, id);

		if (!profile) {
			await pool.end();
			return res.status(404).json({
				success: false,
				error: "Mapping profile not found"
			});
		}

		const mappingData = JSON.parse(profile.mapping_json);
		const mapping = Mapping.fromJSON(mappingData);

		// Discover schemas
		const schema = new Schema();
		await schema.discoverFirebird(state.firebird);
		await schema.discoverMySQL(pool, state.schemaName);

		await pool.end();

		// Validate mapping
		const validation = MappingValidator.validateMapping(mapping, schema);

		// Get quality analysis
		const quality = MappingValidator.analyzeMappingQuality(mapping, schema);

		res.json({
			success: true,
			validation: {
				valid: validation.valid,
				errors: validation.errors,
				warnings: validation.warnings
			},
			quality: {
				completeness: quality.completeness,
				warnings: quality.warnings,
				suggestions: quality.suggestions
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
 * POST /api/mappings/auto-generate
 * Auto-generate a mapping profile based on discovered schemas
 * Body: { firebird: Schema, mysql: Schema, name?: string }
 */
router.post("/api/mappings/auto-generate", async (req, res) => {
	try {
		const { firebird, mysql, name = "Auto-generated Mapping" } = req.body;

		if (!firebird || !mysql) {
			return res.status(400).json({
				success: false,
				error: "firebird and mysql schemas are required"
			});
		}

		// Create new mapping
		const mapping = new Mapping(null, name);

		// Auto-match tables by name
		const firebirdTables = firebird.tables || [];
		const mysqlTables = mysql.tables || [];

		firebirdTables.forEach(fbTable => {
			// Try to find matching MySQL table (case-insensitive)
			const matchingMysql = mysqlTables.find(
				mt => mt.name.toLowerCase() === fbTable.name.toLowerCase()
			);

			if (matchingMysql) {
				const tableMapping = mapping.addTable(fbTable.name, matchingMysql.name);

				// Auto-match fields by name
				(fbTable.columns || []).forEach(fbCol => {
					const matchingCol = (matchingMysql.columns || []).find(
						mc => mc.name.toLowerCase() === fbCol.name.toLowerCase()
					);

					if (matchingCol) {
						tableMapping.addFieldMapping(fbCol.name, matchingCol.name);
					}
				});
			}
		});

		res.json({
			success: true,
			message: "Mapping auto-generated",
			mapping: {
				id: mapping.id,
				name: mapping.name,
				tablesMatched: Object.keys(mapping.tables).length,
				tables: mapping.toJSON().tables
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
 * POST /api/mappings/validate
 * Validate a mapping configuration
 * Body: { mapping: object }
 */
router.post("/api/mappings/validate", async (req, res) => {
	try {
		const { mapping: mappingData } = req.body;

		if (!mappingData) {
			return res.status(400).json({
				success: false,
				error: "mapping data is required"
			});
		}

		// Create Mapping instance
		const mapping = Mapping.fromJSON(mappingData);

		// Validate using MappingValidator
		const validator = new MappingValidator(mapping);
		const isValid = validator.validate();
		const errors = validator.getErrors();
		const warnings = validator.getWarnings();

		res.json({
			success: true,
			valid: isValid,
			errors: errors,
			warnings: warnings,
			summary: {
				totalTables: Object.keys(mapping.tables).length,
				errorsCount: errors.length,
				warningsCount: warnings.length
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
 * POST /api/mappings/convert-legacy
 * Convert a legacy mapping.default.json format to new Mapping model
 * Body: { legacyMapping: object, name?: string }
 */
router.post("/api/mappings/convert-legacy", async (req, res) => {
	try {
		const { legacyMapping, name } = req.body;

		if (!legacyMapping) {
			return res.status(400).json({
				success: false,
				error: "legacyMapping is required"
			});
		}

		// Convert legacy format
		const mapping = Mapping.fromLegacyFormat(legacyMapping, name);

		// Optionally save to database
		if (req.body.save) {
			const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
			await mysql.ensureMigrationTables(pool);

			await runStore.saveMappingProfile(pool, {
				id: mapping.id,
				name: mapping.name,
				mapping_json: JSON.stringify(mapping.toJSON())
			});

			await pool.end();
		}

		res.json({
			success: true,
			message: req.body.save ? "Legacy mapping converted and saved" : "Legacy mapping converted",
			mapping: {
				id: mapping.id,
				name: mapping.name,
				tables: mapping.toJSON().tables
			}
		});
	} catch (err) {
		res.status(500).json({
			success: false,
			error: err.message
		});
	}
});

module.exports = router;
