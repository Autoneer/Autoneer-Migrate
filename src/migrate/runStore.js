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
		"update migration_runs set status = ?, ended_at = now() where run_id = ?",
		[status, runId]
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
	const [rows] = await pool.query("select * from migration_runs where run_id = ?", [runId]);
	return rows[0] || null;
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
	await pool.query(
		"insert into migration_id_map (run_id, table_name, source_id, target_id) values (?, ?, ?, ?)",
		[String(runId), tableName, String(sourceId), String(targetId)]
	);
}

async function lookupIdMap(pool, { runId, tableName, sourceId }) {
	const [rows] = await pool.query(
		"select target_id from migration_id_map where run_id = ? and table_name = ? and source_id = ?",
		[String(runId), tableName, String(sourceId)]
	);
	return rows[0]?.target_id || null;
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
};
