const express = require("express");
const { state } = require("../config/state");
const mysql = require("../db/mysql");
const runStore = require("../migrate/runStore");
const migrationPlan = require("../migrate/migrationPlan");
const firebird = require("../db/firebird");
const { loadFirebirdSchemaFromFile } = require("../config/firebirdSchema");
const { updateSettings } = require("../config/settings");

const router = express.Router();

router.get("/mapping", async (req, res) => {
	let defaultProfile = null;
	if (!state.mapping) {
		try {
			const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
			await mysql.ensureMigrationTables(pool);
			if (state.settings.defaultMappingProfileId) {
				defaultProfile = await runStore.getMappingProfile(pool, state.settings.defaultMappingProfileId);
			}
			await pool.end();
		} catch (err) {
			defaultProfile = null;
		}

		if (defaultProfile?.mapping_json) {
			state.mapping = JSON.parse(defaultProfile.mapping_json);
			state.mapping.profileId = defaultProfile.id;
			state.mapping.profileName = defaultProfile.name;
		} else {
			state.mapping = migrationPlan.loadDefaultMapping();
		}
	}

	const resolveSourceTable = (mappedSource, tableMap) => {
		if (!mappedSource) return null;
		const direct = tableMap.get(mappedSource.toUpperCase());
		if (direct) return mappedSource.toUpperCase();
		const candidates = [];
		if (mappedSource.toUpperCase().endsWith("IES")) {
			candidates.push(mappedSource.slice(0, -3) + "Y");
		}
		if (mappedSource.toUpperCase().endsWith("S")) {
			candidates.push(mappedSource.slice(0, -1));
		}
		for (const candidate of candidates) {
			if (tableMap.get(candidate.toUpperCase())) return candidate.toUpperCase();
		}
		return mappedSource.toUpperCase();
	};

	let firebirdSchema = new Map();
	try {
		firebirdSchema = loadFirebirdSchemaFromFile();
	} catch (err) {
		firebirdSchema = new Map();
	}

	const mappingTablesAll = Object.entries(state.mapping?.tables || {});
	const hasPlanSelection = (state.plan || []).some((p) => p.include);
	const mappingTablesIncluded = hasPlanSelection
		? mappingTablesAll.filter(([, def]) => {
			const planTable = state.plan?.find((p) => p.include && p.table.toLowerCase() === def.target.toLowerCase());
			return !!planTable;
		})
		: mappingTablesAll;

	const mismatchRows = [];
	for (const [sourceTable, def] of mappingTablesIncluded) {
		const resolvedSourceTable = resolveSourceTable(sourceTable, firebirdSchema);
		let sourceColumns = firebirdSchema.get(resolvedSourceTable) || [];
		if (!sourceColumns.length) {
			try {
				sourceColumns = (await firebird.listColumns(state.firebird, resolvedSourceTable)).map((c) => c.toUpperCase());
			} catch (err) {
				sourceColumns = sourceColumns || [];
			}
		}
		const mappingColumns = Object.keys(def.columns || {}).map((c) => c.toUpperCase());
		const missing = mappingColumns.filter((c) => !sourceColumns.includes(c));
		missing.forEach((missingCol) => {
			const rule = def.columns[missingCol] || def.columns[missingCol.toLowerCase()] || {};
			mismatchRows.push({
				mappingKey: sourceTable,
				sourceTable: resolvedSourceTable,
				sourceColumn: missingCol,
				targetColumn: rule.target || "",
				availableSourceColumns: sourceColumns
			});
		});
	}

	let profiles = [];
	try {
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);
		profiles = await runStore.listMappingProfiles(pool);
		await pool.end();
	} catch (err) {
		profiles = [];
	}

	res.render("mapping", {
		mappingJson: JSON.stringify(state.mapping, null, 2),
		profiles,
		defaultMappingProfileId: state.settings.defaultMappingProfileId,
		activeMappingProfileId: state.mapping?.profileId || null,
		activeMappingProfileName: state.mapping?.profileName || "",
		mappingTables: mappingTablesIncluded.map(([source, def]) => ({
			source,
			target: def.target,
			columns: Object.entries(def.columns || {}).map(([srcCol, rule]) => ({
				source: srcCol,
				target: rule.target,
				transform: rule.transform || "",
				defaultValue: Object.prototype.hasOwnProperty.call(rule, "default") ? rule.default : "",
				lookupTable: rule.lookup ? rule.lookup.table : ""
			}))
		})),
		mismatchRows,
		currentStep: "mapping"
	});
});

