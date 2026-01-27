const express = require('express');
const router = express.Router();
const mysql = require('../../db/mysql');
const { state } = require('../../config/state');
const runStore = require('../../migrate/runStore');

// GET /api/presets - list active presets
router.get('/presets', async (req, res) => {
	try {
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);
		const presets = await runStore.listPresets(pool);
		await pool.end();
		res.json({ success: true, count: presets.length, presets });
	} catch (err) {
		res.status(500).json({ success: false, error: err.message });
	}
});

// GET /api/presets/:id - full preset
router.get('/presets/:id', async (req, res) => {
	try {
		const { id } = req.params;
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);
		const preset = await runStore.getPreset(pool, id);
		await pool.end();
		if (!preset) return res.status(404).json({ success: false, error: 'Not found' });
		preset.definition_json = typeof preset.definition_json === 'string' ? JSON.parse(preset.definition_json) : preset.definition_json;
		res.json({ success: true, preset });
	} catch (err) {
		res.status(500).json({ success: false, error: err.message });
	}
});

// POST /api/presets - create (admin)
router.post('/presets', async (req, res) => {
	try {
		const { code, name, description, definition_json, is_active, is_system } = req.body;
		if (!code || !name || !definition_json) return res.status(400).json({ success: false, message: 'code, name and definition_json required' });

		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);
		const id = await runStore.upsertPreset(pool, { code, name, description, definitionJson: definition_json, isSystem: is_system ? 1 : 0, isActive: is_active ? 1 : 0 });
		await pool.end();
		res.status(201).json({ success: true, presetId: id });
	} catch (err) {
		res.status(500).json({ success: false, error: err.message });
	}
});

// PUT /api/presets/:id - update (admin)
router.put('/presets/:id', async (req, res) => {
	try {
		const { id } = req.params;
		const { name, description, definition_json, is_active } = req.body;
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);
		const preset = await runStore.getPreset(pool, id);
		if (!preset) {
			await pool.end();
			return res.status(404).json({ success: false, error: 'Preset not found' });
		}
		// If system preset, prevent changing code; code not editable here anyway
		await runStore.updatePreset(pool, id, { name: name || preset.name, description: description || preset.description, definitionJson: definition_json || (preset.definition_json ? JSON.parse(preset.definition_json) : {}), isActive: typeof is_active === 'undefined' ? preset.is_active : is_active });
		await pool.end();
		res.json({ success: true });
	} catch (err) {
		res.status(500).json({ success: false, error: err.message });
	}
});

// DELETE /api/presets/:id - soft delete
router.delete('/presets/:id', async (req, res) => {
	try {
		const { id } = req.params;
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);
		await runStore.deactivatePreset(pool, id);
		await pool.end();
		res.json({ success: true });
	} catch (err) {
		res.status(500).json({ success: false, error: err.message });
	}
});

module.exports = router;
