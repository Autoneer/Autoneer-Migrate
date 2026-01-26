/**
 * Migration Mapping Persistence Module
 * 
 * Purpose: Save and load immutable per-run mapping snapshots to enable:
 * - Deterministic plan reuse (ignore profile changes)
 * - Accurate dry-run validation
 * - Full audit trail of what mappings were used
 * 
 * Critical: Mappings are resolved ONCE at run start and never regenerated.
 */

const { resolveTargetTableName, canonicalUpper } = require('./utils/tableNameCanonical');

/**
 * Save resolved mappings for a run to migration_run_mappings table
 * @param {object} pool - MySQL connection pool
 * @param {number} runId - Migration run ID
 * @param {number} planId - Migration plan ID (optional)
 * @param {string} mappingProfileId - Mapping profile ID (optional)
 * @param {object} mapping - Fully resolved mapping object
 * @param {Array} includedTables - Array of table names to include (already canonical)
 * @returns {Promise<number>} Count of mappings saved
 */
async function saveRunMappings(pool, { runId, planId, mappingProfileId, mapping, includedTables }) {
	if (!runId || !mapping || !mapping.tables) {
		throw new Error('[MappingPersistence] Missing required parameters for saveRunMappings');
	}

	const timestamp = new Date();
	let savedCount = 0;

	console.log(`[MappingPersistence] Saving mappings for run ${runId}, ${includedTables.length} tables`);

	for (const tableName of includedTables) {
		// Ensure canonical uppercase target name
		const canonicalName = canonicalUpper(tableName);

		// Find the mapping entry for this table (support multiple mapping shapes)
		let tableMapping = null;
		for (const [srcKey, entry] of Object.entries(mapping.tables || {})) {
			const targetCandidate = (entry && (entry.targetTable || entry.target)) || '';
			if (canonicalUpper(targetCandidate) === canonicalName) {
				tableMapping = Object.assign({}, entry);
				// Ensure we have the sourceTable recorded (use the source key if not present)
				if (!tableMapping.sourceTable) tableMapping.sourceTable = srcKey;
				if (!tableMapping.targetTable) tableMapping.targetTable = targetCandidate;
				break;
			}
		}

		if (!tableMapping) {
			console.warn(`[MappingPersistence] No mapping found for table ${canonicalName}, skipping`);
			continue;
		}

		// Build full resolved mapping JSON (no placeholders)
		const mappingJson = {
			sourceTable: tableMapping.sourceTable,
			targetTable: tableMapping.targetTable,
			columns: tableMapping.columns || [],
			keyStrategy: tableMapping.keyStrategy || 'skip',
			primaryKey: tableMapping.primaryKey || null,
			foreignKeys: tableMapping.foreignKeys || [],
			transforms: tableMapping.transforms || {},
			validations: tableMapping.validations || {}
		};

		try {
			await pool.query(
				`INSERT INTO migration_run_mappings 
         (run_id, plan_id, mapping_profile_id, table_name, source_table, target_table, mapping_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE mapping_json = VALUES(mapping_json)`,
				[
					runId,
					planId || null,
					mappingProfileId || null,
					canonicalName,
					tableMapping.sourceTable,
					tableMapping.targetTable,
					JSON.stringify(mappingJson),
					timestamp
				]
			);
			savedCount++;
		} catch (err) {
			console.error(`[MappingPersistence] Failed to save mapping for ${canonicalName}:`, err.message);
			// Continue with other tables
		}
	}

	console.log(`[MappingPersistence] Saved ${savedCount} mapping snapshots for run ${runId}`);
	return savedCount;
}

/**
 * Load run mappings from migration_run_mappings table
 * @param {object} pool - MySQL connection pool
 * @param {number} runId - Migration run ID
 * @returns {Promise<object|null>} Mapping object or null if not found
 */
async function loadRunMappings(pool, runId) {
	if (!runId) {
		throw new Error('[MappingPersistence] Missing runId for loadRunMappings');
	}

	const [rows] = await pool.query(
		`SELECT table_name, source_table, target_table, mapping_json, created_at
     FROM migration_run_mappings
     WHERE run_id = ?
     ORDER BY table_name`,
		[runId]
	);

	if (rows.length === 0) {
		console.warn(`[MappingPersistence] No mappings found for run ${runId}`);
		return null;
	}

	// Reconstruct mapping object
	const mapping = {
		tables: {},
		sourceDatabase: 'firebird',
		targetDatabase: 'mysql'
	};

	for (const row of rows) {
		const tableMapping = JSON.parse(row.mapping_json);

		// Use source table name as key (for compatibility)
		const sourceKey = row.source_table;
		mapping.tables[sourceKey] = {
			sourceTable: row.source_table,
			targetTable: row.target_table,
			columns: tableMapping.columns || [],
			keyStrategy: tableMapping.keyStrategy || 'skip',
			primaryKey: tableMapping.primaryKey || null,
			foreignKeys: tableMapping.foreignKeys || [],
			transforms: tableMapping.transforms || {},
			validations: tableMapping.validations || {}
		};
	}

	console.log(`[MappingPersistence] Loaded ${rows.length} mappings for run ${runId}`);
	return mapping;
}

