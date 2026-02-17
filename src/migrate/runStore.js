const { v4: uuidv4 } = require("uuid");

async function createRun(pool, { run_label, source_conn_name, target_schema_name, plan_id, schemaName, dryRun, batchSize, fkChecks, plan, mappingProfileId }) {
	const [result] = await pool.query(
		"insert into migration_runs (plan_id, run_label, source_conn_name, target_schema_name, started_at, status, table_summary_json, error_count, warn_count) values (?, ?, ?, ?, now(), 'RUNNING', ?, 0, 0)",
		[plan_id || null, run_label || null, source_conn_name || null, target_schema_name || null, JSON.stringify({})]
	);
	const runId = result.insertId;

	// also create legacy run entry for compatibility
	const legacyId = uuidv4();
	await pool.query(
		"insert into migration_runs_legacy (id, status, started_at, dry_run, batch_size, fk_checks, schema_name, plan_json, mapping_profile_id) values (?, 'running', now(), ?, ?, ?, ?, ?, ?)",
		[legacyId, dryRun ? 1 : 0, batchSize, fkChecks ? 1 : 0, schemaName || null, JSON.stringify(plan || []), mappingProfileId || null]
	);

	return runId;
}

async function finishRun(pool, runId, status, errorMessage) {
	// status should be one of RUNNING/SUCCESS/FAILED/CANCELLED
	await pool.query(
		"update migration_runs set status = ?, ended_at = now(), error_message = ? where run_id = ?",
		[status, errorMessage || null, runId]
	);

	// also update legacy finished_at/status if present (best-effort)
	try {
		await pool.query("update migration_runs_legacy set status = ?, finished_at = now(), error_message = ? where id = (select id from migration_runs_legacy order by created_at desc limit 1)", [status === 'SUCCESS' ? 'success' : 'failed', errorMessage || null]);
	} catch (e) {
		// ignore
	}
}

async function startTableRun(pool, runId, tableName, mode, keyStrategy) {
	const [result] = await pool.query(
		"insert into migration_table_runs (run_id, table_name, mode, key_strategy, status, started_at) values (?, ?, ?, ?, 'running', now())",
		[runId, tableName, mode, keyStrategy]
	);
	return result.insertId;
}

async function updateTableProgress(pool, runId, tableName, fields) {
	const columns = [];
	const values = [];
	Object.entries(fields).forEach(([key, value]) => {
		columns.push(`${key} = ?`);
		values.push(value);
	});
	values.push(runId, tableName);
	const sql = `update migration_table_runs set ${columns.join(", ")} where run_id = ? and table_name = ? and status = 'running'`;
	await pool.query(sql, values);

	// also update summary JSON in migration_runs
	try {
		const [rows] = await pool.query("select table_summary_json from migration_runs where run_id = ?", [runId]);
		const summary = rows[0] && rows[0].table_summary_json ? rows[0].table_summary_json : {};
		summary[tableName] = Object.assign({}, summary[tableName] || {}, fields);
		await pool.query("update migration_runs set table_summary_json = ? where run_id = ?", [JSON.stringify(summary), runId]);
	} catch (e) {
		// ignore summary update errors
	}
}

async function finishTableRun(pool, runId, tableName, status, errorMessage) {
	await pool.query(
		"update migration_table_runs set status = ?, finished_at = now(), error_message = ? where run_id = ? and table_name = ? and status = 'running'",
		[status, errorMessage || null, runId, tableName]
	);

	// update summary
	try {
		const [rows] = await pool.query("select table_summary_json from migration_runs where run_id = ?", [runId]);
		const summary = rows[0] && rows[0].table_summary_json ? rows[0].table_summary_json : {};
		summary[tableName] = Object.assign({}, summary[tableName] || {}, { status, error_message: errorMessage || null });
		await pool.query("update migration_runs set table_summary_json = ? where run_id = ?", [JSON.stringify(summary), runId]);
	} catch (e) {
		// ignore
	}
}

async function logRowError(pool, { runId, tableName, sourceTable, targetTable, rowOffset, sourcePk, errorMessage, hint, rowJson }) {
	// write to new run errors table
	await pool.query(
		"insert into migration_run_errors (run_id, table_name, source_pk, field_name, error_code, message) values (?, ?, ?, ?, ?, ?)",
		[runId, tableName, sourcePk ? String(sourcePk) : null, null, null, errorMessage]
	);

	// increment error_count
	await pool.query("update migration_runs set error_count = error_count + 1 where run_id = ?", [runId]);

	// also keep legacy row error for compatibility
	await pool.query(
		"insert into migration_row_errors (run_id, table_name, source_table, target_table, row_offset, source_pk, error_message, hint, row_json) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		[String(runId), tableName, sourceTable || null, targetTable || null, rowOffset || null, sourcePk ? String(sourcePk) : null, errorMessage, hint || null, rowJson]
	);
}

