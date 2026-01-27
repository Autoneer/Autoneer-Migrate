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

async function listUniqueIndexes(pool, tableName) {
	const [rows] = await pool.query(
		"select index_name as name, non_unique as nonUnique, seq_in_index as seq, column_name as columnName from information_schema.statistics where table_schema = database() and table_name = ? order by index_name, seq_in_index",
		[tableName]
	);
	const map = new Map();
	for (const row of rows) {
		if (row.nonUnique) continue;
		if (row.name === "PRIMARY") continue;
		if (!map.has(row.name)) {
			map.set(row.name, []);
		}
		map.get(row.name).push(row.columnName);
	}
	return Array.from(map.entries()).map(([name, columns]) => ({ name, columns }));
}

function hasUniqueIndexForColumns(indexes, columns) {
	if (!columns?.length) return false;
	const target = columns.map((c) => c.toLowerCase()).sort();
	return indexes.some((idx) => {
		const cols = (idx.columns || []).map((c) => c.toLowerCase()).sort();
		if (cols.length !== target.length) return false;
		return cols.every((col, i) => col === target[i]);
	});
}

async function createUniqueIndex(pool, tableName, indexName, columns) {
	const colList = columns.map((c) => `\`${c}\``).join(", ");
	await pool.query(`create unique index \`${indexName}\` on \`${tableName}\` (${colList})`);
}

async function dropIndex(pool, tableName, indexName) {
	await pool.query(`drop index \`${indexName}\` on \`${tableName}\``);
}

