/**
 * Individual column transformation definition
 * Represents how a single source column maps to a target column
 */

class FieldMap {
	/**
	 * @param {string} sourceColumn - Source column name
	 * @param {string} targetColumn - Target column name
	 * @param {Object} options - Additional configuration
	 * @param {string} [options.transform] - Transform function name ('trim', 'toNumber', etc)
	 * @param {*} [options.defaultValue] - Value if source is null
	 * @param {Object} [options.lookup] - { table: 'ID_MAP', sourceId: 'src_id', targetId: 'tgt_id' }
	 * @param {boolean} [options.omit] - If true, this column will not be migrated
	 */
	constructor(sourceColumn, targetColumn, { transform = null, defaultValue = null, lookup = null, omit = false } = {}) {
		this.sourceColumn = sourceColumn.toUpperCase();
		this.targetColumn = targetColumn.toUpperCase();
		this.transform = transform;
		this.defaultValue = defaultValue;
		this.lookup = lookup;
		this.omit = omit || false;
	}

	/**
	 * Validate this field map against schema
	 * @param {Object} sourceColumnMetadata - From Schema.getColumn('firebird', ...)
	 * @param {Object} targetColumnMetadata - From Schema.getColumn('mysql', ...)
	 * @returns {Object} - { valid: bool, warnings: string[], errors: string[] }
	 */
	validate(sourceColumnMetadata, targetColumnMetadata) {
		const warnings = [];
		const errors = [];

		// Check if columns exist
		if (!sourceColumnMetadata) {
			errors.push(`Source column ${this.sourceColumn} not found in schema`);
		}

		if (!targetColumnMetadata) {
			errors.push(`Target column ${this.targetColumn} not found in schema`);
		}

		// If either doesn't exist, can't do further validation
		if (!sourceColumnMetadata || !targetColumnMetadata) {
			return { valid: false, warnings, errors };
		}

		// Check type compatibility
		const typeCheck = this.checkTypeCompatibility(
			sourceColumnMetadata.type,
			targetColumnMetadata.type
		);

		if (!typeCheck.safe && typeCheck.risk === 'high') {
			errors.push(`Type mismatch: ${sourceColumnMetadata.type} → ${targetColumnMetadata.type} (${typeCheck.message})`);
		} else if (!typeCheck.safe) {
			warnings.push(`Potential data loss: ${sourceColumnMetadata.type} → ${targetColumnMetadata.type} (${typeCheck.message})`);
		}

		// Check nullability
		if (targetColumnMetadata.nullable === false && !this.defaultValue && !this.transform) {
			if (sourceColumnMetadata.nullable) {
				warnings.push(
					`Target column ${this.targetColumn} is NOT NULL but source ${this.sourceColumn} is nullable. ` +
					`Consider adding a default value or transform.`
				);
			}
		}

		// Check transform validity
		if (this.transform && !this.isValidTransform(this.transform)) {
			errors.push(`Unknown transform function: ${this.transform}`);
		}

		// Check length compatibility for string types
		if (this._isStringType(sourceColumnMetadata.type) && this._isStringType(targetColumnMetadata.type)) {
			if (sourceColumnMetadata.length && targetColumnMetadata.length) {
				if (sourceColumnMetadata.length > targetColumnMetadata.length) {
					warnings.push(
						`Source column ${this.sourceColumn} (length ${sourceColumnMetadata.length}) ` +
						`is larger than target ${this.targetColumn} (length ${targetColumnMetadata.length}). ` +
						`Data may be truncated.`
					);
				}
			}
		}

		return {
			valid: errors.length === 0,
			warnings,
			errors
		};
	}