async function getRun(pool, runId) {
	// Try new schema first (run_id). If the column doesn't exist, fall back to legacy `id`.
	try {
		const [rows] = await pool.query("select * from migration_runs where run_id = ?", [runId]);
		return rows[0] || null;
	} catch (err) {
		// If the error indicates missing column `run_id`, try legacy id column
		if (err && err.code === 'ER_BAD_FIELD_ERROR' && /run_id/i.test(err.sqlMessage || '')) {
			try {
				const [rows2] = await pool.query("select * from migration_runs where id = ?", [runId]);
				return rows2[0] || null;
			} catch (e2) {
				return null;
			}
		}
		throw err;
	}
}

async function getRunTables(pool, runId) {
	const [rows] = await pool.query(
		"select * from migration_table_runs where run_id = ? order by id",
		[runId]
	);
	return rows;
}

async function getTableRun(pool, runId, tableName) {
	const [rows] = await pool.query(
		"select * from migration_table_runs where run_id = ? and table_name = ? order by id desc limit 1",
		[runId, tableName]
	);
	return rows[0] || null;
}

async function getRowErrors(pool, runId) {
	const [rows] = await pool.query(
		"select * from migration_run_errors where run_id = ? order by id",
		[runId]
	);
	return rows;
}

// Migration plans (reusable mapping definitions)
async function savePlan(pool, { name, mappingJson, sourceSig, targetSig, created_by_staff_id }) {
	const [result] = await pool.query(
		"insert into migration_plans (name, mapping_json, source_schema_signature, target_schema_signature, created_by_staff_id, created_at) values (?, ?, ?, ?, ?, now())",
		[name, mappingJson, sourceSig || null, targetSig || null, created_by_staff_id || null]
	);
	return result.insertId;
}

async function getPlan(pool, planId) {
	const [rows] = await pool.query("select * from migration_plans where plan_id = ?", [planId]);
	return rows[0] || null;
}

async function updatePlan(pool, planId, { name, mappingJson, sourceSig, targetSig }) {
	await pool.query(
		"update migration_plans set name = ?, mapping_json = ?, source_schema_signature = ?, target_schema_signature = ?, updated_at = now() where plan_id = ?",
		[name, mappingJson, sourceSig || null, targetSig || null, planId]
	);
}

async function clonePlan(pool, planId, newName) {
	const plan = await getPlan(pool, planId);
	if (!plan) return null;
	const mappingJson = plan.mapping_json;
	const [result] = await pool.query(
		"insert into migration_plans (name, mapping_json, source_schema_signature, target_schema_signature, created_by_staff_id, created_at) values (?, ?, ?, ?, ?, now())",
		[newName, mappingJson, plan.source_schema_signature, plan.target_schema_signature, plan.created_by_staff_id || null]
	);
	return result.insertId;
}

async function listPlans(pool) {
	const [rows] = await pool.query("select plan_id, name, created_at, updated_at from migration_plans order by created_at desc");
	return rows;
}

/* Presets and Profiles storage helpers */
async function upsertPreset(pool, { code, name, description, definitionJson, isSystem = 0, isActive = 1 }) {
	// Try update first
	try {
		const [existing] = await pool.query('select preset_id from migration_presets where code = ?', [code]);
		if (existing && existing.length > 0) {
			await pool.query('update migration_presets set name = ?, description = ?, definition_json = ?, is_system = ?, is_active = ?, updated_at = now() where code = ?', [name, JSON.stringify(definitionJson), JSON.stringify(definitionJson) === definitionJson ? definitionJson : JSON.stringify(definitionJson), isSystem, isActive, code]);
			const [row] = await pool.query('select preset_id from migration_presets where code = ?', [code]);
			return row[0]?.preset_id || null;
		}
	} catch (e) {
		// ignore
	}

	const [result] = await pool.query('insert into migration_presets (code, name, description, definition_json, is_active, is_system) values (?, ?, ?, ?, ?, ?)', [code, name, description || null, JSON.stringify(definitionJson), isActive, isSystem]);
	return result.insertId;
}

async function listPresets(pool) {
	const [rows] = await pool.query('select preset_id, code, name, description, is_active, is_system, created_at, updated_at from migration_presets where is_active = 1 order by is_system desc, name');
	return rows;
}

async function getPreset(pool, id) {
	const [rows] = await pool.query('select * from migration_presets where preset_id = ?', [id]);
	return rows[0] || null;
}

async function updatePreset(pool, id, { name, description, definitionJson, isActive }) {
	await pool.query('update migration_presets set name = ?, description = ?, definition_json = ?, is_active = ?, updated_at = now() where preset_id = ?', [name, description || null, JSON.stringify(definitionJson), isActive ? 1 : 0, id]);
}

async function deactivatePreset(pool, id) {
	await pool.query('update migration_presets set is_active = 0 where preset_id = ?', [id]);
}

