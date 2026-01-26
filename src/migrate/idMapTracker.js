/**
 * Migration ID Map Tracker Module
 * 
 * Purpose: Track source PK → target PK mappings to enable:
 * - Accurate FK resolution without guessing
 * - Full auditability of ID transformations
 * - Deterministic reruns
 * 
 * Critical: Every INSERT/SKIP/UPDATE must record its ID mapping.
 */

const { canonicalUpper } = require('./utils/tableNameCanonical');

/**
 * Record a single source → target PK mapping
 * @param {object} pool - MySQL connection pool
 * @param {number} runId - Migration run ID
 * @param {string} tableName - Target table name (will be canonicalized)
 * @param {string|number} sourcePk - Source primary key value
 * @param {string|number} targetPk - Target primary key value
 * @param {string} operation - 'INSERT', 'SKIP', or 'UPDATE'
 * @returns {Promise<void>}
 */
async function recordIdMapping(pool, { runId, tableName, sourcePk, targetPk, operation }) {
	if (!runId || !tableName || sourcePk == null || targetPk == null || !operation) {
		console.warn('[IdMapTracker] Missing required parameters:', { runId, tableName, sourcePk, targetPk, operation });
		return;
	}

	const canonicalName = canonicalUpper(tableName);
	const sourcePkStr = String(sourcePk);
	const targetPkStr = String(targetPk);

	try {
		await pool.query(
			`INSERT INTO migration_id_map 
       (run_id, table_name, source_pk, target_pk, operation, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE 
         target_pk = VALUES(target_pk),
         operation = VALUES(operation)`,
			[runId, canonicalName, sourcePkStr, targetPkStr, operation]
		);
	} catch (err) {
		console.error(`[IdMapTracker] Failed to record ID mapping for ${canonicalName}:`, err.message);
		// Don't throw - ID tracking is important but shouldn't stop migration
	}
}

/**
 * Record multiple ID mappings in a single batch (more efficient)
 * @param {object} pool - MySQL connection pool
 * @param {number} runId - Migration run ID
 * @param {string} tableName - Target table name
 * @param {Array<{sourcePk, targetPk, operation}>} mappings - Array of mappings
 * @returns {Promise<number>} Count of mappings recorded
 */
async function recordBatch(pool, { runId, tableName, mappings }) {
	if (!runId || !tableName || !mappings || mappings.length === 0) {
		return 0;
	}

	const canonicalName = canonicalUpper(tableName);
	const timestamp = new Date();

	// Build bulk insert
	const values = [];
	const placeholders = [];

	for (const mapping of mappings) {
		if (mapping.sourcePk == null || mapping.targetPk == null) {
			continue;
		}
		placeholders.push('(?, ?, ?, ?, ?, ?)');
		values.push(
			runId,
			canonicalName,
			String(mapping.sourcePk),
			String(mapping.targetPk),
			mapping.operation || 'INSERT',
			timestamp
		);
	}

	if (placeholders.length === 0) {
		return 0;
	}

	try {
		const sql = `
      INSERT INTO migration_id_map 
      (run_id, table_name, source_pk, target_pk, operation, created_at)
      VALUES ${placeholders.join(', ')}
      ON DUPLICATE KEY UPDATE 
        target_pk = VALUES(target_pk),
        operation = VALUES(operation)
    `;

		await pool.query(sql, values);
		return placeholders.length;
	} catch (err) {
		console.error(`[IdMapTracker] Failed to record batch for ${canonicalName}:`, err.message);
		return 0;
	}
}

/**
 * Lookup target PK for a source PK (FK resolution)
 * @param {object} pool - MySQL connection pool
 * @param {number} runId - Migration run ID
 * @param {string} parentTable - Parent table name (will be canonicalized)
 * @param {string|number} sourcePk - Source foreign key value to lookup
 * @returns {Promise<string|null>} Target PK value or null if not found
 */
async function lookupTargetPk(pool, { runId, parentTable, sourcePk }) {
	if (!runId || !parentTable || sourcePk == null) {
		console.warn('[IdMapTracker] Missing parameters for lookupTargetPk:', { runId, parentTable, sourcePk });
		return null;
	}

	const canonicalName = canonicalUpper(parentTable);
	const sourcePkStr = String(sourcePk);

	try {
		const [rows] = await pool.query(
			`SELECT target_pk 
       FROM migration_id_map
       WHERE run_id = ? AND table_name = ? AND source_pk = ?
       ORDER BY created_at DESC
       LIMIT 1`,
			[runId, canonicalName, sourcePkStr]
		);

		if (rows.length === 0) {
			console.warn(`[IdMapTracker] No target PK found for ${canonicalName}.${sourcePkStr} in run ${runId}`);
			return null;
		}

		return rows[0].target_pk;
	} catch (err) {
		console.error(`[IdMapTracker] Failed to lookup target PK:`, err.message);
		return null;
	}
}