/**
 * Check if run has persisted mappings
 * @param {object} pool - MySQL connection pool
 * @param {number} runId - Migration run ID
 * @returns {Promise<boolean>}
 */
async function hasRunMappings(pool, runId) {
	const [rows] = await pool.query(
		'SELECT COUNT(*) as count FROM migration_run_mappings WHERE run_id = ?',
		[runId]
	);
	return rows[0].count > 0;
}

/**
 * Get count of saved mappings for a run
 * @param {object} pool - MySQL connection pool
 * @param {number} runId - Migration run ID
 * @returns {Promise<number>}
 */
async function getRunMappingCount(pool, runId) {
	const [rows] = await pool.query(
		'SELECT COUNT(*) as count FROM migration_run_mappings WHERE run_id = ?',
		[runId]
	);
	return rows[0].count;
}

/**
 * Auto-generate mappings for old runs that are missing them
 * This is for backward compatibility and self-healing
 * @param {object} pool - MySQL connection pool
 * @param {number} runId - Migration run ID
 * @param {object} mapping - Current mapping object to use as template
 * @param {object} plan - Migration plan with table list
 * @returns {Promise<number>} Count of mappings generated
 */
async function autoGenerateMissingMappings(pool, { runId, mapping, plan, planId, mappingProfileId }) {
	if (!runId || !mapping || !plan) {
		throw new Error('[MappingPersistence] Missing required parameters for autoGenerateMissingMappings');
	}

	// Check if already has mappings
	if (await hasRunMappings(pool, runId)) {
		console.log(`[MappingPersistence] Run ${runId} already has mappings, skipping auto-generation`);
		return 0;
	}

	console.warn(`[MappingPersistence] Auto-generating missing mappings for run ${runId}`);

	// Get table list from plan (normalize to target names)
	let planEntries = [];
	if (Array.isArray(plan)) {
		planEntries = plan;
	} else if (Array.isArray(plan.tables)) {
		planEntries = plan.tables;
	} else if (plan.tables && typeof plan.tables === 'object') {
		planEntries = Object.keys(plan.tables);
	}

	const includedTables = planEntries.map(t => resolveTargetTableName(t, mapping));

	// Save mappings
	const count = await saveRunMappings(pool, {
		runId,
		planId: planId || null,
		mappingProfileId: mappingProfileId || null,
		mapping,
		includedTables
	});

	console.log(`[MappingPersistence] Auto-generated ${count} mappings for run ${runId}`);
	return count;
}

/**
 * Get list of runs missing persisted mappings
 * @param {object} pool - MySQL connection pool
 * @param {number} limit - Maximum number of runs to return
 * @returns {Promise<Array>} Array of {run_id, started_at, status}
 */
async function findRunsWithoutMappings(pool, limit = 100) {
	// Some installations use legacy `migration_runs` schema with `id` (varchar) instead of `run_id` (int).
	// Detect which column exists and return rows with a normalized `run_id` field.
	const [cols] = await pool.query(
		`select column_name from information_schema.columns where table_schema = database() and table_name = 'migration_runs'`
	);
	const columnNames = cols.map(c => String(c.COLUMN_NAME || c.column_name).toLowerCase());
	const hasRunId = columnNames.includes('run_id');
	const hasPlanId = columnNames.includes('plan_id');

	if (hasRunId) {
		const planSelect = hasPlanId ? 'r.plan_id' : 'NULL as plan_id';
		const [rows] = await pool.query(
			`SELECT r.run_id as run_id, r.started_at, r.status, ${planSelect}
	 FROM migration_runs r
	 LEFT JOIN migration_run_mappings m ON r.run_id = m.run_id
	 WHERE m.id IS NULL
	 AND r.status IN ('SUCCESS', 'COMPLETED_WITH_ERRORS', 'RUNNING')
	 ORDER BY r.started_at DESC
	 LIMIT ?`,
			[limit]
		);
		return rows;
	}

	// Fallback for legacy schema using `id` as identifier
	const planSelectLegacy = hasPlanId ? 'r.plan_id' : 'NULL as plan_id';
	const [rows] = await pool.query(
		`SELECT r.id as run_id, r.started_at, r.status, ${planSelectLegacy}
	 FROM migration_runs r
	 LEFT JOIN migration_run_mappings m ON r.id = m.run_id
	 WHERE m.id IS NULL
	 AND r.status IN ('SUCCESS', 'COMPLETED_WITH_ERRORS', 'RUNNING')
	 ORDER BY r.started_at DESC
	 LIMIT ?`,
		[limit]
	);

	return rows;
}

module.exports = {
	saveRunMappings,
	loadRunMappings,
	hasRunMappings,
	getRunMappingCount,
	autoGenerateMissingMappings,
	findRunsWithoutMappings
};
