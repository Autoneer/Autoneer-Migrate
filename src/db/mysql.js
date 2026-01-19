const mysql = require("mysql2/promise");

async function createPool(config, database) {
	return mysql.createPool({
		host: config.host,
		port: Number(config.port || 3306),
		user: config.user,
		password: config.password,
		database: database || undefined,
		waitForConnections: true,
		connectionLimit: 10,
		multipleStatements: true
	});
}

async function testConnection(config) {
	const pool = await createPool(config);
	const [rows] = await pool.query("select 1 as ok");
	await pool.end();
	return rows;
}

async function schemaExists(config, schemaName) {
	const pool = await createPool(config);
	const [rows] = await pool.query(
		"select schema_name from information_schema.schemata where schema_name = ?",
		[schemaName]
	);
	await pool.end();
	return rows.length > 0;
}

async function runDDL(config, ddl) {
	const pool = await createPool(config);
	await pool.query(ddl);
	await pool.end();
}

async function createSchema(config, ddl) {
	return runDDL(config, ddl);
}

async function connectToSchema(config, schemaName) {
	return createPool(config, schemaName);
}

async function listTables(pool) {
	const [rows] = await pool.query(
		"select table_name as name from information_schema.tables where table_schema = database() order by table_name"
	);
	return rows.map((r) => r.name);
}

async function listColumns(pool, tableName) {
	const [rows] = await pool.query(
		"select column_name as name, data_type as dataType, column_key as columnKey from information_schema.columns where table_schema = database() and table_name = ? order by ordinal_position",
		[tableName]
	);
	return rows;
}

async function getPrimaryKeys(pool, tableName) {
	const [rows] = await pool.query(
		"select column_name as name from information_schema.columns where table_schema = database() and table_name = ? and column_key = 'PRI' order by ordinal_position",
		[tableName]
	);
	return rows.map((r) => r.name);
}

async function ensureMigrationTables(pool) {
	const ddl = `
    create table if not exists migration_runs (
      id varchar(36) primary key,
      status varchar(20) not null,
      error_message varchar(1000) null,
      created_at timestamp default current_timestamp,
      started_at timestamp null,
      finished_at timestamp null,
      dry_run tinyint(1) default 0,
      batch_size int default 500,
      fk_checks tinyint(1) default 1,
      schema_name varchar(100) not null,
      plan_json longtext,
      mapping_profile_id int null
    );

    create table if not exists migration_table_runs (
      id bigint auto_increment primary key,
      run_id varchar(36) not null,
      table_name varchar(100) not null,
      mode varchar(30) not null,
      key_strategy varchar(30) not null,
      status varchar(20) not null,
      started_at timestamp null,
      finished_at timestamp null,
      last_offset int default 0,
      rows_source int default 0,
      rows_migrated int default 0,
      rows_skipped int default 0,
			rows_skipped_duplicates int default 0,
      rows_error int default 0,
      error_message varchar(500) null,
      index idx_migration_table_runs_run (run_id)
    );

    create table if not exists migration_row_errors (
      id bigint auto_increment primary key,
      run_id varchar(36) not null,
      table_name varchar(100) not null,
			source_table varchar(100) null,
			target_table varchar(100) null,
      row_offset int,
			source_pk varchar(100) null,
      error_message varchar(1000),
			hint varchar(500) null,
      row_json longtext,
      created_at timestamp default current_timestamp,
      index idx_migration_row_errors_run (run_id)
    );

    create table if not exists migration_mapping_profiles (
      id int auto_increment primary key,
      name varchar(100) not null,
      mapping_json longtext not null,
			created_at timestamp default current_timestamp,
			updated_at timestamp null
    );

    create table if not exists migration_id_map (
      id bigint auto_increment primary key,
      run_id varchar(36) not null,
      table_name varchar(100) not null,
      source_id varchar(100) not null,
      target_id varchar(100) not null,
      index idx_migration_id_map_run (run_id),
      index idx_migration_id_map_table (table_name)
    );
  `;
	await pool.query(ddl);

	const [columns] = await pool.query(
		"select column_name as name from information_schema.columns where table_schema = database() and table_name = 'migration_runs'"
	);
	const columnNames = columns.map((c) => c.name.toLowerCase());
	if (!columnNames.includes("error_message")) {
		await pool.query("alter table migration_runs add column error_message varchar(1000) null");
	}

	const [rowErrorCols] = await pool.query(
		"select column_name as name from information_schema.columns where table_schema = database() and table_name = 'migration_row_errors'"
	);
	const rowErrorNames = rowErrorCols.map((c) => c.name.toLowerCase());

	const [tableRunCols] = await pool.query(
		"select column_name as name from information_schema.columns where table_schema = database() and table_name = 'migration_table_runs'"
	);
	const tableRunNames = tableRunCols.map((c) => c.name.toLowerCase());
	if (!tableRunNames.includes("rows_skipped_duplicates")) {
		await pool.query("alter table migration_table_runs add column rows_skipped_duplicates int default 0");
	}
	if (!rowErrorNames.includes("source_table")) {
		await pool.query("alter table migration_row_errors add column source_table varchar(100) null");
	}
	if (!rowErrorNames.includes("target_table")) {
		await pool.query("alter table migration_row_errors add column target_table varchar(100) null");
	}
	if (!rowErrorNames.includes("source_pk")) {
		await pool.query("alter table migration_row_errors add column source_pk varchar(100) null");
	}
	if (!rowErrorNames.includes("hint")) {
		await pool.query("alter table migration_row_errors add column hint varchar(500) null");
	}

	const [profileCols] = await pool.query(
		"select column_name as name from information_schema.columns where table_schema = database() and table_name = 'migration_mapping_profiles'"
	);
	const profileNames = profileCols.map((c) => c.name.toLowerCase());
	if (!profileNames.includes("updated_at")) {
		await pool.query("alter table migration_mapping_profiles add column updated_at timestamp null");
	}
}

module.exports = {
	testConnection,
	schemaExists,
	createSchema,
	connectToSchema,
	listTables,
	listColumns,
	getPrimaryKeys,
	ensureMigrationTables
};