	/**
	 * Check if transform can safely convert sourceType to targetType
	 * @param {string} sourceType
	 * @param {string} targetType
	 * @returns {{ safe: bool, risk: 'none'|'low'|'medium'|'high', message: string }}
	 */
	checkTypeCompatibility(sourceType, targetType) {
		// Normalize types
		const src = sourceType.toUpperCase();
		const tgt = targetType.toUpperCase();

		// Exact match is always safe
		if (src === tgt) {
			return { safe: true, risk: 'none', message: 'Types match exactly' };
		}

		// Safe conversions
		const safeConversions = {
			'SMALLINT': ['INTEGER', 'BIGINT', 'DECIMAL', 'NUMERIC', 'INT'],
			'INTEGER': ['BIGINT', 'DECIMAL', 'NUMERIC', 'INT'],
			'INT': ['BIGINT', 'DECIMAL', 'NUMERIC', 'INTEGER'],
			'CHAR': ['VARCHAR', 'TEXT', 'LONGTEXT'],
			'VARCHAR': ['TEXT', 'LONGTEXT'],
			'DATE': ['DATETIME', 'TIMESTAMP'],
			'TIME': ['VARCHAR', 'CHAR'],
			'FLOAT': ['DOUBLE', 'DECIMAL'],
			'DOUBLE': ['DECIMAL']
		};

		if (safeConversions[src]?.includes(tgt)) {
			return { safe: true, risk: 'none', message: 'Safe conversion' };
		}

		// Low-risk conversions (might lose precision but usually okay)
		const lowRiskConversions = {
			'BIGINT': ['INTEGER', 'INT', 'DECIMAL'],
			'DOUBLE': ['FLOAT'],
			'DECIMAL': ['FLOAT', 'DOUBLE'],
			'NUMERIC': ['DECIMAL', 'FLOAT', 'DOUBLE'],
			'DATETIME': ['DATE', 'TIMESTAMP'],
			'TIMESTAMP': ['DATETIME', 'DATE']
		};

		if (lowRiskConversions[src]?.includes(tgt)) {
			return { safe: false, risk: 'low', message: 'May lose precision' };
		}

		// Medium-risk conversions (requires transform)
		const mediumRiskConversions = {
			'INTEGER': ['VARCHAR', 'CHAR', 'TEXT'],
			'INT': ['VARCHAR', 'CHAR', 'TEXT'],
			'BIGINT': ['VARCHAR', 'CHAR', 'TEXT'],
			'FLOAT': ['VARCHAR', 'CHAR', 'TEXT'],
			'DOUBLE': ['VARCHAR', 'CHAR', 'TEXT'],
			'DECIMAL': ['VARCHAR', 'CHAR', 'TEXT'],
			'DATE': ['VARCHAR', 'CHAR'],
			'DATETIME': ['VARCHAR', 'CHAR'],
			'TIMESTAMP': ['VARCHAR', 'CHAR']
		};

		if (mediumRiskConversions[src]?.includes(tgt)) {
			return { safe: false, risk: 'medium', message: 'Requires string conversion' };
		}

		// String to number conversions are risky
		if (this._isStringType(src) && this._isNumericType(tgt)) {
			return { safe: false, risk: 'high', message: 'Converting string to number requires validation' };
		}

		// String to date conversions are risky
		if (this._isStringType(src) && this._isDateType(tgt)) {
			return { safe: false, risk: 'high', message: 'Converting string to date requires parsing' };
		}

		// Default: incompatible
		return { safe: false, risk: 'high', message: 'Types are incompatible' };
	}

	/**
	 * Check if a transform function exists and is valid
	 * @param {string} name
	 * @returns {boolean}
	 */
	isValidTransform(name) {
		const validTransforms = [
			'trim',
			'toNumber',
			'toDate',
			'toDateTime',
			'toBoolean',
			'toDecimal',
			'zeroDateToNull',
			'toLowerCase',
			'toUpperCase',
			'nullIfEmpty',
			'emptyStringToNull'
		];

		return validTransforms.includes(name);
	}

	/**
	 * Convert to JSON for storage
	 * @returns {Object}
	 */
	toJSON() {
		return {
			sourceColumn: this.sourceColumn,
			targetColumn: this.targetColumn,
			transform: this.transform,
			defaultValue: this.defaultValue,
			lookup: this.lookup,
			omit: this.omit
		};
	}

	/**
	 * Create from JSON
	 * @param {Object} obj
	 * @returns {FieldMap}
	 */
	static fromJSON(obj) {
		return new FieldMap(obj.sourceColumn, obj.targetColumn, {
			transform: obj.transform,
			defaultValue: obj.defaultValue,
			lookup: obj.lookup,
			omit: obj.omit
		});
	}

	/**
	 * Helper: Check if type is a string type
	 * @private
	 */
	_isStringType(type) {
		const stringTypes = ['CHAR', 'VARCHAR', 'TEXT', 'LONGTEXT', 'MEDIUMTEXT', 'TINYTEXT'];
		return stringTypes.includes(type.toUpperCase());
	}

	/**
	 * Helper: Check if type is a numeric type
	 * @private
	 */
	_isNumericType(type) {
		const numericTypes = [
			'SMALLINT', 'INTEGER', 'INT', 'BIGINT',
			'FLOAT', 'DOUBLE', 'DECIMAL', 'NUMERIC'
		];
		return numericTypes.includes(type.toUpperCase());
	}

	/**
	 * Helper: Check if type is a date/time type
	 * @private
	 */
	_isDateType(type) {
		const dateTypes = ['DATE', 'TIME', 'DATETIME', 'TIMESTAMP'];
		return dateTypes.includes(type.toUpperCase());
	}
}

module.exports = FieldMap;
