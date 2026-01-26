/**
 * Client-Side Table Name Canonicalization Utilities
 * Ensures plan tables use TARGET names when working with mapping
 */

/**
 * Canonicalize a table name to uppercase trimmed string
 */
function canonicalUpper(name) {
	if (!name) return '';
	return String(name).trim().toUpperCase();
}

/**
 * Resolve any table name (source or target) to its canonical TARGET table name
 * Client-side version for PlanUI
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
 * Normalize plan tables array to use ONLY canonical target table names
 */
function normalizePlanTables(planTables, mapping) {
	if (!Array.isArray(planTables)) return planTables;
	if (!mapping || !mapping.tables) return planTables;

	return planTables.map(tableName => resolveTargetTableName(tableName, mapping)).filter(Boolean);
}

// Export to window for use in PlanUI
window.TableNameUtils = {
	canonicalUpper,
	resolveTargetTableName,
	normalizePlanTables
};
