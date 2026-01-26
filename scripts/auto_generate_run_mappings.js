#!/usr/bin/env node
const mysql = require('../src/db/mysql');
const mappingPersistence = require('../src/migrate/mappingPersistence');
const runStore = require('../src/migrate/runStore');
const { state } = require('../src/config/state');

async function main() {
	console.log('[auto-generate-mappings] Starting backfill of missing run mappings...');
	const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
	try {
		await mysql.ensureMigrationTables(pool);

		const runs = await mappingPersistence.findRunsWithoutMappings(pool, 200);
		console.log(`[auto-generate-mappings] Found ${runs.length} runs without mappings`);

		let generated = 0;
		for (const r of runs) {
			try {
				// Try to find legacy entry for this run by started_at
				const startedAt = r.started_at;
				const [legacyRows] = await pool.query(
					'SELECT * FROM migration_runs_legacy WHERE started_at BETWEEN DATE_SUB(?, INTERVAL 5 MINUTE) AND DATE_ADD(?, INTERVAL 5 MINUTE) ORDER BY created_at DESC LIMIT 1',
					[startedAt, startedAt]
				);
				const legacy = legacyRows[0];
				if (!legacy) {
					console.warn(`[auto-generate-mappings] No legacy row found for run ${r.run_id}, skipping`);
					continue;
				}

				let mapping = null;
				let plan = null;

				if (legacy.mapping_profile_id) {
					const profile = await runStore.getMappingProfile(pool, legacy.mapping_profile_id);
					if (profile && profile.mapping_json) {
						try {
							mapping = JSON.parse(profile.mapping_json);
						} catch (e) {
							console.warn(`[auto-generate-mappings] Invalid mapping JSON for profile ${legacy.mapping_profile_id}, skipping run ${r.run_id}`);
							continue;
						}
					}
				}

				if (!mapping && legacy.plan_json) {
					// If mapping not available, we cannot reliably auto-generate; skip
					console.warn(`[auto-generate-mappings] No mapping profile for run ${r.run_id} and plan JSON present but mapping missing; skipping`);
					continue;
				}

				try {
					plan = legacy.plan_json ? JSON.parse(legacy.plan_json) : null;
				} catch (e) {
					console.warn(`[auto-generate-mappings] Invalid plan_json for run ${r.run_id}, skipping`);
					continue;
				}

				const count = await mappingPersistence.autoGenerateMissingMappings(pool, {
					runId: r.run_id,
					mapping,
					plan,
					planId: r.plan_id || null,
					mappingProfileId: legacy.mapping_profile_id || null
				});

				if (count > 0) {
					generated += count;
					console.log(`[auto-generate-mappings] Generated ${count} mappings for run ${r.run_id}`);
				}
			} catch (err) {
				console.error('[auto-generate-mappings] Error processing run', r.run_id, err.message);
			}
		}

		console.log(`[auto-generate-mappings] Complete. Total mappings generated: ${generated}`);
	} finally {
		await pool.end();
	}
}

main().catch(err => {
	console.error('[auto-generate-mappings] Fatal error:', err.message || err);
	process.exit(1);
});
