const mysql = require('../src/db/mysql');
const { state } = require('../src/config/state');

function extractTableName(entry) {
	if (!entry && entry !== 0) return null;
	if (typeof entry === 'string') return entry;
	if (typeof entry === 'object') {
		const candidates = [
			entry.targetTable,
			entry.target,
			entry.table,
			entry.tableName,
			entry.name,
			entry.value
		];
		for (const c of candidates) {
			if (c && typeof c === 'string') return c;
		}
	}
	return null;
}

(async () => {
	const pool = await mysql.connectToSchema(state.mysql, 'pwa_service');
	try {
		const [rows] = await pool.query("select id, started_at, plan_json from migration_runs_legacy where plan_json is not null");
		console.log('Found', rows.length, 'legacy runs with plan_json');
		let updated = 0;
		for (const r of rows) {
			let pj = r.plan_json;
			if (typeof pj === 'string') {
				try { pj = JSON.parse(pj); } catch (e) { continue; }
			}
			if (!pj) continue;
			let changed = false;
			// Handle array format
			if (Array.isArray(pj)) {
				const newArr = pj.map(entry => {
					if (typeof entry === 'string') return entry;
					const name = extractTableName(entry);
					if (name) { changed = true; return name; }
					return entry; // leave as-is
				});
				if (changed) {
					const sql = "update migration_runs_legacy set plan_json = ? where id = ?";
					await pool.query(sql, [JSON.stringify(newArr), r.id]);
					updated++;
					console.log('Repaired legacy run', r.id, 'array -> normalized');
				}
			}
			else if (pj && typeof pj === 'object') {
				const tables = pj.tables;
				if (Array.isArray(tables)) {
					const newArr = tables.map(entry => {
						if (typeof entry === 'string') return entry;
						const name = extractTableName(entry);
						if (name) { changed = true; return name; }
						return entry;
					});
					if (changed) {
						pj.tables = newArr;
					}
				} else if (tables && typeof tables === 'object') {
					const newObj = {};
					for (const [k, v] of Object.entries(tables)) {
						let key = k;
						// if key looks like [object Object] try to extract
						if (key && key.toLowerCase().includes('[object object]')) {
							if (v && typeof v === 'object') {
								const name = extractTableName(v) || (v.target || v.targetTable);
								if (name) { key = name; changed = true; }
							}
						}
						// if value is object with name fields, preserve config but ensure key is string
						newObj[key] = v;
					}
					if (changed) {
						pj.tables = newObj;
					}
				}
				if (changed) {
					await pool.query('update migration_runs_legacy set plan_json = ? where id = ?', [JSON.stringify(pj), r.id]);
					updated++;
					console.log('Repaired legacy run', r.id, 'object plan normalized');
				}
			}
		}
		console.log('Repair complete. Updated:', updated);
	} catch (e) {
		console.error('Error', e.message);
	} finally {
		await pool.end();
	}
})();
