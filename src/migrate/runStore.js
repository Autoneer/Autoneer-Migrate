const { v4: uuidv4 } = require("uuid");

async function createRun(pool, { schemaName, dryRun, batchSize, fkChecks, plan, mappingProfileId }) {
	const id = uuidv4();
	await pool.query(
		"insert into migration_runs (id, status, started_at, dry_run, batch_size, fk_checks, schema_name, plan_json, mapping_profile_id) values (?, 'running', now(), ?, ?, ?, ?, ?, ?)",
		[id, dryRun ? 1 : 0, batchSize, fkChecks ? 1 : 0, schemaName, JSON.stringify(plan), mappingProfileId || null]
	);
	return id;
}

async function finishRun(pool, runId, status, errorMessage) {
	await pool.query(
		"update migration_runs set status = ?, finished_at = now(), error_message = ? where id = ?",
		[status, errorMessage || null, runId]
	);
}

async function startTableRun(pool, runId, tableName, mode, keyStrategy) {
	await pool.query(
		"insert into migration_table_runs (run_id, table_name, mode, key_strategy, status, started_at) values (?, ?, ?, ?, 'running', now())",
		[runId, tableName, mode, keyStrategy]
	);
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
}

async function finishTableRun(pool, runId, tableName, status, errorMessage) {
	await pool.query(
		"update migration_table_runs set status = ?, finished_at = now(), error_message = ? where run_id = ? and table_name = ? and status = 'running'",
		[status, errorMessage || null, runId, tableName]
	);
}

async function logRowError(pool, { runId, tableName, sourceTable, targetTable, rowOffset, sourcePk, errorMessage, hint, rowJson }) {
	await pool.query(
		"insert into migration_row_errors (run_id, table_name, source_table, target_table, row_offset, source_pk, error_message, hint, row_json) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		[runId, tableName, sourceTable || null, targetTable || null, rowOffset || null, sourcePk ? String(sourcePk) : null, errorMessage, hint || null, rowJson]
	);
}

async function getRun(pool, runId) {
	const [rows] = await pool.query("select * from migration_runs where id = ?", [runId]);
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
		"select * from migration_row_errors where run_id = ? order by id",
		[runId]
	);
	return rows;
}

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
		[runId, tableName, String(sourceId), String(targetId)]
	);
}

async function lookupIdMap(pool, { runId, tableName, sourceId }) {
	const [rows] = await pool.query(
		"select target_id from migration_id_map where run_id = ? and table_name = ? and source_id = ?",
		[runId, tableName, String(sourceId)]
	);
	return rows[0]?.target_id || null;
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
	lookupIdMap
};
