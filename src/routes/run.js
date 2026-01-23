const express = require("express");
const { state } = require("../config/state");
const { startMigration, requestAbort, getRunState } = require("../migrate/runner");
const mysql = require("../db/mysql");
const runStore = require("../migrate/runStore");
const firebird = require("../db/firebird");
const logger = require("../migrate/logger");
const fs = require("fs");
const { buildCleanTableSelection, validateCleanConfirm } = require("../migrate/validation");

const router = express.Router();

function validateFirebirdConfig() {
	const resolved = firebird.resolveFirebirdConfig(state.firebird, process.env);
	const validationError = firebird.validateFirebirdConfig(resolved);
	if (validationError) {
		return { error: validationError, resolved };
	}
	if (!resolved.password || !String(resolved.password).trim()) {
		return { error: "Firebird password is empty. Provide a password or enable default SYSDBA/masterkey.", resolved };
	}
	return { error: null, resolved };
}

function resolveMappingForTarget(tableName, mapping) {
	const entries = mapping?.tables || {};

	// First, check if tableName is a custom target (e.g., customer_invoice_lines)
	const sourceKey = Object.keys(entries).find(
		(key) => {
			const target = entries[key]?.target || entries[key]?.targetTable;
			return target && target.toLowerCase() === tableName.toLowerCase();
		}
	);
	if (sourceKey) {
		const entry = entries[sourceKey] || {};
		return { sourceTable: sourceKey, ...entry, target: entry.target || entry.targetTable };
	}

	// Second, check if tableName is a source table name (e.g., spares_used)
	// This handles cases where the plan still has the source table name
	if (entries[tableName]) {
		const entry = entries[tableName] || {};
		return { sourceTable: tableName, ...entry, target: entry.target || entry.targetTable };
	}

	return null;
}

async function validatePlanForRun(pool, plan, mapping) {
	const included = (plan || []).filter((step) => step.include);
	const errors = [];
	const warnings = []; // Track potential issues with dedupe keys

	for (const step of included) {
		const tableName = step.table;
		const dedupeKeys = Array.isArray(step.dedupeKeys) ? step.dedupeKeys : [];

		// Warn about dedupe keys causing skipped duplicates
		if (dedupeKeys.length > 0) {
			warnings.push(`Table ${tableName}: Dedupe keys (${dedupeKeys.join(', ')}) may cause skipped duplicates, leading to fewer inserted rows than migrated.`);
		}

		if (step.keyStrategy === "rekey" && step.mode === "UPSERT" && dedupeKeys.length === 0) {
			errors.push(`Table ${tableName}: UPSERT with re-key IDs requires dedupe keys.`);
			continue;
		}

		if (step.mode === "UPSERT" && dedupeKeys.length === 0) {
			const primaryKeys = await mysql.getPrimaryKeys(pool, tableName);
			if (!primaryKeys.length) {
				errors.push(`Table ${tableName}: UPSERT requires a primary key or dedupe keys.`);
			}
		}

		if (step.keyStrategy === "rekey" && dedupeKeys.length === 0) {
			const uniqueIndexes = await mysql.listUniqueIndexes(pool, tableName);
			if (!uniqueIndexes.length) {
				errors.push(`Table ${tableName}: Re-key IDs requires dedupe keys or a unique index on natural keys.`);
			}
		}

		if (step.mode === "INSERT" && dedupeKeys.length === 0) {
			const uniqueIndexes = await mysql.listUniqueIndexes(pool, tableName);
			if (!uniqueIndexes.length) {
				errors.push(`Table ${tableName}: INSERT requires dedupe keys or a unique index to prevent duplicates.`);
			}
		}

		if (dedupeKeys.length) {
			const mappingEntry = resolveMappingForTarget(tableName, mapping);
			if (mappingEntry?.columns) {
				const mappedTargets = new Set(
					Object.values(mappingEntry.columns)
						.map((c) => (c.target || c.targetColumn || '').toLowerCase())
						.filter(Boolean)
				);
				const missingFromMapping = dedupeKeys.filter((key) => !mappedTargets.has(String(key).toLowerCase()));
				if (missingFromMapping.length) {
					errors.push(`Table ${tableName}: Dedupe keys not mapped from source fields: ${missingFromMapping.join(", ")}.`);
				}
			}
			const columns = await mysql.listColumns(pool, tableName);
			const columnSet = new Set(columns.map((c) => c.name.toLowerCase()));
			const missing = dedupeKeys.filter((key) => !columnSet.has(String(key).toLowerCase()));
			if (missing.length) {
				errors.push(`Table ${tableName}: Dedupe keys not found in target table: ${missing.join(", ")}.`);
			}
		}
	}

	return { errors, warnings };
}

