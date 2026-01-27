const mysql = require('../src/db/mysql');
const runStore = require('../src/migrate/runStore');
const runner = require('../src/migrate/runner');
const { state } = require('../src/config/state');

function safeParse(raw) { if (!raw) return {}; try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return {}; } }

function normalizeMapping(mapping) {
	if (!mapping || !mapping.tables) return mapping;
	const tables = mapping.tables;
	const needsConversion = Object.values(tables).some((config) => { if (!config) return false; if (config.targetTable) return true; const sampleColumn = config.columns ? Object.values(config.columns)[0] : null; return !!sampleColumn?.targetColumn; });
	if (!needsConversion) return mapping;
	const converted = { ...mapping, tables: {} };
	for (const [sourceTable, config] of Object.entries(tables)) {
		const columns = {};
		for (const [srcCol, field] of Object.entries(config?.columns || {})) {
			columns[srcCol] = {
				target: field?.targetColumn || field?.target || srcCol,
				transform: field?.transform || null,
				defaultValue: field?.defaultValue ?? field?.default ?? null,
				lookup: field?.lookup || null,
				omit: field?.omit || false
			};
		}
		converted.tables[sourceTable] = {
			target: config?.targetTable || config?.target || sourceTable,
			columns,
			mode: config?.mode,
			keyStrategy: config?.keyStrategy
		};
	}
	return converted;
}

function normalizePlanSteps(plan) {
	const defaultBatchSize = plan?.config?.batchSize || 1000;
	const defaults = { mode: 'INSERT', keyStrategy: 'preserve', dedupeKeys: [], onDuplicate: 'SKIP', cleanBefore: false, batchSize: defaultBatchSize };
	if (Array.isArray(plan)) return plan.map(entry => {
		if (typeof entry === 'string') return { table: entry, include: true, ...defaults };
		if (entry && typeof entry === 'object') return { include: entry.include !== false, table: entry.table || entry.name || entry.targetTable || entry.target || entry.tableName, mode: entry.mode || defaults.mode, keyStrategy: entry.keyStrategy || defaults.keyStrategy, dedupeKeys: entry.dedupeKeys || defaults.dedupeKeys, onDuplicate: entry.onDuplicate || defaults.onDuplicate, cleanBefore: (typeof entry.cleanBefore === 'boolean') ? entry.cleanBefore : defaults.cleanBefore, batchSize: entry.batchSize || defaults.batchSize };
		return null;
	}).filter(Boolean);
	if (plan?.tables && Array.isArray(plan.tables)) {
		return plan.tables.map(entry => { if (typeof entry === 'string') return { table: entry, include: true, ...defaults }; if (entry && typeof entry === 'object') return { include: entry.include !== false, table: entry.table || entry.name || entry.targetTable || entry.target || entry.tableName, mode: entry.mode || defaults.mode, keyStrategy: entry.keyStrategy || defaults.keyStrategy, dedupeKeys: entry.dedupeKeys || defaults.dedupeKeys, onDuplicate: entry.onDuplicate || defaults.onDuplicate, cleanBefore: (typeof entry.cleanBefore === 'boolean') ? entry.cleanBefore : defaults.cleanBefore, batchSize: entry.batchSize || defaults.batchSize }; return null }).filter(Boolean);
	}
	if (plan?.tables && typeof plan.tables === 'object') {
		return Object.entries(plan.tables).map(([tableName, config]) => {
			let resolvedTable = config?.target || config?.targetTable;
			if (!resolvedTable && plan?.mapping && plan.mapping.tables?.[tableName]) {
				resolvedTable = plan.mapping.tables[tableName].target || plan.mapping.tables[tableName].targetTable;
			}
			resolvedTable = resolvedTable || tableName;
			return { table: resolvedTable, include: config?.include !== false, mode: config?.mode || defaults.mode, keyStrategy: config?.keyStrategy || defaults.keyStrategy, dedupeKeys: config?.dedupeKeys || defaults.dedupeKeys, onDuplicate: config?.onDuplicate || defaults.onDuplicate, cleanBefore: (typeof config?.cleanBefore === 'boolean') ? config.cleanBefore : defaults.cleanBefore, batchSize: config?.batchSize || defaults.batchSize };
		});
	}
	return [];
}

(async () => {
	const targetRunId = process.argv[2] || '186';
	const pool = await mysql.connectToSchema(state.mysql, 'pwa_service');
	try {
		await mysql.ensureMigrationTables(pool);
		const runData = await runStore.getRun(pool, targetRunId);
		let plan = null;
		let mapping = null;
		if (runData && runData.plan_id) {
			const planRow = await runStore.getPlan(pool, runData.plan_id);
			plan = safeParse(planRow?.plan_json || planRow?.mapping_json || {});
		}
		if (!plan) {
			// try legacy table
			const [legacyRows] = await pool.query('select plan_json, mapping_profile_id from migration_runs_legacy where started_at between DATE_SUB(?, INTERVAL 1 MINUTE) and DATE_ADD(?, INTERVAL 1 MINUTE) order by created_at desc limit 1', [runData.started_at, runData.started_at]);
			const legacy = legacyRows && legacyRows[0];
			if (legacy) {
				plan = safeParse(legacy.plan_json || {});
			}
		}
		// load mapping profile
		if (runData && runData.plan_id) {
			try {
				const planRow = await runStore.getPlan(pool, runData.plan_id);
				const mappingProfileId = planRow?.mapping_profile_id || null;
				if (mappingProfileId) {
					const profile = await runStore.getMappingProfile(pool, mappingProfileId);
					mapping = safeParse(profile?.mapping_json || {});
				}
			} catch (e) { }
		}
		if (!mapping) {
			// try legacy mapping from migration_runs_legacy
			const [legacyRows2] = await pool.query('select mapping_profile_id, plan_json from migration_runs_legacy where started_at between DATE_SUB(?, INTERVAL 1 MINUTE) and DATE_ADD(?, INTERVAL 1 MINUTE) order by created_at desc limit 1', [runData.started_at, runData.started_at]);
			const legacy2 = legacyRows2 && legacyRows2[0];
			if (legacy2 && legacy2.mapping_profile_id) {
				const profile = await runStore.getMappingProfile(pool, legacy2.mapping_profile_id);
				mapping = safeParse(profile?.mapping_json || {});
			}
		}

		if (!plan) {
			console.error('Plan not found for run', targetRunId);
			process.exit(1);
		}
		if (!mapping) {
			console.error('Mapping not found for run', targetRunId);
			process.exit(1);
		}

		const normalizedMapping = normalizeMapping(mapping);
		const normalizedPlan = normalizePlanSteps(plan);

		// attach planId/profileId for runner
		normalizedMapping.planId = runData.plan_id || null;
		normalizedMapping.profileId = normalizedMapping.profileId || null;

		console.log('Starting dry-run for run', targetRunId);
		const { startMigration } = runner;
		const result = await startMigration({ firebirdConfig: state.firebird, mysqlConfig: state.mysql, schemaName: 'pwa_service', plan: normalizedPlan, mapping: normalizedMapping, dryRun: true, batchSize: 1000, fkChecks: true });
		console.log('Dry-run started, new run id:', result.runId);
		await pool.end();
	} catch (e) { console.error('Error', e.message); await pool.end(); process.exit(1); }
})();
