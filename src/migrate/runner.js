const EventEmitter = require("events");
const firebird = require("../db/firebird");
const mysql = require("../db/mysql");
const { applyTransform } = require("./mappers");
const runStore = require("./runStore");

const runEmitters = new Map();
const runStates = new Map();

function getEmitter(runId) {
	return runEmitters.get(runId);
}

function createEmitter(runId) {
	const emitter = new EventEmitter();
	runEmitters.set(runId, emitter);
	return emitter;
}

function getRunState(runId) {
	return runStates.get(runId) || null;
}

function formatTableLabel(tableName) {
	if (!tableName) return "";
	return String(tableName)
		.replace(/_/g, " ")
		.toLowerCase()
		.replace(/\b\w/g, (char) => char.toUpperCase());
}

function createRunState(runId, plan, mapping) {
	const included = (plan || []).filter((step) => step.include);
	const tables = included.map((step) => ({
		name: step.table,
		label: formatTableLabel(step.table),
		status: "QUEUED",
		migrated: 0,
		total: null,
		errors: 0,
		lastError: null,
		mode: step.mode,
		keyStrategy: step.keyStrategy
	}));
	const runState = {
		runId,
		startedAt: new Date().toISOString(),
		finishedAt: null,
		status: "RUNNING",
		currentTable: null,
		tables,
		totals: { migrated: 0, errors: 0, warnings: 0 }
	};
	if (mapping?.profileName || mapping?.name) {
		runState.label = mapping?.profileName || mapping?.name;
	}
	runStates.set(runId, runState);
	return runState;
}

function computeTotals(runState) {
	const totals = { migrated: 0, errors: 0, warnings: 0 };
	for (const table of runState.tables) {
		totals.migrated += table.migrated || 0;
		totals.errors += table.errors || 0;
	}
	runState.totals = totals;
}

function emitRunState(runId, emitter) {
	const runState = getRunState(runId);
	if (!runState || !emitter) return;
	computeTotals(runState);
	emitter.emit("event", { event: "runState", data: runState });
}

function resolveMappingForTarget(tableName, mapping) {
	const entries = mapping?.tables || {};
	const sourceKey = Object.keys(entries).find(
		(key) => entries[key].target.toLowerCase() === tableName.toLowerCase()
	);
	if (!sourceKey) return null;
	return { sourceTable: sourceKey, ...entries[sourceKey] };
}

function resolveFirebirdSourceTable(mappedSource, firebirdTableMap) {
	if (!mappedSource) return null;
	const direct = firebirdTableMap.get(mappedSource.toLowerCase());
	if (direct) return direct;

	const candidates = [];
	if (mappedSource.toUpperCase().endsWith("IES")) {
		candidates.push(mappedSource.slice(0, -3) + "Y");
	}
	if (mappedSource.toUpperCase().endsWith("S")) {
		candidates.push(mappedSource.slice(0, -1));
	}

	for (const candidate of candidates) {
		const found = firebirdTableMap.get(candidate.toLowerCase());
		if (found) return found;
	}

	return null;
}

function formatConfigSummary(firebirdConfig) {
	if (!firebirdConfig) return "";
	const host = firebirdConfig.host || "";
	const port = firebirdConfig.port || "";
	const database = firebirdConfig.database || "";
	const user = firebirdConfig.user || "";
	return `Config used: host=${host} port=${port} database=${database} user=${user}`;
}

function formatDbError(err, context = {}) {
	const message = err?.message || "Unknown error";
	if (message.includes("SQL error code = -204")) {
		return `${message}. Firebird table not found. Check the source table name in the mapping.`;
	}
	if (message.includes("SQL error code = -206")) {
		return `${message}. Firebird column not found. Check the source column name in the mapping.`;
	}
	if (message.toLowerCase().includes("user name and password are not defined")) {
		const configSummary = formatConfigSummary(context.firebirdConfig);
		return `${message}. Likely causes: empty user, empty password, Firebird Embedded security misconfiguration, or connecting to the wrong server/port. Verify credentials on Setup. ${configSummary}`;
	}
	if (message.includes("ER_DUP_ENTRY")) {
		return `${message}. Duplicate key detected. Consider switching to Re-key IDs for this table.`;
	}
	return message;
}

