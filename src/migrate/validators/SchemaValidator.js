/**
 * Schema validator - validates schema compatibility between databases
 */

class SchemaValidator {
	/**
	 * Validate that a table exists in both databases
	 * @param {Schema} schema
	 * @param {string} sourceTable - Firebird table
	 * @param {string} targetTable - MySQL table
	 * @returns {{ compatible: bool, errors: string[], warnings: string[] }}
	 */
	static validateTablePair(schema, sourceTable, targetTable) {
		const errors = [];
		const warnings = [];

		if (!schema.tableExists('firebird', sourceTable)) {
			errors.push(`Source table not found in Firebird: ${sourceTable}`);
		}

		if (!schema.tableExists('mysql', targetTable)) {
			errors.push(`Target table not found in MySQL: ${targetTable}`);
		}

		return {
			compatible: errors.length === 0,
			errors,
			warnings
		};
	}

	/**
	 * Validate that all mapped columns exist
	 * @param {Schema} schema
	 * @param {string} sourceTable
	 * @param {string} targetTable
	 * @param {Map<string, FieldMap>} fieldMaps
	 * @returns {{ compatible: bool, missing: { source: [], target: [] }, errors: [] }}
	 */
	static validateFieldMapping(schema, sourceTable, targetTable, fieldMaps) {
		const missingSource = [];
		const missingTarget = [];
		const errors = [];

		for (const [srcCol, field] of fieldMaps) {
			if (!schema.getColumn('firebird', sourceTable, srcCol)) {
				missingSource.push(srcCol);
			}

			// Skip omitted fields and null/empty targets when checking target existence
			if (field && field.omit !== true) {
				if (!schema.getColumn('mysql', targetTable, field.targetColumn)) {
					missingTarget.push(field.targetColumn);
				}
			}
		}

		errors.push(
			...missingSource.map(c => `Column not found in Firebird.${sourceTable}: ${c}`),
			...missingTarget.map(c => `Column not found in MySQL.${targetTable}: ${c}`)
		);

		return {
			compatible: missingSource.length === 0 && missingTarget.length === 0,
			missing: { source: missingSource, target: missingTarget },
			errors
		};
	}

	/**
	 * Validate primary key compatibility
	 * @param {Schema} schema
	 * @param {string} sourceTable
	 * @param {string} targetTable
	 * @returns {{ compatible: bool, message: string }}
	 */
	static validatePrimaryKey(schema, sourceTable, targetTable) {
		const srcTable = schema.getTable('firebird', sourceTable);
		const tgtTable = schema.getTable('mysql', targetTable);

		// Both should have primary keys, or neither
		const srcHasPK = srcTable?.primaryKey?.length > 0;
		const tgtHasPK = tgtTable?.primaryKey?.length > 0;

		if (srcHasPK !== tgtHasPK) {
			return {
				compatible: false,
				message: `Primary key mismatch: Firebird ${srcHasPK ? 'has' : 'missing'} PK, MySQL ${tgtHasPK ? 'has' : 'missing'} PK`
			};
		}

		return { compatible: true, message: 'Primary keys compatible' };
	}

	/**
	 * Check for unmapped columns in source table
	 * @param {Schema} schema
	 * @param {string} sourceTable
	 * @param {Map<string, FieldMap>} fieldMaps
	 * @returns {{ complete: bool, unmappedColumns: string[] }}
	 */
	static checkCompleteness(schema, sourceTable, fieldMaps) {
		const srcTable = schema.getTable('firebird', sourceTable);
		if (!srcTable) {
			return {
				complete: false,
				unmappedColumns: []
			};
		}

		const mappedCols = new Set(
			Array.from(fieldMaps.entries()).map(([k, fm]) => (fm && fm.omit !== true ? k.toUpperCase() : null)).filter(Boolean)
		);
		const unmappedColumns = Object.keys(srcTable.columns || {})
			.filter(col => !mappedCols.has(col.toUpperCase()));

		return {
			complete: unmappedColumns.length === 0,
			unmappedColumns
		};
	}

	/**
	 * Validate that target table can accept all mapped data
	 * @param {Schema} schema
	 * @param {string} targetTable
	 * @param {Map<string, FieldMap>} fieldMaps
	 * @returns {{ valid: bool, issues: string[] }}
	 */
	static validateTargetCapacity(schema, targetTable, fieldMaps) {
		const issues = [];
		const tgtTable = schema.getTable('mysql', targetTable);

		if (!tgtTable) {
			return {
				valid: false,
				issues: [`Target table not found: ${targetTable}`]
			};
		}

		// Check for required columns that aren't being mapped
		const mappedTargetCols = new Set(
			Array.from(fieldMaps.values())
				.map(fm => (fm && fm.omit !== true && fm.targetColumn ? fm.targetColumn.toUpperCase() : null))
				.filter(Boolean)
		);

		for (const [colName, colMeta] of Object.entries(tgtTable.columns)) {
			// If column is NOT NULL and not mapped and has no default
			if (!colMeta.nullable && !mappedTargetCols.has(colName) && !colMeta.defaultValue) {
				issues.push(
					`Target column ${targetTable}.${colName} is NOT NULL but not mapped and has no default value`
				);
			}
		}

		return {
			valid: issues.length === 0,
			issues
		};
	}
}

module.exports = SchemaValidator;
