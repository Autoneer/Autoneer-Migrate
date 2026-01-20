const SchemaValidator = require('./SchemaValidator');

/**
 * Mapping validator - validates mapping configuration
 */

class MappingValidator {
	/**
	 * Full validation of a mapping against schema
	 * @param {Mapping} mapping
	 * @param {Schema} schema
	 * @returns {{ valid: bool, errors: { table: string, issues: string[] }[], warnings: [] }}
	 */
	static validateMapping(mapping, schema) {
		const errors = [];
		const warnings = [];

		for (const [sourceTable, config] of Object.entries(mapping.tables)) {
			const tableErrors = [];

			// Check table pair
			const tablePair = SchemaValidator.validateTablePair(schema, sourceTable, config.targetTable);
			tableErrors.push(...tablePair.errors);

			if (!tablePair.compatible) {
				errors.push({ table: sourceTable, issues: tableErrors });
				continue;
			}

			// Check fields
			const fieldMaps = mapping.getFieldMaps(sourceTable);
			if (!fieldMaps || fieldMaps.size === 0) {
				tableErrors.push(`No column mappings defined for ${sourceTable}`);
				errors.push({ table: sourceTable, issues: tableErrors });
				continue;
			}

			const fieldCheck = SchemaValidator.validateFieldMapping(
				schema,
				sourceTable,
				config.targetTable,
				fieldMaps
			);
			tableErrors.push(...fieldCheck.errors);

			// Check target capacity
			const capacityCheck = SchemaValidator.validateTargetCapacity(
				schema,
				config.targetTable,
				fieldMaps
			);
			tableErrors.push(...capacityCheck.issues);

			if (tableErrors.length > 0) {
				errors.push({ table: sourceTable, issues: tableErrors });
			}
		}

		return {
			valid: errors.length === 0,
			errors,
			warnings
		};
	}

	/**
	 * Check if a mapping is complete (all source columns mapped)
	 * @param {Mapping} mapping
	 * @param {Schema} schema
	 * @returns {{ complete: bool, unmapped: { table: string, columns: string[] }[] }}
	 */
	static checkCompleteness(mapping, schema) {
		const unmapped = [];

		for (const [sourceTable, config] of Object.entries(mapping.tables)) {
			const srcTableMeta = schema.getTable('firebird', sourceTable);
			if (!srcTableMeta) continue;

			const mappedCols = new Set(mapping.getFieldMaps(sourceTable)?.keys() || []);
			const unmappedCols = Object.keys(srcTableMeta.columns || {})
				.filter(col => !mappedCols.has(col));

			if (unmappedCols.length > 0) {
				unmapped.push({
					table: sourceTable,
					columns: unmappedCols
				});
			}
		}

		return {
			complete: unmapped.length === 0,
			unmapped
		};
	}

	/**
	 * Check for potential issues in the mapping
	 * @param {Mapping} mapping
	 * @param {Schema} schema
	 * @returns {{ warnings: string[], suggestions: string[] }}
	 */
	static analyzeMappingQuality(mapping, schema) {
		const warnings = [];
		const suggestions = [];

		for (const [sourceTable, config] of Object.entries(mapping.tables)) {
			const fieldMaps = mapping.getFieldMaps(sourceTable);
			if (!fieldMaps) continue;

			// Check for potential type mismatches
			for (const [srcCol, field] of fieldMaps) {
				const srcMeta = schema.getColumn('firebird', sourceTable, srcCol);
				const tgtMeta = schema.getColumn('mysql', config.targetTable, field.targetColumn);

				if (srcMeta && tgtMeta) {
					const validation = field.validate(srcMeta, tgtMeta);
					warnings.push(...validation.warnings);
				}
			}

			// Check completeness
			const completeness = SchemaValidator.checkCompleteness(schema, sourceTable, fieldMaps);
			if (!completeness.complete && completeness.unmappedColumns.length > 0) {
				suggestions.push(
					`Table ${sourceTable}: Consider mapping these columns: ${completeness.unmappedColumns.join(', ')}`
				);
			}

			// Check primary key mapping
			const pkCheck = SchemaValidator.validatePrimaryKey(schema, sourceTable, config.targetTable);
			if (!pkCheck.compatible) {
				warnings.push(`${sourceTable}: ${pkCheck.message}`);
			}
		}

		return {
			warnings,
			suggestions
		};
	}

	/**
	 * Validate that a mapping can be used with a specific database pair
	 * @param {Mapping} mapping
	 * @param {Schema} schema
	 * @returns {{ compatible: bool, blockers: string[], warnings: string[] }}
	 */
	static validateCompatibility(mapping, schema) {
		const blockers = [];
		const warnings = [];

		// Check that schemas are loaded
		if (!schema.firebird.lastUpdated) {
			blockers.push('Firebird schema not loaded');
		}

		if (!schema.mysql.lastUpdated) {
			blockers.push('MySQL schema not loaded');
		}

		if (blockers.length > 0) {
			return { compatible: false, blockers, warnings };
		}

		// Validate the mapping
		const validation = this.validateMapping(mapping, schema);

		if (!validation.valid) {
			for (const error of validation.errors) {
				blockers.push(...error.issues);
			}
		}

		warnings.push(...validation.warnings);

		return {
			compatible: blockers.length === 0,
			blockers,
			warnings
		};
	}
}

module.exports = MappingValidator;