function getDbErrorHint(message) {
	const lower = String(message || "").toLowerCase();
	if (lower.includes("user name and password are not defined")) {
		return "Check Firebird user and password, confirm the server/port, and ensure you are not using Embedded without proper security configuration.";
	}
	if (message.includes("SQL error code = -204")) {
		return "Verify the source table exists in Firebird and the mapping uses the correct name.";
	}
	if (message.includes("SQL error code = -206")) {
		return "Verify the source column exists in Firebird and the mapping uses the correct column name.";
	}
	if (message.includes("ER_DUP_ENTRY")) {
		return "Try switching to Re-key IDs for this table or clean duplicate rows in the target.";
	}
	return "Check the server logs for details and verify the mapping and schema.";
}

function isDuplicateErr(err) {
	return err?.code === "ER_DUP_ENTRY" || err?.errno === 1062;
}

async function mapRow(row, columnMap, lookupFn) {
	const result = {};
	for (const [sourceCol, rule] of Object.entries(columnMap)) {
		const srcKey = sourceCol.toLowerCase();
		const value = row[srcKey];
		let mappedValue = value;
		if (rule.lookup) {
			mappedValue = await lookupFn(rule.lookup.table, value);
		}
		if (rule.transform) {
			mappedValue = applyTransform(rule.transform, mappedValue);
		}
		if (mappedValue === undefined || mappedValue === null) {
			if (Object.prototype.hasOwnProperty.call(rule, "default")) {
				mappedValue = rule.default;
			}
		}
		result[rule.target] = mappedValue;
	}
	return result;
}

function buildInsertStatement(tableName, columns, mode, primaryKeys, ignoreDuplicates) {
	const colList = columns.map((c) => `\`${c}\``).join(", ");
	const ignorePrefix = ignoreDuplicates && mode !== "UPSERT" ? "ignore " : "";
	const base = `insert ${ignorePrefix}into \`${tableName}\` (${colList}) values ?`;
	if (mode !== "UPSERT") return { sql: base, updateCols: [] };
	const updates = columns
		.filter((c) => !primaryKeys.includes(c))
		.map((c) => `\`${c}\`=values(\`${c}\`)`)
		.join(", ");
	const sql = updates.length ? `${base} on duplicate key update ${updates}` : base;
	return { sql, updateCols: updates };
}