// Profiles
async function saveProfile(pool, { name, description, mappingJson, sourceSig, targetSig, createdFromPresetCode }) {
	const [result] = await pool.query('insert into migration_profiles (name, description, mapping_json, source_schema_signature, target_schema_signature, created_from_preset_code, created_at) values (?, ?, ?, ?, ?, ?, now())', [name, description || null, JSON.stringify(mappingJson), sourceSig || null, targetSig || null, createdFromPresetCode || null]);
	return result.insertId;
}

async function listProfiles(pool) {
	const [rows] = await pool.query('select profile_id, name, description, created_from_preset_code, created_at, updated_at from migration_profiles order by created_at desc');
	return rows;
}

async function getProfile(pool, id) {
	const [rows] = await pool.query('select * from migration_profiles where profile_id = ?', [id]);
	return rows[0] || null;
}

async function updateProfile(pool, id, { name, description, mappingJson }) {
	await pool.query('update migration_profiles set name = ?, description = ?, mapping_json = ?, updated_at = now() where profile_id = ?', [name, description || null, JSON.stringify(mappingJson), id]);
}

async function deleteProfile(pool, id) {
	await pool.query('delete from migration_profiles where profile_id = ?', [id]);
}

// keep mapping profile functions for UI compatibility
async function saveMappingProfile(pool, { name, mappingJson }) {
	const [result] = await pool.query(
		"insert into migration_mapping_profiles (name, mapping_json) values (?, ?)",
		[name, mappingJson]
	);
	return result.insertId;
}

async function listMappingProfiles(pool) {
	const [rows] = await pool.query(
		"select id, name, created_at from migration_mapping_profiles order by created_at desc"
	);
	return rows;
}

async function getMappingProfile(pool, id) {
	const [rows] = await pool.query(
		"select * from migration_mapping_profiles where id = ?",
		[id]
	);
	return rows[0] || null;
}

async function updateMappingProfile(pool, id, { name, mappingJson }) {
	await pool.query(
		"update migration_mapping_profiles set name = ?, mapping_json = ?, updated_at = now() where id = ?",
		[name, mappingJson, id]
	);
}

async function deleteMappingProfile(pool, id) {
	await pool.query("delete from migration_mapping_profiles where id = ?", [id]);
}

async function storeIdMap(pool, { runId, tableName, sourceId, targetId }) {
	// Persist source -> target PK mapping using new column names
	try {
		await pool.query(
			"INSERT INTO migration_id_map (run_id, table_name, source_pk, target_pk, operation, created_at) VALUES (?, ?, ?, ?, 'INSERT', NOW()) ON DUPLICATE KEY UPDATE target_pk = VALUES(target_pk), operation = VALUES(operation)",
			[String(runId), tableName, String(sourceId), String(targetId)]
		);
	} catch (err) {
		console.error('[RunStore] storeIdMap failed:', err.message);
	}
}

async function lookupIdMap(pool, { runId, tableName, sourceId }) {
	const [rows] = await pool.query(
		"SELECT target_pk FROM migration_id_map WHERE run_id = ? AND table_name = ? AND source_pk = ? ORDER BY created_at DESC LIMIT 1",
		[String(runId), tableName, String(sourceId)]
	);
	return rows[0]?.target_pk || null;
}

async function deleteRun(pool, runId) {
	// delete all rows related to a run. Use transaction to ensure consistency.
	await pool.query('START TRANSACTION');
	try {
		await pool.query('delete from migration_run_errors where run_id = ?', [runId]);
		await pool.query('delete from migration_row_errors where run_id = ?', [String(runId)]);
		await pool.query('delete from migration_table_runs where run_id = ?', [runId]);
		await pool.query('delete from migration_id_map where run_id = ?', [String(runId)]);
		await pool.query('delete from migration_runs where run_id = ?', [runId]);
		// best-effort: attempt to delete legacy entry if its id equals runId (unlikely)
		try {
			await pool.query('delete from migration_runs_legacy where id = ?', [String(runId)]);
		} catch (e) {
			// ignore
		}
		await pool.query('COMMIT');
	} catch (err) {
		try {
			await pool.query('ROLLBACK');
		} catch (e) {
			// ignore
		}
		throw err;
	}
}

module.exports = {
	createRun,
	finishRun,
	startTableRun,
	updateTableProgress,
	finishTableRun,
	logRowError,
	getRun,
	getRunTables,
	getTableRun,
	getRowErrors,
	saveMappingProfile,
	listMappingProfiles,
	getMappingProfile,
	updateMappingProfile,
	deleteMappingProfile,
	storeIdMap,
	lookupIdMap,
	// plans
	savePlan,
	getPlan,
	updatePlan,
	clonePlan,
	listPlans
	,
	deleteRun
	,
	// presets
	upsertPreset,
	listPresets,
	getPreset,
	updatePreset,
	deactivatePreset,

	// profiles
	saveProfile,
	listProfiles,
	getProfile,
	updateProfile,
	deleteProfile
};
