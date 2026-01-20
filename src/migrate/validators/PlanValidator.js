const SchemaValidator = require('./SchemaValidator');

/**
 * Plan validator - validates migration plan before execution
 */

class PlanValidator {
	/**
	 * Full pre-run validation
	 * @param {Plan} plan
	 * @param {Mapping} mapping
	 * @param {Schema} schema
	 * @returns {Promise<{ valid: bool, blockers: [], warnings: [] }>}
	 */
	static async validate(plan, mapping, schema) {
		const blockers = [];
		const warnings = [];

		// Validate each table in plan
		for (const tableName of plan.getIncludedTables()) {
			const tableConfig = plan.getTableConfig(tableName);

			// Find source table from mapping
			const sourceTable = mapping.getSourceTable(tableName);

			if (!sourceTable) {
				blockers.push(`No mapping found for target table: ${tableName}`);
				continue;
			}

			// Check table exists
			const tableCheck = SchemaValidator.validateTablePair(
				schema,
				sourceTable,
				tableName
			);

			if (!tableCheck.compatible) {
				blockers.push(...tableCheck.errors);
				continue;
			}

			// Check fields exist
			const fieldMaps = mapping.getFieldMaps(sourceTable);
			const fieldCheck = SchemaValidator.validateFieldMapping(schema, sourceTable, tableName, fieldMaps);

			if (!fieldCheck.compatible) {
				blockers.push(...fieldCheck.errors);
			}

			// Validate mode/strategy combo
			const modeCheck = this.validateModeConfig(tableConfig);
			if (!modeCheck.valid) {
				blockers.push(...modeCheck.errors);
			}

			// Validate dedupe keys if present
			if (tableConfig.dedupeKeys?.length) {
				const dedupeCheck = this.validateDedupeKeys(
					schema,
					tableName,
					tableConfig.dedupeKeys,
					fieldMaps
				);

				if (!dedupeCheck.valid) {
					blockers.push(...dedupeCheck.errors);
				} else {
					warnings.push(...dedupeCheck.warnings);
				}
			}

			// Check target capacity
			const capacityCheck = SchemaValidator.validateTargetCapacity(schema, tableName, fieldMaps);
			if (!capacityCheck.valid) {
				warnings.push(...capacityCheck.issues);
			}
		}

		return {
			valid: blockers.length === 0,
			blockers,
			warnings,
			canProceed: blockers.length === 0
		};
	}

	/**
	 * Validate mode + keyStrategy combination
	 * @param {Object} tableConfig
	 * @returns {{ valid: bool, errors: string[] }}
	 */
	static validateModeConfig(tableConfig) {
		const errors = [];

		if (tableConfig.mode === 'UPSERT' && tableConfig.keyStrategy === 'rekey') {
			if (!tableConfig.dedupeKeys || tableConfig.dedupeKeys.length === 0) {
				errors.push(
					`UPSERT with re-key IDs requires dedupe keys to identify existing rows`
				);
			}
		}

		// Validate mode is valid
		const validModes = ['INSERT', 'UPSERT', 'TRUNCATE+INSERT'];
		if (!validModes.includes(tableConfig.mode)) {
			errors.push(`Invalid mode: ${tableConfig.mode}. Must be one of: ${validModes.join(', ')}`);
		}

		// Validate keyStrategy is valid
		const validStrategies = ['preserve', 'rekey'];
		if (!validStrategies.includes(tableConfig.keyStrategy)) {
			errors.push(`Invalid keyStrategy: ${tableConfig.keyStrategy}. Must be one of: ${validStrategies.join(', ')}`);
		}

		// Validate onDuplicate is valid
		const validOnDuplicate = ['SKIP', 'ERROR', 'UPDATE'];
		if (!validOnDuplicate.includes(tableConfig.onDuplicate)) {
			errors.push(`Invalid onDuplicate: ${tableConfig.onDuplicate}. Must be one of: ${validOnDuplicate.join(', ')}`);
		}

		return {
			valid: errors.length === 0,
			errors
		};
	}