async function runMigrationInternal({
	firebirdConfig,
	mysqlConfig,
	schemaName,
	plan,
	mapping,
	dryRun,
	batchSize,
	fkChecks,
	runId,
	ignoreDuplicates = true
}) {
	const pool = await mysql.connectToSchema(mysqlConfig, schemaName);
	await mysql.ensureMigrationTables(pool);

	const emitter = getEmitter(runId) || createEmitter(runId);
	const runState = getRunState(runId) || createRunState(runId, plan, mapping);
	const includedSteps = (plan || []).filter((step) => step.include);
	const tableStateMap = new Map(runState.tables.map((table) => [table.name, table]));
	let runFailed = false;
	let failureInfo = null;
	emitRunState(runId, emitter);

	const markRemainingNotRun = (failedTableName) => {
		for (const table of runState.tables) {
			if (table.name === failedTableName) continue;
			if (table.status === "QUEUED" || table.status === "RUNNING") {
				table.status = "NOT_RUN";
			}
		}
	};

	try {
		const firebirdTables = await firebird.listTables(firebirdConfig);
		const firebirdTableMap = new Map(
			firebirdTables.map((name) => [name.toLowerCase(), name])
		);

		if (fkChecks) {
			await pool.query("SET FOREIGN_KEY_CHECKS=0");
		}

		for (const step of includedSteps) {
			const tableName = step.table;
			const mappingEntry = resolveMappingForTarget(tableName, mapping);
			const tableState = tableStateMap.get(tableName);

			const failRun = async (errorMessage, hint) => {
				if (!tableState) return;
				runFailed = true;
				failureInfo = { tableName, errorMessage, hint };
				tableState.status = "FAILED";
				tableState.lastError = { message: errorMessage, hint };
				runState.status = "FAILED";
				runState.currentTable = tableName;
				runState.finishedAt = new Date().toISOString();
				markRemainingNotRun(tableName);
				emitRunState(runId, emitter);
			};

			if (!mappingEntry) {
				const errorMessage = `No mapping found for target table ${tableName}.`;
				const hint = "Update your mapping to include this table.";
				const existingRun = await runStore.getTableRun(pool, runId, tableName);
				if (!existingRun) {
					await runStore.startTableRun(pool, runId, tableName, step.mode, step.keyStrategy);
				}
				await runStore.finishTableRun(pool, runId, tableName, "failed", errorMessage);
				await failRun(errorMessage, hint);
				break;
			}

			const mappedSource = mappingEntry.sourceTable;
			const sourceTable = resolveFirebirdSourceTable(mappedSource, firebirdTableMap);
			const columnsMap = mappingEntry.columns;
			const firebirdColumns = Object.keys(columnsMap || {});
			const targetColumns = Object.values(columnsMap || {}).map((c) => c.target);

			const tableRun = await runStore.getTableRun(pool, runId, tableName);
			if (tableRun?.status === "success") {
				emitter.emit("event", {
					type: "table_skipped",
					table: tableName,
					reason: "Already completed"
				});
				continue;
			}

			if (!sourceTable) {
				const errorMessage = `Source table not found in Firebird: ${mappedSource}. Check the Firebird schema and mapping.`;
				if (!tableRun) {
					await runStore.startTableRun(pool, runId, tableName, step.mode, step.keyStrategy);
				}
				await runStore.finishTableRun(pool, runId, tableName, "failed", errorMessage);
				await failRun(errorMessage, "Check that the Firebird schema contains this table and the mapping is correct.");
				break;
			}

			const firebirdColumnNames = (await firebird.listColumns(firebirdConfig, sourceTable)).map((c) => c.toLowerCase());
			const mysqlColumnNames = (await mysql.listColumns(pool, tableName)).map((c) => c.name.toLowerCase());
			const missingSource = firebirdColumns.filter((c) => !firebirdColumnNames.includes(c.toLowerCase()));
			const missingTarget = targetColumns.filter((c) => !mysqlColumnNames.includes(c.toLowerCase()));

			if (missingSource.length || missingTarget.length) {
				const errorMessage = [
					missingSource.length ? `Firebird missing columns: ${missingSource.join(", ")}` : null,
					missingTarget.length ? `MySQL missing columns: ${missingTarget.join(", ")}` : null
				].filter(Boolean).join(" | ");
				if (!tableRun) {
					await runStore.startTableRun(pool, runId, tableName, step.mode, step.keyStrategy);
				}
				await runStore.finishTableRun(pool, runId, tableName, "failed", errorMessage);
				await failRun(errorMessage, "Update your mapping or target schema so columns match.");
				break;
			}

			if (!tableRun) {
				await runStore.startTableRun(pool, runId, tableName, step.mode, step.keyStrategy);
			}
			tableState.status = "RUNNING";
			tableState.lastError = null;
			runState.currentTable = tableName;
			emitRunState(runId, emitter);

			const primaryKeys = await mysql.getPrimaryKeys(pool, tableName);
			let targetColumnsForInsert = targetColumns;
			const sourceIdColumn = primaryKeys.length
				? Object.entries(columnsMap).find(([, rule]) => rule.target === primaryKeys[0])?.[0]
				: null;

			const conn = await pool.getConnection();
			try {
				if (step.keyStrategy === "rekey" && primaryKeys.length) {
					targetColumnsForInsert = targetColumnsForInsert.filter((c) => !primaryKeys.includes(c));
				}

				if (step.mode === "TRUNCATE+INSERT" && !dryRun) {
					await conn.query(`truncate table \`${tableName}\``);
				}

				let offset = tableRun?.last_offset || 0;
				let rowsMigrated = tableRun?.rows_migrated || 0;
				let rowsError = tableRun?.rows_error || 0;
				let rowsSkippedDuplicates = tableRun?.rows_skipped_duplicates || 0;
				const tableStart = Date.now();

				const totalSource = await firebird.countRows(firebirdConfig, sourceTable);
				await runStore.updateTableProgress(pool, runId, tableName, { rows_source: totalSource });
				tableState.total = totalSource;
				emitRunState(runId, emitter);

				const { sql } = buildInsertStatement(
					tableName,
					targetColumnsForInsert,
					step.mode,
					primaryKeys,
					ignoreDuplicates
				);

				while (offset < totalSource) {
					const batch = await firebird.fetchBatch(
						firebirdConfig,
						sourceTable,
						firebirdColumns,
						offset,
						batchSize,
						firebirdColumns[0]
					);

					if (!batch.length) break;

					const rowsToInsert = [];
					for (const row of batch) {
						const mappedRow = await mapRow(row, columnsMap, async (lookupTable, id) => {
							if (id === null || id === undefined) return id;
							return runStore.lookupIdMap(pool, {
								runId,
								tableName: lookupTable,
								sourceId: id
							});
						});
						const values = targetColumnsForInsert.map((c) => mappedRow[c]);
						const sourceId = sourceIdColumn ? row[sourceIdColumn.toLowerCase()] : undefined;
						rowsToInsert.push({ values, sourceId });
					}

					if (!dryRun) {
						if (step.keyStrategy === "rekey" && primaryKeys.length) {
							for (let rowIndex = 0; rowIndex < rowsToInsert.length; rowIndex += 1) {
								const row = rowsToInsert[rowIndex];
								const sourceRow = batch[rowIndex] || null;
								try {
									await conn.beginTransaction();
									const [result] = await conn.query(sql, [[row.values]]);
									await conn.commit();
									if (ignoreDuplicates && result.affectedRows === 0) {
										rowsSkippedDuplicates += 1;
										totals.rows_total_skipped_duplicates += 1;
										continue;
									}
									rowsMigrated += 1;
									totals.rows_total_migrated += 1;
									if (result.insertId && row.sourceId !== undefined) {
										await runStore.storeIdMap(pool, {
											runId,
											tableName,
											sourceId: row.sourceId,
											targetId: result.insertId
										});
									}
								} catch (err) {
									try {
										await conn.rollback();
									} catch (rollbackErr) {
										// ignore
									}
									if (isDuplicateErr(err)) {
										rowsSkippedDuplicates += 1;
										totals.rows_total_skipped_duplicates += 1;
										continue;
									}
									const errorMessage = formatDbError(err, { firebirdConfig });
									const hint = getDbErrorHint(errorMessage);
									rowsError += 1;
									totals.rows_total_error += 1;
									let sourcePkValue = null;
									if (sourceRow) {
										if (sourceIdColumn) {
											sourcePkValue = sourceRow[sourceIdColumn.toLowerCase()];
										} else {
											const firstKey = Object.keys(sourceRow)[0];
											sourcePkValue = firstKey ? sourceRow[firstKey] : null;
										}
									}
									await runStore.logRowError(pool, {
										runId,
										tableName,
										sourceTable,
										targetTable: tableName,
										rowOffset: offset + rowIndex,
										sourcePk: sourcePkValue,
										errorMessage,
										hint,
										rowJson: sourceRow ? JSON.stringify(sourceRow) : null
									});
								}
							}
						} else {
							try {
								await conn.beginTransaction();
								const [result] = await conn.query(sql, [rowsToInsert.map((r) => r.values)]);
								await conn.commit();
								const inserted = step.mode === "UPSERT"
									? rowsToInsert.length
									: Number(result?.affectedRows || 0);
								const skipped =
									ignoreDuplicates && step.mode !== "UPSERT"
										? Math.max(rowsToInsert.length - inserted, 0)
										: 0;
								rowsMigrated += inserted;
								rowsSkippedDuplicates += skipped;
								totals.rows_total_migrated += inserted;
								totals.rows_total_skipped_duplicates += skipped;
							} catch (err) {
								try {
									await conn.rollback();
								} catch (rollbackErr) {
									// ignore
								}
								for (let rowIndex = 0; rowIndex < rowsToInsert.length; rowIndex += 1) {
									const row = rowsToInsert[rowIndex];
									const sourceRow = batch[rowIndex] || null;
									try {
										await conn.beginTransaction();
										const [result] = await conn.query(sql, [[row.values]]);
										await conn.commit();
										if (ignoreDuplicates && result.affectedRows === 0) {
											rowsSkippedDuplicates += 1;
											totals.rows_total_skipped_duplicates += 1;
											continue;
										}
										rowsMigrated += 1;
										totals.rows_total_migrated += 1;
									} catch (rowErr) {
										try {
											await conn.rollback();
										} catch (rollbackErr) {
											// ignore
										}
										if (isDuplicateErr(rowErr)) {
											rowsSkippedDuplicates += 1;
											totals.rows_total_skipped_duplicates += 1;
											continue;
										}
										const errorMessage = formatDbError(rowErr, { firebirdConfig });
										const hint = getDbErrorHint(errorMessage);
										rowsError += 1;
										totals.rows_total_error += 1;
										let sourcePkValue = null;
										if (sourceRow) {
											if (sourceIdColumn) {
												sourcePkValue = sourceRow[sourceIdColumn.toLowerCase()];
											} else {
												const firstKey = Object.keys(sourceRow)[0];
												sourcePkValue = firstKey ? sourceRow[firstKey] : null;
											}
										}
										await runStore.logRowError(pool, {
											runId,
											tableName,
											sourceTable,
											targetTable: tableName,
											rowOffset: offset + rowIndex,
											sourcePk: sourcePkValue,
											errorMessage,
											hint,
											rowJson: sourceRow ? JSON.stringify(sourceRow) : null
										});
									}
								}
							}
						}
					} else {
						rowsMigrated += rowsToInsert.length;
						totals.rows_total_migrated += rowsToInsert.length;
					}

					offset += rowsToInsert.length;

					await runStore.updateTableProgress(pool, runId, tableName, {
						last_offset: offset,
						rows_migrated: rowsMigrated,
						rows_error: rowsError,
						rows_skipped_duplicates: rowsSkippedDuplicates
					});
					tableState.migrated = rowsMigrated;
					tableState.errors = rowsError;
					emitRunState(runId, emitter);
				}

				await runStore.finishTableRun(pool, runId, tableName, "success");
				tableState.status = "SUCCESS";
				emitRunState(runId, emitter);
			} finally {
				conn.release();
			}

				if (runFailed) break;
		}

		if (fkChecks) {
			await pool.query("SET FOREIGN_KEY_CHECKS=1");
		}

			if (runFailed) {
				await runStore.finishRun(pool, runId, "FAILED", failureInfo?.errorMessage || null);
				emitRunState(runId, emitter);
			} else {
				runState.status = "SUCCESS";
				runState.finishedAt = new Date().toISOString();
				await runStore.finishRun(pool, runId, "SUCCESS");
				emitRunState(runId, emitter);
			}
	} catch (err) {
		const errorMessage = formatDbError(err, { firebirdConfig });
			const hint = getDbErrorHint(errorMessage);
			runState.status = "FAILED";
			runState.finishedAt = new Date().toISOString();
			if (runState.currentTable) {
				const tableState = tableStateMap.get(runState.currentTable);
				if (tableState) {
					tableState.status = "FAILED";
					tableState.lastError = { message: errorMessage, hint };
				}
			try {
				await runStore.finishTableRun(pool, runId, runState.currentTable, "failed", errorMessage);
			} catch (finishErr) {
				// ignore
			}
			}
			markRemainingNotRun(runState.currentTable);
			await runStore.finishRun(pool, runId, "FAILED", errorMessage);
			emitRunState(runId, emitter);
	} finally {
		await pool.end();
	}

	return { runId, emitter };
}

