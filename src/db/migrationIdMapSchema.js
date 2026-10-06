// Keep the runtime schema in sync with idMapTracker. Older installations used
// source_id/target_id; rename those columns so existing mappings survive.
async function ensureMigrationIdMapSchema(pool) {
	const [columns] = await pool.query(
		"select column_name as name from information_schema.columns where table_schema = database() and table_name = 'migration_id_map'"
	);
	const names = new Set(columns.map(column => column.name.toLowerCase()));
	const changes = [];
	for (const [legacy, current] of [['source_id', 'source_pk'], ['target_id', 'target_pk']]) {
		if (names.has(legacy) && names.has(current)) {
			throw new Error(`migration_id_map has both ${legacy} and ${current}; reconcile these columns before migrating.`);
		}
		if (!names.has(current)) {
			if (!names.has(legacy)) throw new Error(`migration_id_map is missing ${current}; repair its schema before migrating.`);
			changes.push(`CHANGE COLUMN ${legacy} ${current} varchar(255) NOT NULL`);
		}
	}
	// Legacy records have no operation/time audit data. Leave those values NULL
	// rather than inventing a historical operation or timestamp.
	if (!names.has('operation')) changes.push("ADD COLUMN operation enum('INSERT','SKIP','UPDATE') NULL");
	if (!names.has('created_at')) changes.push('ADD COLUMN created_at datetime NULL');

	const [indexes] = await pool.query(
		"select index_name as name, non_unique as nonUnique, seq_in_index as seq, column_name as columnName, sub_part as prefixLength from information_schema.statistics where table_schema = database() and table_name = 'migration_id_map' order by index_name, seq_in_index"
	);
	const uniqueKeys = new Map();
	for (const index of indexes) {
		if (Number(index.nonUnique) !== 0) continue;
		if (!uniqueKeys.has(index.name)) uniqueKeys.set(index.name, []);
		uniqueKeys.get(index.name).push(index);
	}
	const sourceColumn = names.has('source_pk') ? 'source_pk' : 'source_id';
	const hasKey = [...uniqueKeys.values()].some(parts =>
		parts.length === 3 && parts.every(part => !part.prefixLength || Number(part.prefixLength) === 255)
		&& ['run_id', 'table_name', sourceColumn].every(column =>
			parts.some(part => part.columnName.toLowerCase() === column))
	);
	if (!hasKey) {
		// Do not silently delete old mappings to make the unique index fit.
		const [duplicates] = await pool.query(
			`select run_id, table_name, ${sourceColumn}, count(*) as count from migration_id_map group by run_id, table_name, ${sourceColumn} having count(*) > 1 limit 1`
		);
		if (duplicates.length) throw new Error('migration_id_map contains duplicate run/table/source mappings; reconcile them before migrating. No mappings were deleted.');
		if (indexes.some(index => index.name.toLowerCase() === 'uk_run_table_source')) {
			throw new Error('migration_id_map.uk_run_table_source has an unexpected definition; repair it before migrating.');
		}
		changes.push('ADD UNIQUE KEY uk_run_table_source (run_id, table_name, source_pk)');
	}
	if (changes.length) await pool.query(`ALTER TABLE migration_id_map ${changes.join(', ')}`);
}

module.exports = { ensureMigrationIdMapSchema };