	/**
	 * Validate dedupe key configuration
	 * @param {Schema} schema
	 * @param {string} tableName
	 * @param {string[]} dedupeKeys
	 * @param {Map<string, FieldMap>} fieldMaps
	 * @returns {{ valid: bool, errors: string[], warnings: string[] }}
	 */
	static validateDedupeKeys(schema, tableName, dedupeKeys, fieldMaps) {
		const errors = [];
		const warnings = [];

		// Check each dedupe key exists in target table
		const tgtTable = schema.getTable('mysql', tableName);
		if (!tgtTable) {
			return {
				valid: false,
				errors: [`Table not found: ${tableName}`],
				warnings
			};
		}

		for (const dedupeKey of dedupeKeys) {
			if (!tgtTable.columns[dedupeKey.toUpperCase()]) {
				errors.push(`Dedupe key not found in ${tableName}: ${dedupeKey}`);
			}

			// Check if mapped from source
			const isMapped = Array.from(fieldMaps?.values() || []).some(
				f => f.targetColumn.toUpperCase() === dedupeKey.toUpperCase()
			);

			if (!isMapped) {
				warnings.push(`Dedupe key ${dedupeKey} is not mapped from source columns`);
			}
		}

		// Check if dedupe keys form a unique constraint
		const hasIndex = tgtTable.uniqueIndexes?.some(idx => {
			return dedupeKeys.every(key => idx.columns?.includes(key.toUpperCase()));
		});

		if (!hasIndex && dedupeKeys.length > 0) {
			warnings.push(
				`Dedupe keys [${dedupeKeys.join(', ')}] do not form a unique index on ${tableName}. ` +
				`Deduplication will be slower.`
			);
		}

		return {
			valid: errors.length === 0,
			errors,
			warnings
		};
	}

	/**
	 * Check if row 1 can be migrated (dry-run)
	 * @param {any} firstRow - First row from source
	 * @param {Mapping} mapping
	 * @param {string} sourceTable
	 * @returns {Promise<{ migratable: bool, issues: string[] }>}
	 */
	static async dryRun(firstRow, mapping, sourceTable) {
		const issues = [];

		const fieldMaps = mapping.getFieldMaps(sourceTable);
		if (!fieldMaps) {
			return { migratable: false, issues: ['No field mapping found'] };
		}

		for (const [srcCol, field] of fieldMaps) {
			const srcValue = firstRow[srcCol.toLowerCase()] ?? firstRow[srcCol.toUpperCase()];

			// Check if null/undefined and no default
			if ((srcValue === null || srcValue === undefined) && !field.defaultValue) {
				issues.push(`Source column ${srcCol} is null and no default provided`);
			}

			// Try transform
			if (field.transform && srcValue !== null && srcValue !== undefined) {
				try {
					const transformed = this.applyTransform(field.transform, srcValue);
					if (transformed === null && !field.defaultValue) {
						issues.push(`Transform ${field.transform} on ${srcCol} returned null, no default`);
					}
				} catch (err) {
					issues.push(`Transform ${field.transform} failed on ${srcCol}: ${err.message}`);
				}
			}
		}

		return {
			migratable: issues.length === 0,
			issues
		};
	}

	/**
	 * Apply a transform function (for dry-run testing)
	 * @param {string} name
	 * @param {*} value
	 * @returns {*}
	 */
	static applyTransform(name, value) {
		// Import from transforms.js
		try {
			const transforms = require('../mappers/transforms');
			return transforms[name]?.(value) ?? value;
		} catch (err) {
			// If transforms module doesn't exist yet, just return value
			return value;
		}
	}

	/**
	 * Check for common configuration issues
	 * @param {Plan} plan
	 * @returns {{ issues: string[] }}
	 */
	static checkConfigurationIssues(plan) {
		const issues = [];

		const tables = plan.getIncludedTables();

		// Check if any tables are included
		if (tables.length === 0) {
			issues.push('No tables included in migration plan');
		}

		// Check for conflicting configurations
		let hasRekey = false;
		let hasPreserve = false;

		for (const tableName of tables) {
			const config = plan.getTableConfig(tableName);

			if (config.keyStrategy === 'rekey') {
				hasRekey = true;
			} else if (config.keyStrategy === 'preserve') {
				hasPreserve = true;
			}

			// Check batch size
			if (config.batchSize && (config.batchSize < 1 || config.batchSize > 10000)) {
				issues.push(`Table ${tableName}: Batch size ${config.batchSize} is outside recommended range (1-10000)`);
			}
		}

		// Warn about mixed key strategies
		if (hasRekey && hasPreserve) {
			issues.push(
				'Mixed key strategies detected: Some tables use "rekey" and others "preserve". ' +
				'This may cause foreign key issues if tables reference each other.'
			);
		}

		return { issues };
	}
}

module.exports = PlanValidator;
