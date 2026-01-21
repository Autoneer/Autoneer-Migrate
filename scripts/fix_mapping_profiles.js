#!/usr/bin/env node
/**
 * One-time migration script: normalize and fix saved mapping profiles
 *
 * Usage:
 *   node scripts/fix_mapping_profiles.js
 *
 * The script will:
 * - Connect to the configured MySQL schema
 * - Load all mapping profiles
 * - Normalize each mapping via `Mapping.fromJSON` and `toJSON`
 * - Update any profile whose normalized tables differ from stored JSON
 */

const mysql = require('../src/db/mysql');
const runStore = require('../src/migrate/runStore');
const Mapping = require('../src/migrate/models/Mapping');
const { state } = require('../src/config/state');

async function main() {
	console.log('[fix-mapping-profiles] Starting migration/cleanup...');

	const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
	try {
		await mysql.ensureMigrationTables(pool);

		const profiles = await runStore.listMappingProfiles(pool);
		console.log(`[fix-mapping-profiles] Found ${profiles.length} profiles`);

		let updated = 0;
		let errors = 0;

		for (const p of profiles) {
			try {
				const id = p.id;
				const raw = p.mapping_json || '{}';
				let parsed;
				try {
					parsed = JSON.parse(raw);
				} catch (err) {
					console.error(`[fix-mapping-profiles] Skipping profile ${id} - invalid JSON: ${err.message}`);
					errors++;
					continue;
				}

				const mapping = Mapping.fromJSON(parsed);
				const normalized = mapping.toJSON();

				const origTables = JSON.stringify(parsed.tables || {});
				const newTables = JSON.stringify(normalized.tables || {});

				if (origTables !== newTables) {
					// Update DB
					await runStore.updateMappingProfile(pool, id, {
						name: mapping.name || p.name || `Profile ${id}`,
						mappingJson: JSON.stringify(normalized)
					});
					updated++;
					console.log(`[fix-mapping-profiles] Updated profile ${id} (${p.name || ''})`);
				}
			} catch (err) {
				console.error(`[fix-mapping-profiles] Error processing profile ${p.id}: ${err.message}`);
				errors++;
			}
		}

		console.log(`[fix-mapping-profiles] Complete. Updated=${updated}, Errors=${errors}`);
	} finally {
		await pool.end();
	}
}

main().catch(err => {
	console.error('[fix-mapping-profiles] Fatal error:', err);
	process.exit(1);
});