router.get("/run", async (req, res) => {
	const runId = req.query.runId || null;
	const ui = { runNotice: state.ui?.runNotice || null };
	// Clear notice after displaying
	if (state.ui) {
		state.ui.runNotice = null;
	}

	let run = null;
	if (runId) {
		try {
			const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
			await mysql.ensureMigrationTables(pool);
			run = await runStore.getRun(pool, runId);
			await pool.end();
		} catch (err) {
			run = null;
		}
	}

	// Build table mapping summary
	const tableMappings = [];
	const includedPlan = (state.plan || []).filter(p => p.include);
	for (const planItem of includedPlan) {
		const planTableName = planItem.table;
		const mappingEntry = resolveMappingForTarget(planTableName, state.mapping);

		// Determine actual source and target tables
		let sourceTable, targetTable;
		if (mappingEntry) {
			sourceTable = mappingEntry.sourceTable;
			targetTable = mappingEntry.target;
		} else {
			// No custom mapping, source and target are the same
			sourceTable = planTableName;
			targetTable = planTableName;
		}

		tableMappings.push({
			sourceTable,
			targetTable,
			mode: planItem.mode,
			keyStrategy: planItem.keyStrategy,
			dedupeKeys: planItem.dedupeKeys || [],
			onDuplicate: planItem.onDuplicate
		});
	}

	res.render("run", {
		plan: (state.plan || []).slice().sort((a, b) => a.table.localeCompare(b.table)),
		tableMappings,
		runId,
		run,
		ui,
		currentStep: "run"
	});
});

router.post("/run/start", async (req, res) => {
	const { error: configError, resolved } = validateFirebirdConfig();
	// console.log("Firebird run config:", firebird.maskFirebirdConfig(resolved || state.firebird));
	if (configError) {
		if (req.accepts(["html", "json"]) === "json") {
			res.status(400).json({ error: configError });
			return;
		}
		res.render("run", {
			plan: (state.plan || []).slice().sort((a, b) => a.table.localeCompare(b.table)),
			runId: null,
			run: null,
			error: configError,
			currentStep: "run"
		});
		return;
	}

	const dryRun = req.body.dry_run === "on";
	const batchSize = Number(req.body.batch_size || 500);
	const fkChecks = req.body.fk_checks === "on";
	const cleanAll = req.body.clean_all === "on";
	const includedTables = (state.plan || []).filter((step) => step.include).map((step) => step.table);
	const requestedTables = includedTables.filter((table) => req.body[`clean_table_${table}`] === "on");
	const cleanTables = buildCleanTableSelection({
		includedTables,
		cleanAll,
		requestedTables
	});
	validateCleanConfirm(req.body.clean_confirm, cleanTables.size);

	try {
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);
		const { errors, warnings } = await validatePlanForRun(pool, state.plan || [], state.mapping || {});

		// Store warnings in state for UI display
		if (!state.ui) {
			state.ui = {};
		}
		if (warnings.length > 0) {
			state.ui.runNotice = {
				type: 'warning',
				message: 'Potential issues detected',
				details: warnings.join('\n')
			};
		} else {
			state.ui.runNotice = null;
		}

		await pool.end();
		if (errors.length) {
			const message = errors.join(" ");
			if (req.accepts(["html", "json"]) === "json") {
				res.status(400).json({ error: message, errors });
				return;
			}
			// Build table mapping summary even on error
			const tableMappings = [];
			const includedPlan = (state.plan || []).filter(p => p.include);
			for (const planItem of includedPlan) {
				const planTableName = planItem.table;
				const mappingEntry = resolveMappingForTarget(planTableName, state.mapping);

				// Determine actual source and target tables
				let sourceTable, targetTable;
				if (mappingEntry) {
					sourceTable = mappingEntry.sourceTable;
					targetTable = mappingEntry.target;
				} else {
					// No custom mapping, source and target are the same
					sourceTable = planTableName;
					targetTable = planTableName;
				}

				tableMappings.push({
					sourceTable,
					targetTable,
					mode: planItem.mode,
					keyStrategy: planItem.keyStrategy,
					dedupeKeys: planItem.dedupeKeys || [],
					onDuplicate: planItem.onDuplicate
				});
			}
			res.render("run", {
				plan: (state.plan || []).slice().sort((a, b) => a.table.localeCompare(b.table)),
				tableMappings,
				runId: null,
				run: null,
				error: message,
				validationErrors: errors,
				showPlanEditor: true,
				currentStep: "run"
			});
			return;
		}
	} catch (err) {
		if (req.accepts(["html", "json"]) === "json") {
			res.status(400).json({ error: err.message });
			return;
		}
		res.render("run", {
			plan: (state.plan || []).slice().sort((a, b) => a.table.localeCompare(b.table)),
			runId: null,
			run: null,
			error: err.message,
			currentStep: "run"
		});
		return;
	}

	const { runId } = await startMigration({
		firebirdConfig: resolved,
		mysqlConfig: state.mysql,
		schemaName: state.schemaName,
		plan: (state.plan || []).map((step) => ({
			...step,
			cleanBefore: cleanTables.has(step.table)
		})),
		mapping: state.mapping || {},
		dryRun,
		batchSize,
		fkChecks
	});

	if (req.accepts(["html", "json"]) === "json") {
		res.json({ runId });
		return;
	}

	res.redirect(`/run?runId=${runId}`);
});

