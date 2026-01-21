/**
 * Session-specific migration plan
 * Uses a Mapping and adds run-specific configuration
 * (mode, keyStrategy, dedupeKeys, etc.)
 */

class Plan {
	/**
	 * @param {string} mappingId - Reference to Mapping
	 * @param {string} mappingName - For display
	 * @param {Object} tableConfigs - { TABLE: { mode, keyStrategy, dedupeKeys, cleanBefore } }
	 * @param {Date} [createdAt]
	 */
	constructor(mappingId, mappingName, tableConfigs = {}, createdAt = null) {
		this.mappingId = mappingId;
		this.mappingName = mappingName;
		this.tables = tableConfigs; // Per-table migration config
		this.createdAt = createdAt || new Date();
		this.isValidated = false;
		this.validationErrors = [];
		this.validationWarnings = [];
	}

	/**
	 * Add a table to the migration plan
	 * @param {string} tableName - MySQL target table name
	 * @param {Object} config - { mode, keyStrategy, dedupeKeys: [], cleanBefore }
	 */
	addTable(tableName, config) {
		this.tables[tableName.toUpperCase()] = {
			mode: config.mode || 'INSERT',          // INSERT, UPSERT, TRUNCATE+INSERT
			keyStrategy: config.keyStrategy || 'preserve',  // preserve, rekey
			dedupeKeys: config.dedupeKeys || [],
			onDuplicate: config.onDuplicate || 'SKIP',  // SKIP, ERROR, UPDATE
			cleanBefore: config.cleanBefore || false,
			batchSize: config.batchSize || 500
		};
	}

	/**
	 * Remove a table from the plan
	 * @param {string} tableName
	 */
	removeTable(tableName) {
		delete this.tables[tableName.toUpperCase()];
	}

	/**
	 * Update table configuration
	 * @param {string} tableName
	 * @param {Object} updates - Partial config to merge
	 */
	updateTable(tableName, updates) {
		const upperName = tableName.toUpperCase();
		if (this.tables[upperName]) {
			this.tables[upperName] = {
				...this.tables[upperName],
				...updates
			};
		}
	}

	/**
	 * Get all included table names
	 * @returns {string[]}
	 */
	getIncludedTables() {
		return Object.keys(this.tables);
	}

	/**
	 * Get config for a specific table
	 * @param {string} tableName
	 * @returns {Object|null}
	 */
	getTableConfig(tableName) {
		return this.tables[tableName.toUpperCase()] || null;
	}

	/**
	 * Check if a table is included in the plan
	 * @param {string} tableName
	 * @returns {boolean}
	 */
	includesTable(tableName) {
		return tableName.toUpperCase() in this.tables;
	}

	/**
	 * Mark plan as validated
	 * @param {Array} errors
	 * @param {Array} warnings
	 */
	recordValidation(errors = [], warnings = []) {
		this.isValidated = true;
		this.validationErrors = errors;
		this.validationWarnings = warnings;
	}

	/**
	 * Clear validation results (e.g., after plan changes)
	 */
	clearValidation() {
		this.isValidated = false;
		this.validationErrors = [];
		this.validationWarnings = [];
	}

	/**
	 * Check if plan is ready to execute
	 * @returns {boolean}
	 */
	isReady() {
		return this.isValidated && this.validationErrors.length === 0;
	}

	/**
	 * Get summary statistics
	 * @returns {Object}
	 */
	getSummary() {
		const tableCount = this.getIncludedTables().length;
		const modes = {};
		const strategies = {};

		for (const config of Object.values(this.tables)) {
			modes[config.mode] = (modes[config.mode] || 0) + 1;
			strategies[config.keyStrategy] = (strategies[config.keyStrategy] || 0) + 1;
		}

		return {
			tableCount,
			modes,
			strategies,
			isValidated: this.isValidated,
			hasErrors: this.validationErrors.length > 0,
			hasWarnings: this.validationWarnings.length > 0
		};
	}

	/**
	 * Serialize for storage
	 * @returns {Object}
	 */
	toJSON() {
		return {
			mappingId: this.mappingId,
			mappingName: this.mappingName,
			createdAt: this.createdAt.toISOString(),
			tables: this.tables,
			isValidated: this.isValidated,
			validationErrors: this.validationErrors,
			validationWarnings: this.validationWarnings
		};
	}

	/**
	 * Create from JSON
	 * @param {Object} obj
	 * @returns {Plan}
	 */
	static fromJSON(obj) {
		const plan = new Plan(
			obj.mappingId,
			obj.mappingName,
			obj.tables,
			new Date(obj.createdAt)
		);
		plan.isValidated = obj.isValidated || false;
		plan.validationErrors = obj.validationErrors || [];
		plan.validationWarnings = obj.validationWarnings || [];
		return plan;
	}

	/**
	 * Create a default plan from a mapping
	 * @param {Mapping} mapping
	 * @param {Object} defaultConfig - Default settings for all tables
	 * @returns {Plan}
	 */
	static fromMapping(mapping, defaultConfig = {}) {
		const plan = new Plan(mapping.id, mapping.name);

		// Only include mapping entries that have a defined target table or mapped columns
		const tables = mapping.tables || {};
		for (const [src, config] of Object.entries(tables)) {
			const target = config?.targetTable || config?.target || '';
			const hasColumns = config && Object.keys(config.columns || {}).length > 0;
			if (!target || String(target).trim() === '') {
				// Skip entries without a target table
				continue;
			}

			plan.addTable(target, {
				mode: defaultConfig.mode || 'INSERT',
				keyStrategy: defaultConfig.keyStrategy || 'preserve',
				dedupeKeys: defaultConfig.dedupeKeys || [],
				onDuplicate: defaultConfig.onDuplicate || 'SKIP',
				cleanBefore: defaultConfig.cleanBefore || false,
				batchSize: defaultConfig.batchSize || 500
			});
		}

		return plan;
	}
}

module.exports = Plan;