async function ensureMigrationTables(pool) {
	const ddl = `
		-- New migration_runs table per spec
		create table if not exists migration_runs (
			run_id int auto_increment primary key,
			plan_id int null,
			run_label varchar(150) null,
			source_conn_name varchar(150) null,
			target_schema_name varchar(150) null,
			started_at datetime null,
			ended_at datetime null,
			status enum('RUNNING','SUCCESS','FAILED','CANCELLED') not null default 'RUNNING',
			table_summary_json json null,
			error_count int default 0,
			warn_count int default 0,
			index idx_runs_status_started (status, started_at)
		);

		-- Backwards-compatibility: keep legacy migration_runs (id uuid) if other code expects it
		create table if not exists migration_runs_legacy (
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

		-- New migration_run_errors per spec (row-level errors linked to integer run_id)
		create table if not exists migration_run_errors (
			id int auto_increment primary key,
			run_id int not null,
			table_name varchar(100) not null,
			source_pk varchar(100) null,
			field_name varchar(100) null,
			error_code varchar(50) null,
			message text,
			created_at datetime default current_timestamp,
			index idx_run_errors_run (run_id, table_name)
		);

    create table if not exists migration_mapping_profiles (
      id int auto_increment primary key,
      name varchar(100) not null,
      mapping_json longtext not null,
			created_at timestamp default current_timestamp,
			updated_at timestamp null
    );

		-- Presets table for admin-editable migration presets
		create table if not exists migration_presets (
			preset_id int auto_increment primary key,
			code varchar(50) not null unique,
			name varchar(100) not null,
			description varchar(255) null,
			definition_json json not null,
			is_active tinyint(1) not null default 1,
			is_system tinyint(1) not null default 0,
			created_at timestamp default current_timestamp,
			updated_at timestamp null default null on update current_timestamp,
			index idx_presets_active (is_active)
		);

		-- Saved reusable profiles (mapping snapshots)
		create table if not exists migration_profiles (
			profile_id int auto_increment primary key,
			name varchar(150) not null unique,
			description varchar(255) null,
			mapping_json json not null,
			source_schema_signature varchar(255) null,
			target_schema_signature varchar(255) null,
			created_by_staff_id int null,
			created_from_preset_code varchar(50) null,
			created_at timestamp default current_timestamp,
			updated_at timestamp null default null on update current_timestamp,
			index idx_profiles_from_preset (created_from_preset_code)
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
	// Add cleaned flag to record that a table was cleaned as part of this run
	if (!tableRunNames.includes("cleaned")) {
		await pool.query("alter table migration_table_runs add column cleaned tinyint(1) default 0");
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

	const [planTables] = await pool.query(
		"select table_name as name from information_schema.tables where table_schema = database() and table_name = 'migration_plans'"
	);
	if (planTables.length > 0) {
		const [planCols] = await pool.query(
			"select column_name as name, is_nullable as isNullable from information_schema.columns where table_schema = database() and table_name = 'migration_plans'"
		);
		const planNames = planCols.map((c) => c.name.toLowerCase());
		let mappingProfileColumn = planCols.find((c) => String(c.name).toLowerCase() === 'mapping_profile_id');

		if (!planNames.includes("mapping_profile_id")) {
			await pool.query("alter table migration_plans add column mapping_profile_id int null");
			mappingProfileColumn = { name: 'mapping_profile_id', isNullable: 'YES' };
		}

		// Backfill from legacy mapping_id column if present
		if (planNames.includes("mapping_id")) {
			await pool.query(
				"update migration_plans p join migration_mapping_profiles m on m.id = p.mapping_id set p.mapping_profile_id = m.id where p.mapping_profile_id is null and p.mapping_id is not null"
			);
		}

		// Migrate inline mapping_json to mapping profiles
		if (planNames.includes("mapping_json")) {
			const [legacyPlans] = await pool.query(
				"select plan_id, name, mapping_json from migration_plans where mapping_profile_id is null and mapping_json is not null"
			);
			for (const plan of legacyPlans) {
				try {
					const mappingJson = typeof plan.mapping_json === 'string'
						? plan.mapping_json
						: JSON.stringify(plan.mapping_json || {});
					const profileName = String(plan.name || `Migrated Profile ${plan.plan_id}`).trim();
					const [result] = await pool.query(
						"insert into migration_mapping_profiles (name, mapping_json) values (?, ?)",
						[profileName, mappingJson]
					);
					await pool.query(
						"update migration_plans set mapping_profile_id = ? where plan_id = ?",
						[result.insertId, plan.plan_id]
					);
				} catch (err) {
					// best-effort migration; continue
				}
			}
		}

		// Add index for mapping_profile_id if missing
		const [planIndexes] = await pool.query(
			"select index_name as name from information_schema.statistics where table_schema = database() and table_name = 'migration_plans'"
		);
		const planIndexNames = planIndexes.map((idx) => String(idx.name).toLowerCase());
		if (!planIndexNames.includes("idx_mapping_profile_id")) {
			try {
				await pool.query("create index idx_mapping_profile_id on migration_plans (mapping_profile_id)");
			} catch (e) {
				// ignore
			}
		}

		// Add FK constraint if missing
		const [planConstraints] = await pool.query(
			"select constraint_name as name from information_schema.table_constraints where table_schema = database() and table_name = 'migration_plans' and constraint_type = 'FOREIGN KEY'"
		);
		const constraintNames = planConstraints.map((c) => String(c.name).toLowerCase());
		if (!constraintNames.includes("fk_plans_mapping_profile")) {
			try {
				await pool.query("alter table migration_plans add constraint fk_plans_mapping_profile foreign key (mapping_profile_id) references migration_mapping_profiles(id) on delete restrict");
			} catch (e) {
				// ignore
			}
		}

		// Enforce NOT NULL if safe
		const [nullRows] = await pool.query(
			"select count(*) as count from migration_plans where mapping_profile_id is null"
		);
		const nullCount = Number(nullRows?.[0]?.count || 0);
		if (mappingProfileColumn && String(mappingProfileColumn.isNullable).toUpperCase() === 'YES' && nullCount === 0) {
			try {
				await pool.query("alter table migration_plans modify column mapping_profile_id int not null");
			} catch (e) {
				// ignore
			}
		}
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
	listUniqueIndexes,
	hasUniqueIndexForColumns,
	createUniqueIndex,
	dropIndex,
	ensureMigrationTables
};
