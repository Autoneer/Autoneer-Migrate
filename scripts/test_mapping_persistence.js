const assert = require('assert');
const mappingPersistence = require('../src/migrate/mappingPersistence');

// In-memory fake pool to simulate MySQL queries for migration_run_mappings
class FakePool {
	constructor() {
		this.rows = [];
	}

	async query(sql, params) {
		const s = (sql || '').toString();
		console.log('[FakePool] query SQL:', s.replace(/\s+/g, ' ').slice(0, 160));

		// INSERT into migration_run_mappings
		if (s.toLowerCase().includes('insert into migration_run_mappings')) {
			// params: [runId, planId, mappingProfileId, tableName, sourceTable, targetTable, mappingJson, timestamp]
			const [runId, planId, mappingProfileId, tableName, sourceTable, targetTable, mappingJson, timestamp] = params;
			// Upsert semantics: replace any existing row for run+table
			const idx = this.rows.findIndex(r => r.run_id === runId && r.table_name === tableName);
			const row = {
				id: this.rows.length + 1,
				run_id: runId,
				plan_id: planId,
				mapping_profile_id: mappingProfileId,
				table_name: tableName,
				source_table: sourceTable,
				target_table: targetTable,
				mapping_json: mappingJson,
				created_at: timestamp
			};
			if (idx >= 0) this.rows[idx] = row; else this.rows.push(row);
			return [{ affectedRows: 1 }];
		}

		// COUNT(*) queries (check first, before generic SELECT)
		if (s.toLowerCase().includes('select count(*)') && s.toLowerCase().includes('from migration_run_mappings')) {
			const runId = params[0];
			const count = this.rows.filter(r => r.run_id === runId).length;
			console.log('[FakePool] COUNT for run', runId, '=>', count);
			return [[{ count }]];
		}

		// SELECT for loadRunMappings (return saved rows)
		if (s.toLowerCase().includes('from migration_run_mappings') && s.toLowerCase().includes('where run_id =')) {
			const runId = params[0];
			const matched = this.rows.filter(r => r.run_id === runId).map(r => ({
				table_name: r.table_name,
				source_table: r.source_table,
				target_table: r.target_table,
				mapping_json: r.mapping_json,
				created_at: r.created_at
			}));
			return [matched];
		}

		// Fallback
		return [[]];
	}

	async end() { }
}

(async function testMappingPersistence() {
	const pool = new FakePool();

	const mapping = {
		tables: {
			SRC1: {
				sourceTable: 'SRC1',
				targetTable: 'TGT1',
				columns: [],
				keyStrategy: 'preserve'
			}
		}
	};

	const runId = 42;
	const planId = 7;
	const mappingProfileId = 'mp-123';
	const includedTables = ['TGT1'];

	const saved = await mappingPersistence.saveRunMappings(pool, { runId, planId, mappingProfileId, mapping, includedTables });
	assert.strictEqual(saved, 1, 'Expected one mapping saved');

	const has = await mappingPersistence.hasRunMappings(pool, runId);
	assert.strictEqual(has, true, 'Expected hasRunMappings to be true');

	const count = await mappingPersistence.getRunMappingCount(pool, runId);
	assert.strictEqual(count, 1, 'Expected getRunMappingCount to return 1');

	const loaded = await mappingPersistence.loadRunMappings(pool, runId);
	assert.ok(loaded && loaded.tables, 'Expected loadRunMappings to return mapping object');
	const keys = Object.keys(loaded.tables || {});
	assert.strictEqual(keys.length, 1, 'Expected one table mapping loaded');

	// Test autoGenerateMissingMappings: should skip when mappings already exist
	const autoCount = await mappingPersistence.autoGenerateMissingMappings(pool, { runId, mapping, plan: ['TGT1'], planId, mappingProfileId });
	assert.strictEqual(autoCount, 0, 'Expected autoGenerateMissingMappings to skip when mappings exist');

	console.log('Mapping persistence tests passed.');
})();