router.post("/run/abort", (req, res) => {
	const runId = req.body?.runId || req.body?.run_id;
	const reason = req.body?.reason || "Migration stopped";
	if (!runId) {
		res.status(400).json({ ok: false, error: "runId is required" });
		return;
	}
	requestAbort(runId, reason);
	res.json({ ok: true });
});

router.get("/migrate/run/:runId/status", async (req, res) => {
	const runId = req.params.runId;
	const runState = getRunState(runId);
	if (runState) {
		res.json({
			runId,
			status: runState.status?.toLowerCase() || "unknown",
			lastEventAt: runState.lastEventAt || null,
			tables: runState.tables || [],
			lastError: runState.tables?.find((t) => t.status === "FAILED")?.lastError || null
		});
		return;
	}

	try {
		const pool = await mysql.connectToSchema(state.mysql, state.schemaName);
		await mysql.ensureMigrationTables(pool);
		const run = await runStore.getRun(pool, runId);
		const tables = await runStore.getRunTables(pool, runId);
		await pool.end();
		const normalizedTables = (tables || []).map((table) => ({
			name: table.table_name,
			label: table.table_name,
			status: String(table.status || "").toUpperCase(),
			migrated: table.rows_migrated || 0,
			inserted: 0,
			updated: 0,
			cleaned: false,
			total: table.rows_source || 0,
			errors: table.rows_error || 0,
			skippedDuplicates: table.rows_skipped_duplicates || 0,
			lastError: table.error_message ? { message: table.error_message } : null,
			mode: table.mode,
			keyStrategy: table.key_strategy
		}));
		res.json({
			runId,
			status: run?.status?.toLowerCase() || "unknown",
			lastEventAt: null,
			tables: normalizedTables,
			lastError: run?.error_message || null
		});
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

router.get("/run/logs/:runId", async (req, res) => {
	const runId = req.params.runId;
	const logPath = logger.getLogFilePath(runId);

	// Fix: Use async fs.promises.access for proper async/await
	try {
		await fs.promises.access(logPath, fs.constants.F_OK);
		res.download(logPath, `${runId}.log`);
	} catch (err) {
		res.status(404).json({ error: "Log not found" });
	}
});

router.post("/run/update-plan", async (req, res) => {
	try {
		// Update plan from the run page
		const updates = {};
		Object.keys(req.body).forEach(key => {
			if (key.startsWith('mode_')) {
				const tableName = key.replace('mode_', '');
				if (!updates[tableName]) updates[tableName] = {};
				updates[tableName].mode = req.body[key];
			} else if (key.startsWith('keyStrategy_')) {
				const tableName = key.replace('keyStrategy_', '');
				if (!updates[tableName]) updates[tableName] = {};
				updates[tableName].keyStrategy = req.body[key];
			} else if (key.startsWith('dedupeKeys_')) {
				const tableName = key.replace('dedupeKeys_', '');
				if (!updates[tableName]) updates[tableName] = {};
				const keys = req.body[key].split(',').map(k => k.trim()).filter(k => k);
				updates[tableName].dedupeKeys = keys;
			} else if (key.startsWith('onDuplicate_')) {
				const tableName = key.replace('onDuplicate_', '');
				if (!updates[tableName]) updates[tableName] = {};
				updates[tableName].onDuplicate = req.body[key];
			}
		});

		// Apply updates to state.plan
		state.plan = (state.plan || []).map(item => {
			if (updates[item.table]) {
				return { ...item, ...updates[item.table] };
			}
			return item;
		});

		if (!state.ui) state.ui = {};
		state.ui.runNotice = {
			type: 'success',
			message: 'Plan updated successfully',
			details: 'Migration options have been updated. You can now run the migration.'
		};

		res.redirect('/run');
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

router.post("/run/save-profile", async (req, res) => {
	res.status(400).json({
		error: "Mapping profiles can only be saved in Step 2 (Build Mapping)."
	});
});

module.exports = router;