router.get("/mapping/profile/:id", async (req, res) => {
	const profileId = Number(req.params.id);
	if (!profileId) {
		res.redirect("/mapping");
		return;
	}
	try {
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);
		const profile = await runStore.getMappingProfile(pool, profileId);
		await pool.end();
		if (profile?.mapping_json) {
			state.mapping = JSON.parse(profile.mapping_json);
			state.mapping.profileId = profile.id;
			state.mapping.profileName = profile.name;
		}
		res.redirect("/mapping");
	} catch (err) {
		res.render("mapping", {
			mappingJson: JSON.stringify(state.mapping || {}, null, 2),
			error: `Failed to load mapping profile: ${err.message}`,
			profiles: [],
			mappingTables: [],
			mismatchRows: [],
			currentStep: "mapping"
		});
	}
});

router.post("/mapping/profile/:id/default", async (req, res) => {
	const profileId = Number(req.params.id);
	if (!profileId) {
		res.redirect("/mapping");
		return;
	}
	state.settings.defaultMappingProfileId = profileId;
	updateSettings({ defaultMappingProfileId: profileId });
	res.redirect("/mapping");
});

router.post("/mapping/profile/:id/delete", async (req, res) => {
	const profileId = Number(req.params.id);
	if (!profileId) {
		res.redirect("/mapping");
		return;
	}
	try {
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);
		await runStore.deleteMappingProfile(pool, profileId);
		await pool.end();
		if (state.mapping?.profileId === profileId) {
			state.mapping.profileId = null;
			state.mapping.profileName = "";
		}
		if (state.settings.defaultMappingProfileId === profileId) {
			state.settings.defaultMappingProfileId = null;
			updateSettings({ defaultMappingProfileId: null });
		}
		res.redirect("/mapping");
	} catch (err) {
		res.render("mapping", {
			mappingJson: JSON.stringify(state.mapping || {}, null, 2),
			error: `Failed to delete mapping profile: ${err.message}`,
			profiles: [],
			mappingTables: [],
			mismatchRows: [],
			currentStep: "mapping"
		});
	}
});

router.post("/mapping/resolve", (req, res) => {
	try {
		const mapping = state.mapping || { tables: {} };
		const entries = Object.entries(req.body).filter(([key]) => key.startsWith("resolve__"));
		entries.forEach(([key, value]) => {
			const [, sourceTable, sourceColumn] = key.split("__");
			const tableDef = mapping.tables?.[sourceTable];
			if (!tableDef || !tableDef.columns) return;
			const rule = tableDef.columns[sourceColumn] || tableDef.columns[sourceColumn.toLowerCase()];
			if (!rule) return;

			delete tableDef.columns[sourceColumn];
			delete tableDef.columns[sourceColumn.toLowerCase()];

			if (value && value !== "__omit__") {
				tableDef.columns[value] = rule;
			}
		});
		state.mapping = mapping;
		res.redirect("/mapping");
	} catch (err) {
		res.render("mapping", {
			mappingJson: req.body.mapping_json || JSON.stringify(state.mapping || {}, null, 2),
			error: `Failed to apply mapping fixes: ${err.message}`,
			profiles: [],
			mappingTables: [],
			mismatchRows: [],
			currentStep: "mapping"
		});
	}
});

router.post("/mapping/save", async (req, res) => {
	try {
		const mapping = JSON.parse(req.body.mapping_json);
		state.mapping = mapping;

		const profileName = req.body.profile_name?.trim();
		const profileId = Number(req.body.profile_id || 0);
		const saveAsNew = req.body.save_as_new === "on";
		if (profileName) {
			const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
			await mysql.ensureMigrationTables(pool);
			let savedId = profileId;
			if (profileId && !saveAsNew) {
				await runStore.updateMappingProfile(pool, profileId, {
					name: profileName,
					mappingJson: JSON.stringify(mapping)
				});
			} else {
				savedId = await runStore.saveMappingProfile(pool, {
					name: profileName,
					mappingJson: JSON.stringify(mapping)
				});
			}
			await pool.end();
			state.mapping.profileId = savedId;
			state.mapping.profileName = profileName;
			state.settings.defaultMappingProfileId = savedId;
			updateSettings({ defaultMappingProfileId: savedId });
		}

		res.redirect("/run");
	} catch (err) {
		res.render("mapping", {
			mappingJson: req.body.mapping_json,
			error: `Invalid mapping JSON: ${err.message}`,
			profiles: [],
			mappingTables: [],
			currentStep: "mapping"
		});
	}
});

router.get("/mapping/export", (req, res) => {
	const json = JSON.stringify(state.mapping || {}, null, 2);
	res.setHeader("Content-Type", "application/json");
	res.setHeader("Content-Disposition", "attachment; filename=autoneer-mapping.json");
	res.send(json);
});

router.post("/mapping/import", (req, res) => {
	try {
		const mapping = JSON.parse(req.body.mapping_json);
		state.mapping = mapping;
		res.redirect("/mapping");
	} catch (err) {
		res.render("mapping", {
			mappingJson: req.body.mapping_json,
			error: `Invalid mapping JSON: ${err.message}`,
			profiles: [],
			mappingTables: [],
			currentStep: "mapping"
		});
	}
});

module.exports = router;
