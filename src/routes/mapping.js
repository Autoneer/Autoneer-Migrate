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
	const mappingNotice = state.ui?.mappingNotice || null;
	if (state.ui) {
		state.ui.mappingNotice = null;
	}
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
		// Fix: Uppercase all comparisons for case insensitivity
		const upperMapped = mappedSource.toUpperCase();
		const direct = tableMap.get(upperMapped);
		if (direct) return upperMapped;
		const candidates = [];
		if (upperMapped.endsWith("IES")) {
			candidates.push(upperMapped.slice(0, -3) + "Y");
		}
		if (upperMapped.endsWith("S")) {
			candidates.push(upperMapped.slice(0, -1));
		}
		for (const candidate of candidates) {
			if (tableMap.get(candidate)) return candidate;
		}
		return upperMapped;
	};

	let firebirdSchema = new Map();
	try {
		firebirdSchema = loadFirebirdSchemaFromFile();
	} catch (err) {
		firebirdSchema = new Map();
	}

	const mappingTablesAll = Object.entries(state.mapping?.tables || {})
		.sort(([a], [b]) => a.localeCompare(b));
	const hasPlanSelection = (state.plan || []).some((p) => p.include);
	const mappingTablesIncluded = (hasPlanSelection
		? mappingTablesAll.filter(([, def]) => {
			const planTable = state.plan?.find((p) => p.include && p.table.toLowerCase() === def.target.toLowerCase());
			return !!planTable;
		})
		: mappingTablesAll
	).sort(([, a], [, b]) => String(a.target || "").localeCompare(String(b.target || "")));

	const mismatchRows = [];
	const defaultWarnings = []; // Track price fields with default:0

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
		// Fix: Ensure sourceColumns are uppercase for case-insensitive comparison
		sourceColumns = sourceColumns.map(c => c.toUpperCase()).slice().sort((a, b) => a.localeCompare(b));
		const mappingColumns = Object.keys(def.columns || {}).map((c) => c.toUpperCase());
		const missing = mappingColumns.filter((c) => !sourceColumns.includes(c)).sort((a, b) => a.localeCompare(b));
		missing.forEach((missingCol) => {
			// Fix: Check both uppercase and original key
			const rule = def.columns[missingCol] || def.columns[missingCol.toLowerCase()] || {};
			mismatchRows.push({
				mappingKey: sourceTable,
				sourceTable: resolvedSourceTable,
				sourceColumn: missingCol,
				targetColumn: rule.target || "",
				availableSourceColumns: sourceColumns
			});
		});

		// Scan for default:0 in price-related numeric fields
		Object.entries(def.columns || {}).forEach(([sourceCol, rule]) => {
			if (Object.prototype.hasOwnProperty.call(rule, 'default') && rule.default === 0) {
				const colLower = sourceCol.toLowerCase();
				if (colLower.includes('price') || colLower.includes('cost') || colLower.includes('amount')) {
					defaultWarnings.push({
						sourceTable: resolvedSourceTable,
						sourceColumn: sourceCol,
						targetColumn: rule.target || "",
						message: `Default value 0 on price-related field may cause data loss`
					});
				}
			}
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

	profiles = profiles.slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));

	const mismatchRowsSorted = mismatchRows
		.slice()
		.sort((a, b) => {
			const tableCompare = a.sourceTable.localeCompare(b.sourceTable);
			if (tableCompare !== 0) return tableCompare;
			return a.sourceColumn.localeCompare(b.sourceColumn);
		});

	res.render("mapping", {
		mappingJson: JSON.stringify(state.mapping, null, 2),
		mappingNotice,
		profiles,
		defaultMappingProfileId: state.settings.defaultMappingProfileId,
		activeMappingProfileId: state.mapping?.profileId || null,
		activeMappingProfileName: state.mapping?.profileName || "",
		mappingTables: mappingTablesIncluded.map(([source, def]) => ({
			source,
			target: def.target,
			columns: Object.entries(def.columns || {})
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([srcCol, rule]) => ({
					source: srcCol,
					target: rule.target,
					transform: rule.transform || "",
					defaultValue: Object.prototype.hasOwnProperty.call(rule, "default") ? rule.default : "",
					lookupTable: rule.lookup ? rule.lookup.table : ""
				}))
		})),
		mismatchRows: mismatchRowsSorted.map((row) => ({
			...row,
			availableSourceColumns: (row.availableSourceColumns || []).slice().sort((a, b) => a.localeCompare(b))
		})),
		defaultWarnings: defaultWarnings.slice().sort((a, b) => {
			const tableCompare = a.sourceTable.localeCompare(b.sourceTable);
			if (tableCompare !== 0) return tableCompare;
			return a.sourceColumn.localeCompare(b.sourceColumn);
		}),
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

router.post("/mapping/resolve", async (req, res) => {
	try {
		const mapping = state.mapping || { tables: {} };
		const entries = Object.entries(req.body).filter(([key]) => key.startsWith("resolve__"));
		let appliedCount = 0;
		const priceWarnings = []; // Track price column operations

		entries.forEach(([key, value]) => {
			if (!value) return;
			const [, sourceTable, sourceColumn] = key.split("__");
			const tableDef = mapping.tables?.[sourceTable];
			if (!tableDef || !tableDef.columns) return;

			// Fix: Use toUpperCase() for case-insensitive key lookup
			const columnKey = Object.keys(tableDef.columns).find(k => k.toUpperCase() === sourceColumn.toUpperCase());
			if (!columnKey) return;

			const rule = tableDef.columns[columnKey];
			if (!rule) return;

			// Check if this is a price-related column
			const isPrice = sourceColumn.toLowerCase().includes('price') ||
				sourceColumn.toLowerCase().includes('cost') ||
				sourceColumn.toLowerCase().includes('amount');

			delete tableDef.columns[columnKey];

			if (value === "__omit__") {
				if (isPrice) {
					console.warn(`Omitting price-related column: ${sourceColumn} in ${sourceTable}`);
					priceWarnings.push(`Omitted price column: ${sourceTable}.${sourceColumn}`);
				}
				appliedCount += 1;
				return;
			}

			if (isPrice && value !== sourceColumn) {
				console.warn(`Renaming price-related column: ${sourceColumn} -> ${value} in ${sourceTable}`);
				priceWarnings.push(`Renamed price column: ${sourceTable}.${sourceColumn} -> ${value}`);
			}

			// Fix: Normalize the new key to uppercase
			tableDef.columns[value.toUpperCase()] = rule;
			appliedCount += 1;
		});
		state.mapping = mapping;

		if (!state.ui) {
			state.ui = {};
		}

		const profileId = mapping.profileId;
		const profileName = mapping.profileName || "";
		let noticeMessage = `Applied ${appliedCount} fixes successfully.`;
		let noticeDetails = "";
		if (priceWarnings.length > 0) {
			noticeDetails = `Price column warnings: ${priceWarnings.join('; ')}. `;
		}

		if (profileId) {
			const profileLabel = profileName || `#${profileId}`;
			noticeDetails += `Profile: ${profileLabel}.`;
			try {
				const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
				try {
					await mysql.ensureMigrationTables(pool);
					await runStore.updateMappingProfile(pool, profileId, {
						name: profileName || profileLabel,
						mappingJson: JSON.stringify(mapping)
					});
				} finally {
					await pool.end();
				}
				noticeDetails = `Profile: ${profileLabel}. Saved to profile.`;
			} catch (err) {
				noticeDetails = `Profile: ${profileLabel}. Fixes applied, but could not save to profile (reason: ${err.message}).`;
			}
		} else {
			noticeDetails = "Profile: Not saved yet. Save a profile name to keep these changes.";
		}

		state.ui.mappingNotice = {
			type: "success",
			message: noticeMessage,
			details: noticeDetails
		};
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
