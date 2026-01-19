const EventEmitter = require("events");
const firebird = require("../db/firebird");
const mysql = require("../db/mysql");
const { applyTransform } = require("./mappers");
const runStore = require("./runStore");

const runEmitters = new Map();

function getEmitter(runId) {
	return runEmitters.get(runId);
}

function createEmitter(runId) {
	const emitter = new EventEmitter();
	runEmitters.set(runId, emitter);
	return emitter;
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

	const emitter = createEmitter(runId);
	const includedSteps = (plan || []).filter((step) => step.include);
	const totals = {
		tables_total: includedSteps.length,
		tables_done: 0,
		tables_failed: 0,
		rows_total_migrated: 0,
		rows_total_error: 0,
		rows_total_skipped_duplicates: 0
	};
	emitter.emit("event", { type: "run_started", runId, ...totals });
	let runHadFailures = false;

	try {
		const firebirdTables = await firebird.listTables(firebirdConfig);
		const firebirdTableMap = new Map(
			firebirdTables.map((name) => [name.toLowerCase(), name])
		);

		if (fkChecks) {
			await pool.query("SET FOREIGN_KEY_CHECKS=0");
		}

		for (const step of plan) {
			if (!step.include) continue;
			const tableName = step.table;
			const mappingEntry = resolveMappingForTarget(tableName, mapping);
			if (!mappingEntry) {
				emitter.emit("event", {
					type: "table_skipped",
					table: tableName,
					reason: "No mapping"
				});
				continue;
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
				runHadFailures = true;
				totals.tables_failed += 1;
				totals.tables_done += 1;
				emitter.emit("event", {
					type: "table_failed",
					table: tableName,
					error: errorMessage,
					hint: "Check that the Firebird schema contains this table and the mapping is correct.",
					where: "preflight: source table resolution"
				});
				continue;
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
				runHadFailures = true;
				totals.tables_failed += 1;
				totals.tables_done += 1;
				emitter.emit("event", {
					type: "table_failed",
					table: tableName,
					error: errorMessage,
					hint: "Update your mapping or target schema so columns match.",
					where: "preflight: column validation"
				});
				continue;
			}

			if (!tableRun) {
				await runStore.startTableRun(pool, runId, tableName, step.mode, step.keyStrategy);
			}

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

				emitter.emit("event", {
					type: "table_started",
					table: tableName,
					sourceTable,
					rows_source: totalSource,
					mode: step.mode,
					keyStrategy: step.keyStrategy
				});

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

					const elapsedMs = Date.now() - tableStart;
					const rateRps = elapsedMs > 0 ? rowsMigrated / (elapsedMs / 1000) : 0;
					const remaining = Math.max(totalSource - rowsMigrated, 0);
					const etaSeconds = rateRps > 0 ? remaining / rateRps : null;

					emitter.emit("event", {
						type: "table_progress",
						table: tableName,
						rows_source: totalSource,
						rows_migrated: rowsMigrated,
						rows_error: rowsError,
						rows_skipped_duplicates: rowsSkippedDuplicates,
						percent: totalSource ? (rowsMigrated / totalSource) * 100 : 0,
						batchSize,
						last_offset: offset,
						elapsedMs,
						rateRps,
						etaSeconds
					});
				}

				await runStore.finishTableRun(pool, runId, tableName, rowsError ? "warning" : "success");
				if (rowsError > 0) {
					runHadFailures = true;
					totals.tables_failed += 1;
				}
				totals.tables_done += 1;
				emitter.emit("event", {
					type: "table_finished",
					table: tableName,
					rows_source: totalSource,
					rows_migrated: rowsMigrated,
					rows_error: rowsError,
					rows_skipped_duplicates: rowsSkippedDuplicates,
					percent: totalSource ? (rowsMigrated / totalSource) * 100 : 0
				});
			} finally {
				conn.release();
			}
		}

		if (fkChecks) {
			await pool.query("SET FOREIGN_KEY_CHECKS=1");
		}

		const finalStatus = runHadFailures ? "warning" : "success";
		await runStore.finishRun(pool, runId, finalStatus);
		emitter.emit("event", { type: "run_finished", runId, status: finalStatus, ...totals });
	} catch (err) {
		const errorMessage = formatDbError(err, { firebirdConfig });
		await runStore.finishRun(pool, runId, "failed", errorMessage);
		emitter.emit("event", { type: "run_failed", runId, error: errorMessage, hint: getDbErrorHint(errorMessage), ...totals });
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
	const runId = await runStore.createRun(pool, {
		schemaName,
		dryRun,
		batchSize,
		fkChecks,
		plan,
		mappingProfileId: mapping?.profileId || null
	});
	await pool.end();

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

async function resumeMigration({
	firebirdConfig,
	mysqlConfig,
	schemaName,
	plan,
	mapping,
	dryRun,
	batchSize,
	fkChecks,
	runId
}) {
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
	resumeMigration,
	getEmitter
};
