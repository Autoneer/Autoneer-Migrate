const FieldMap = require('./FieldMap');
const { v4: uuidv4 } = require('uuid');

/**
 * Persistent mapping profile (reusable across runs)
 * Defines how source tables and columns map to target tables and columns
 * Does NOT include run-specific configuration like mode, strategy, etc.
 */

class Mapping {
	/**
	 * @param {string} id - UUID
	 * @param {string} name - Human-readable name
	 * @param {Object} tableConfigs - { SOURCE_TABLE: { targetTable, columns: { SOURCE_COL: FieldMap } } }
	 * @param {Date} [createdAt]
	 * @param {Date} [updatedAt]
	 */
	constructor(id, name, tableConfigs = {}, createdAt = null, updatedAt = null) {
		this.id = id || uuidv4();
		this.name = name;
		this.tables = tableConfigs; // { SOURCE: { targetTable, columns: {...} } }
		this.createdAt = createdAt || new Date();
		this.updatedAt = updatedAt || new Date();
	}

	/**
	 * Add a table to the mapping
	 * @param {string} sourceTable
	 * @param {string} targetTable
	 * @param {Map<string, FieldMap>} fieldMaps
	 */
	addTable(sourceTable, targetTable, fieldMaps = new Map()) {
		this.tables[sourceTable.toUpperCase()] = {
			targetTable: targetTable.toUpperCase(),
			columns: Object.fromEntries(
				Array.from(fieldMaps.entries()).map(([src, field]) => [src.toUpperCase(), field.toJSON()])
			)
		};
		this.updatedAt = new Date();
	}

	/**
	 * Remove a table from the mapping
	 * @param {string} sourceTable
	 */
	removeTable(sourceTable) {
		delete this.tables[sourceTable.toUpperCase()];
		this.updatedAt = new Date();
	}

	/**
	 * Get target table for source table
	 * @param {string} sourceTable
	 * @returns {string|null}
	 */
	getTargetTable(sourceTable) {
		return this.tables[sourceTable.toUpperCase()]?.targetTable || null;
	}

	/**
	 * Get source table for target table (reverse lookup)
	 * @param {string} targetTable
	 * @returns {string|null}
	 */
	getSourceTable(targetTable) {
		const upperTarget = targetTable.toUpperCase();
		for (const [source, config] of Object.entries(this.tables)) {
			if (config.targetTable === upperTarget) {
				return source;
			}
		}
		return null;
	}

	/**
	 * Get all FieldMaps for a source table
	 * Omitted fields are automatically excluded
	 * @param {string} sourceTable
	 * @returns {Map<string, FieldMap>|null}
	 */
	getFieldMaps(sourceTable) {
		const config = this.tables[sourceTable.toUpperCase()];
		if (!config) return null;

		const map = new Map();
		for (const [src, fieldJSON] of Object.entries(config.columns || {})) {
			const fieldMap = FieldMap.fromJSON(fieldJSON);
			// Filter out omitted fields
			if (!fieldMap.omit) {
				map.set(src, fieldMap);
			}
		}
		return map;
	}

	/**
	 * Get all source table names
	 * @returns {string[]}
	 */
	getSourceTables() {
		return Object.keys(this.tables);
	}

	/**
	 * Get all target table names
	 * @returns {string[]}
	 */
	getTargetTables() {
		return Object.values(this.tables).map(config => config.targetTable);
	}

	/**
	 * Validate entire mapping against schema
	 * @param {Schema} schema
	 * @returns {{ valid: bool, issues: { table, warnings: [], errors: [] }[] }}
	 */
	validate(schema) {
		const issues = [];

		for (const [sourceTable, config] of Object.entries(this.tables)) {
			const tableIssue = { table: sourceTable, warnings: [], errors: [] };

			// Check source table exists
			if (!schema.tableExists('firebird', sourceTable)) {
				tableIssue.errors.push(`Source table not found in Firebird: ${sourceTable}`);
				issues.push(tableIssue);
				continue;
			}

			// Check target table exists
			if (!schema.tableExists('mysql', config.targetTable)) {
				tableIssue.errors.push(`Target table not found in MySQL: ${config.targetTable}`);
				issues.push(tableIssue);
				continue;
			}

			// Validate each field
			for (const [srcCol, fieldJSON] of Object.entries(config.columns)) {
				const field = FieldMap.fromJSON(fieldJSON);
				const srcMeta = schema.getColumn('firebird', sourceTable, srcCol);
				const tgtMeta = schema.getColumn('mysql', config.targetTable, field.targetColumn);

				const fieldValidation = field.validate(srcMeta, tgtMeta);
				tableIssue.warnings.push(...fieldValidation.warnings);
				tableIssue.errors.push(...fieldValidation.errors);
			}

			if (tableIssue.warnings.length || tableIssue.errors.length) {
				issues.push(tableIssue);
			}
		}

		return {
			valid: issues.every(issue => issue.errors.length === 0),
			issues
		};
	}

	/**
	 * Serialize to JSON for storage
	 * @returns {Object}
	 */
	toJSON() {
		return {
			id: this.id,
			name: this.name,
			createdAt: this.createdAt.toISOString(),
			updatedAt: this.updatedAt.toISOString(),
			tables: this.tables
		};
	}

	/**
	 * Create from JSON
	 * @param {Object} obj
	 * @returns {Mapping}
	 */
	static fromJSON(obj) {
		const normalizedTables = {};
		const tables = obj?.tables || {};
		for (const [sourceTable, config] of Object.entries(tables)) {
			const targetTable = config?.targetTable || config?.target || '';
			const columns = {};
			for (const [srcCol, colConfig] of Object.entries(config?.columns || {})) {
				columns[srcCol] = {
					sourceColumn: colConfig.sourceColumn || srcCol,
					targetColumn: colConfig.targetColumn || colConfig.target || srcCol,
					transform: colConfig.transform,
					defaultValue: colConfig.defaultValue ?? colConfig.default,
					lookup: colConfig.lookup,
					omit: !!colConfig.omit
				};
			}
			normalizedTables[sourceTable] = {
				targetTable,
				columns
			};
		}

		return new Mapping(
			obj.id,
			obj.name,
			normalizedTables,
			obj.createdAt ? new Date(obj.createdAt) : null,
			obj.updatedAt ? new Date(obj.updatedAt) : null
		);
	}

	/**
	 * Convert old mapping format to new format
	 * @param {Object} oldMapping - Old mapping.default.json format
	 * @returns {Mapping}
	 */
	static fromLegacyFormat(oldMapping) {
		const mapping = new Mapping(
			uuidv4(),
			oldMapping.name || 'Converted Legacy Mapping',
			{}
		);

		// Old format: { tables: { SOURCE: { target, columns: { SRC_COL: { target, transform, ... } } } } }
		for (const [sourceTable, tableConfig] of Object.entries(oldMapping.tables || {})) {
			const fieldMaps = new Map();

			for (const [srcCol, colConfig] of Object.entries(tableConfig.columns || {})) {
				const fieldMap = new FieldMap(
					srcCol,
					colConfig.target || colConfig.targetColumn || srcCol,
					{
						transform: colConfig.transform,
						defaultValue: colConfig.default || colConfig.defaultValue,
						lookup: colConfig.lookup
					}
				);
				fieldMaps.set(srcCol, fieldMap);
			}

			mapping.addTable(sourceTable, tableConfig.target || tableConfig.targetTable, fieldMaps);
		}

		return mapping;
	}
}

module.exports = Mapping;