/**
 * Lookup multiple target PKs in one query (more efficient for batches)
 * @param {object} pool - MySQL connection pool
 * @param {number} runId - Migration run ID
 * @param {string} parentTable - Parent table name
 * @param {Array<string|number>} sourcePks - Array of source PKs to lookup
 * @returns {Promise<Map<string, string>>} Map of source PK → target PK
 */
async function lookupBatch(pool, { runId, parentTable, sourcePks }) {
	if (!runId || !parentTable || !sourcePks || sourcePks.length === 0) {
		return new Map();
	}

	const canonicalName = canonicalUpper(parentTable);
	const sourcePkStrs = sourcePks.map(pk => String(pk));

	try {
		const placeholders = sourcePkStrs.map(() => '?').join(',');
		const [rows] = await pool.query(
			`SELECT source_pk, target_pk
       FROM migration_id_map
       WHERE run_id = ? AND table_name = ? AND source_pk IN (${placeholders})`,
			[runId, canonicalName, ...sourcePkStrs]
		);

		const resultMap = new Map();
		for (const row of rows) {
			resultMap.set(row.source_pk, row.target_pk);
		}

		return resultMap;
	} catch (err) {
		console.error(`[IdMapTracker] Failed to lookup batch:`, err.message);
		return new Map();
	}
}

/**
 * Get count of ID mappings for a run/table
 * @param {object} pool - MySQL connection pool
 * @param {number} runId - Migration run ID
 * @param {string} tableName - Optional table name filter
 * @returns {Promise<number>}
 */
async function getIdMapCount(pool, runId, tableName = null) {
	let sql = 'SELECT COUNT(*) as count FROM migration_id_map WHERE run_id = ?';
	const params = [runId];

	if (tableName) {
		sql += ' AND table_name = ?';
		params.push(canonicalUpper(tableName));
	}

	const [rows] = await pool.query(sql, params);
	return rows[0].count;
}

/**
 * Check if table has any ID mappings for a run
 * @param {object} pool - MySQL connection pool
 * @param {number} runId - Migration run ID
 * @param {string} tableName - Table name
 * @returns {Promise<boolean>}
 */
async function hasIdMappings(pool, runId, tableName) {
	const count = await getIdMapCount(pool, runId, tableName);
	return count > 0;
}

/**
 * Get operation breakdown (INSERT/SKIP/UPDATE counts) for a table
 * @param {object} pool - MySQL connection pool
 * @param {number} runId - Migration run ID
 * @param {string} tableName - Table name
 * @returns {Promise<{INSERT: number, SKIP: number, UPDATE: number}>}
 */
async function getOperationStats(pool, runId, tableName) {
	const canonicalName = canonicalUpper(tableName);

	const [rows] = await pool.query(
		`SELECT operation, COUNT(*) as count
     FROM migration_id_map
     WHERE run_id = ? AND table_name = ?
     GROUP BY operation`,
		[runId, canonicalName]
	);

	const stats = { INSERT: 0, SKIP: 0, UPDATE: 0 };
	for (const row of rows) {
		stats[row.operation] = row.count;
	}

	return stats;
}

/**
 * Clear ID mappings for a run (useful for testing/rerun)
 * @param {object} pool - MySQL connection pool
 * @param {number} runId - Migration run ID
 * @param {string} tableName - Optional table name (clear all if not provided)
 * @returns {Promise<number>} Count deleted
 */
async function clearIdMappings(pool, runId, tableName = null) {
	let sql = 'DELETE FROM migration_id_map WHERE run_id = ?';
	const params = [runId];

	if (tableName) {
		sql += ' AND table_name = ?';
		params.push(canonicalUpper(tableName));
	}

	const [result] = await pool.query(sql, params);
	console.log(`[IdMapTracker] Cleared ${result.affectedRows} ID mappings for run ${runId}${tableName ? ` table ${tableName}` : ''}`);
	return result.affectedRows;
}

module.exports = {
	recordIdMapping,
	recordBatch,
	lookupTargetPk,
	lookupBatch,
	getIdMapCount,
	hasIdMappings,
	getOperationStats,
	clearIdMappings
};