async function startMigration({
	firebirdConfig,
	mysqlConfig,
	schemaName,
	plan,
	mapping,
	dryRun,
	batchSize,
	fkChecks
}) {
	const pool = await mysql.connectToSchema(mysqlConfig, schemaName);
	await mysql.ensureMigrationTables(pool);
	const run_label = mapping?.profileName || mapping?.name || `Run ${new Date().toISOString().slice(0, 10)}`;
	const source_conn_name = firebirdConfig?.name || `${firebirdConfig?.host || 'unknown'}:${firebirdConfig?.database || ''}`;
	const runId = await runStore.createRun(pool, {
		plan_id: mapping?.planId || null,
		run_label,
		source_conn_name,
		target_schema_name: schemaName,
		schemaName,
		dryRun,
		batchSize,
		fkChecks,
		plan,
		mappingProfileId: mapping?.profileId || null
	});
	await pool.end();
	createEmitter(runId);
	createRunState(runId, plan, mapping);
	emitRunState(runId, getEmitter(runId));

	setImmediate(() => {
		runMigrationInternal({
			firebirdConfig,
			mysqlConfig,
			schemaName,
			plan,
			mapping,
			dryRun,
			batchSize,
			fkChecks,
			runId
		});
	});

	return { runId };
}

module.exports = {
	startMigration,
	getEmitter,
	getRunState
};
