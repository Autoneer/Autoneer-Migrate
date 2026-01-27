const express = require('express');
const router = express.Router();
const mysql = require('../../db/mysql');
const { state } = require('../../config/state');
const runStore = require('../../migrate/runStore');
const { buildMappingFromPreset } = require('../../services/presetsService');
const Schema = require('../../migrate/models/Schema');

// GET /api/profiles
router.get('/profiles', async (req, res) => {
	try {
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);
		const profiles = await runStore.listProfiles(pool);
		await pool.end();
		res.json({ success: true, count: profiles.length, profiles });
	} catch (err) {
		res.status(500).json({ success: false, error: err.message });
	}
});

// GET /api/profiles/:id
router.get('/profiles/:id', async (req, res) => {
	try {
		const { id } = req.params;
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);
		const profile = await runStore.getProfile(pool, id);
		await pool.end();
		if (!profile) return res.status(404).json({ success: false, error: 'Not found' });
		profile.mapping_json = typeof profile.mapping_json === 'string' ? JSON.parse(profile.mapping_json) : profile.mapping_json;
		res.json({ success: true, profile });
	} catch (err) {
		res.status(500).json({ success: false, error: err.message });
	}
});

// POST /api/profiles - create from mapping_json
router.post('/profiles', async (req, res) => {
	try {
		const { name, description, mapping_json } = req.body;
		if (!name || !mapping_json) return res.status(400).json({ success: false, message: 'name and mapping_json required' });
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);
		const id = await runStore.saveProfile(pool, { name, description, mappingJson: mapping_json });
		await pool.end();
		res.status(201).json({ success: true, profileId: id });
	} catch (err) {
		res.status(500).json({ success: false, error: err.message });
	}
});

// POST /api/profiles/from-preset/:presetId
router.post('/profiles/from-preset/:presetId', async (req, res) => {
	try {
		const { presetId } = req.params;
		const { name, description, schemaSnapshot } = req.body;
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);
		const preset = await runStore.getPreset(pool, presetId);
		if (!preset) {
			await pool.end();
			return res.status(404).json({ success: false, error: 'Preset not found' });
		}
		const definition = typeof preset.definition_json === 'string' ? JSON.parse(preset.definition_json) : preset.definition_json;

		let schema;
		if (schemaSnapshot && schemaSnapshot.firebird && schemaSnapshot.mysql) {
			schema = schemaSnapshot;
		} else {
			// discover current schema
			const s = new Schema();
			await s.discover(state.firebird, state.mysql, state.schemaName);
			schema = { firebird: s.firebird, mysql: s.mysql };
		}

		const mapping = await buildMappingFromPreset(definition, schema);
		const profileName = name || `${definition.name || definition.code} Profile`;
		const profileId = await runStore.saveProfile(pool, { name: profileName, description: description || null, mappingJson: mapping, sourceSig: null, targetSig: null, createdFromPresetCode: definition.code });
		await pool.end();
		res.status(201).json({ success: true, profileId, mapping });
	} catch (err) {
		res.status(500).json({ success: false, error: err.message });
	}
});

// PUT /api/profiles/:id
router.put('/profiles/:id', async (req, res) => {
	try {
		const { id } = req.params;
		const { name, description, mapping_json } = req.body;
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);
		const profile = await runStore.getProfile(pool, id);
		if (!profile) {
			await pool.end();
			return res.status(404).json({ success: false, error: 'Profile not found' });
		}
		await runStore.updateProfile(pool, id, { name: name || profile.name, description: description || profile.description, mappingJson: mapping_json || JSON.parse(profile.mapping_json) });
		await pool.end();
		res.json({ success: true });
	} catch (err) {
		res.status(500).json({ success: false, error: err.message });
	}
});

// DELETE /api/profiles/:id
router.delete('/profiles/:id', async (req, res) => {
	try {
		const { id } = req.params;
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);
		await runStore.deleteProfile(pool, id);
		await pool.end();
		res.json({ success: true });
	} catch (err) {
		res.status(500).json({ success: false, error: err.message });
	}
});

module.exports = router;
