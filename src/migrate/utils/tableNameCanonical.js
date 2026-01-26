/**
 * Table Name Canonicalization Utilities
 * 
 * Ensures all migration plans use MySQL TARGET table names as keys,
 * never Firebird SOURCE table names. This prevents "No mapping found" errors.
 */

/**
 * Canonicalize a table name to uppercase trimmed string
 * @param {string} name - Table name (may be source or target)
 * @returns {string} Canonical uppercase name
 */
function canonicalUpper(name) {
	if (!name) return '';
	// Defensive: if an object is passed, try to extract common string fields
	if (typeof name === 'object') {
		const candidates = [
			name.targetTable,
			name.target,
			name.table,
			name.tableName,
			name.name,
			name.value
		];
		for (const c of candidates) {
			if (c && typeof c === 'string') return c.trim().toUpperCase();
		}
		// Fallback to JSON string if nothing useful found
		try {
			return JSON.stringify(name).trim().toUpperCase();
		} catch (e) {
			return String(name).trim().toUpperCase();
		}
	}
	return String(name).trim().toUpperCase();
}

/**
 * Resolve any table name (source or target) to its canonical TARGET table name
 * 
 * Algorithm:
 * 1. If name matches a target table in mapping → return that target
 * 2. If name matches a source key in mapping.tables → return that entry's target
 * 3. Otherwise return canonicalized name as fallback
 * 
 * @param {string} name - Table name (might be source key like WORKDONE or target like WORK_DONE)
 * @param {object} mapping - Mapping object with tables structure
 * @returns {string} Canonical TARGET table name
 */
function resolveTargetTableName(name, mapping) {
	if (!name) return '';
	if (!mapping || !mapping.tables) return canonicalUpper(name);

	const n = canonicalUpper(name);
	const tables = mapping.tables || {};

	// Strategy 1: Check if n matches any TARGET table name
	for (const [sourceKey, config] of Object.entries(tables)) {
		const targetName = config?.targetTable || config?.target || '';
		if (canonicalUpper(targetName) === n) {
			return canonicalUpper(targetName); // Return canonical target
		}
	}

	// Strategy 2: Check if n is a SOURCE table key
	if (tables[n]) {
		const targetName = tables[n]?.targetTable || tables[n]?.target || '';
		if (targetName) {
			return canonicalUpper(targetName);
		}
	}

	// Strategy 3: Check case-insensitive source key match
	for (const [sourceKey, config] of Object.entries(tables)) {
		if (canonicalUpper(sourceKey) === n) {
			const targetName = config?.targetTable || config?.target || '';
			if (targetName) {
				return canonicalUpper(targetName);
			}
		}
	}

	// Fallback: return canonicalized input
	return n;
}

/**
 * Normalize plan tables structure to use ONLY canonical target table names as keys
 * 
 * Handles both:
 * - Array format: ["WORKDONE", "INVOICES"] → convert each to target names
 * - Object format: { "WORKDONE": {...config...} } → rekey to target names
 * 
 * @param {Array<string>|Object} planTablesInput - Plan tables (array or object)
 * @param {object} mapping - Mapping object with tables structure
 * @returns {{ tablesObject: Object, tablesList: Array<string> }}
 */
function normalizePlanTables(planTablesInput, mapping) {
	const tablesObject = {};
	const tablesList = [];

	if (!planTablesInput) {
		return { tablesObject, tablesList };
	}

	// Case 1: Input is an array of table names
	if (Array.isArray(planTablesInput)) {
		for (const tableName of planTablesInput) {
			if (!tableName) continue;

			const targetName = resolveTargetTableName(tableName, mapping);

			if (!tablesList.includes(targetName)) {
				tablesList.push(targetName);
			}

			if (!tablesObject[targetName]) {
				tablesObject[targetName] = {
					include: true,
					mode: 'INSERT',
					keyStrategy: 'preserve',
					onDuplicate: 'SKIP',
					dedupeKeys: []
				};
			}
		}
	}
	// Case 2: Input is an object keyed by table names
	else if (typeof planTablesInput === 'object') {
		for (const [inputKey, config] of Object.entries(planTablesInput)) {
			if (!inputKey) continue;

			const targetName = resolveTargetTableName(inputKey, mapping);

			if (!tablesList.includes(targetName)) {
				tablesList.push(targetName);
			}

			// Merge config into target key (prefer explicit fields, never drop)
			if (!tablesObject[targetName]) {
				tablesObject[targetName] = {
					include: true,
					mode: 'INSERT',
					keyStrategy: 'preserve',
					onDuplicate: 'SKIP',
					dedupeKeys: [],
					...config
				};
			} else {
				// Merge configs deterministically
				tablesObject[targetName] = {
					...tablesObject[targetName],
					...config
				};
			}
		}
	}

	return { tablesObject, tablesList };
}

/**
 * Check if plan tables need normalization (contains any source keys)
 * @param {Object} planTables - Plan tables object
 * @param {Object} mapping - Mapping object
 * @returns {boolean} True if normalization would change keys
 */
function needsNormalization(planTables, mapping) {
	if (!planTables || typeof planTables !== 'object') return false;
	if (!mapping || !mapping.tables) return false;

	for (const tableKey of Object.keys(planTables)) {
		const resolved = resolveTargetTableName(tableKey, mapping);
		if (resolved !== tableKey) {
			return true; // Found a key that would change
		}
	}

	return false;
}

module.exports = {
	canonicalUpper,
	resolveTargetTableName,
	normalizePlanTables,
	needsNormalization
};
