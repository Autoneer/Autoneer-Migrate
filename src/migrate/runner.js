const EventEmitter = require("events");
const firebird = require("../db/firebird");
const mysql = require("../db/mysql");
const { applyTransform } = require("./mappers");
const runStore = require("./runStore");
const logger = require("./logger");

const runEmitters = new Map();
const runStates = new Map();
const runAbortFlags = new Map();

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

function isRunActive(runId) {
	if (runId) {
		return getRunState(runId)?.status === "RUNNING";
	}
	for (const state of runStates.values()) {
		if (state?.status === "RUNNING") return true;
	}
	return false;
}

function requestAbort(runId, reason) {
	runAbortFlags.set(runId, { reason: reason || "Migration stopped" });

	// Emit an immediate update to clients so UI can react
	const emitter = getEmitter(runId) || null;
	const state = getRunState(runId);
	if (state) {
		state.status = 'ABORTING';
		state.lastError = { message: reason || 'Migration stopped by user', phase: 'abort' };
		emitRunState(runId, emitter);
	}
}

function checkAbort(runId) {
	const abortInfo = runAbortFlags.get(runId);
	if (abortInfo) {
		throw new Error(abortInfo.reason || "Migration stopped");
	}
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
		inserted: 0,
		updated: 0,
		total: null,
		errors: 0,
		skippedDuplicates: 0,
		cleaned: false,
		durationMs: 0,
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
		lastError: null,
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
	runState.lastEventAt = new Date().toISOString();
	emitter.emit("event", { event: "runState", data: runState });
}

function resolveMappingForTarget(tableName, mapping) {
	const entries = mapping?.tables || {};
	const sourceKey = Object.keys(entries).find(
		(key) => {
			const target = entries[key]?.target || entries[key]?.targetTable;
			return target && target.toLowerCase() === tableName.toLowerCase();
		}
	);
	if (!sourceKey) {
		// Debug: log what targets are available
		const availableTargets = Object.entries(entries).map(([k, v]) => ({
			source: k,
			target: v?.target || v?.targetTable
		}));
		console.log(`[Mapping] Looking for target '${tableName}' in mapping. Available entries:`, JSON.stringify(availableTargets.slice(0, 5)));
		return null;
	}
	const entry = entries[sourceKey] || {};
	return { sourceTable: sourceKey, ...entry, target: entry.target || entry.targetTable };
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

function normalizeDedupeKey(values) {
	return JSON.stringify(values.map((v) => (v === undefined ? null : v)));
}

function buildDedupeQuery(tableName, dedupeKeys, tuples) {
	if (!dedupeKeys.length || !tuples.length) return null;
	const cols = dedupeKeys.map((c) => `\`${c}\``).join(", ");
	const params = [];
	let where = "";
	if (dedupeKeys.length === 1) {
		where = `\`${dedupeKeys[0]}\` in (${tuples.map(() => "?").join(", ")})`;
		tuples.forEach((t) => params.push(t[0]));
	} else {
		const placeholders = tuples.map(() => `(${dedupeKeys.map(() => "?").join(", ")})`).join(", ");
		where = `(${cols}) in (${placeholders})`;
		tuples.forEach((t) => t.forEach((v) => params.push(v)));
	}
	return { sql: `select ${cols} from \`${tableName}\` where ${where}`, params };
}

function buildUpdateStatement(tableName, updateColumns, dedupeKeys) {
	const setCols = updateColumns.map((c) => `\`${c}\`=?`).join(", ");
	const whereCols = dedupeKeys.map((c) => `\`${c}\`=?`).join(" and ");
	return `update \`${tableName}\` set ${setCols} where ${whereCols}`;
}

function buildTempIndexName(runId, tableName) {
	const base = `ux_migrate_${runId}_${tableName}`.replace(/[^a-zA-Z0-9_]/g, "_");
	return base.length > 60 ? base.slice(0, 60) : base;
}

/**
 * Validates that mapped columns satisfy MySQL NOT NULL constraints.
 * Checks if columns marked as NOT NULL in MySQL have proper mappings with non-null defaults or transforms.
 * 
 * @param {Object} pool - MySQL connection pool
 * @param {string} tableName - Target MySQL table name
 * @param {Object} columnMap - Column mapping object from mapping configuration
 * @returns {Promise<Object>} - { safe: boolean, violations: Array<{column, message, suggestion}> }
 */
async function validateColumnNullability(pool, tableName, columnMap) {
	const violations = [];

	try {
		// Query MySQL information_schema for NOT NULL constraints
		const [columns] = await pool.query(`
			SELECT 
				COLUMN_NAME,
				IS_NULLABLE,
				COLUMN_DEFAULT,
				DATA_TYPE,
				COLUMN_TYPE
			FROM information_schema.COLUMNS
			WHERE TABLE_SCHEMA = DATABASE()
			AND TABLE_NAME = ?
			AND IS_NULLABLE = 'NO'
		`, [tableName]);

		// Build target column map for quick lookup
		const targetColumnMap = new Map();
		for (const [sourceCol, rule] of Object.entries(columnMap || {})) {
			targetColumnMap.set(rule.target.toLowerCase(), { sourceCol, rule });
		}

		// Check each NOT NULL column
		for (const col of columns) {
			const colName = col.COLUMN_NAME;
			const colNameLower = colName.toLowerCase();

			// Skip auto-increment columns
			if (col.EXTRA && col.EXTRA.includes('auto_increment')) {
				continue;
			}

			const mapping = targetColumnMap.get(colNameLower);

			if (!mapping) {
				// Column is NOT NULL but not in mapping
				if (col.COLUMN_DEFAULT !== null) {
					// Has default value, safe
					continue;
				}

				violations.push({
					column: colName,
					message: `Column '${colName}' is NOT NULL in MySQL but not mapped.`,
					suggestion: `Add '${colName}' to the mapping with a default value or ensure the source column exists.`,
					risk: 'high'
				});
				continue;
			}

			const { rule } = mapping;

			// Check if transform might return NULL
			if (rule.transform) {
				const transformName = typeof rule.transform === 'string' ? rule.transform : rule.transform.name;
				const riskyTransforms = ['toNumber', 'toDate', 'toDateTime', 'toBoolean'];

				if (riskyTransforms.includes(transformName)) {
					// These transforms can return NULL on invalid input
					if (!Object.prototype.hasOwnProperty.call(rule, 'default')) {
						violations.push({
							column: colName,
							message: `Column '${colName}' is NOT NULL but uses transform '${transformName}' which can return NULL, and no default is set.`,
							suggestion: `Add a default value to the mapping: { "default": 0 } or ensure source data is never empty/null.`,
							risk: 'high'
						});
					}
				}
			}

			// Check if only default is provided (no source column, no transform)
			if (!rule.transform && Object.prototype.hasOwnProperty.call(rule, 'default')) {
				if (rule.default === null || rule.default === undefined) {
					violations.push({
						column: colName,
						message: `Column '${colName}' is NOT NULL but default value is null/undefined.`,
						suggestion: `Set a non-null default value in the mapping.`,
						risk: 'high'
					});
				}
			}
		}

		return {
			safe: violations.length === 0,
			violations
		};
	} catch (err) {
		// If we can't validate, return empty violations to not block migration
		console.warn(`Failed to validate nullability for ${tableName}: ${err.message}`);
		return { safe: true, violations: [] };
	}
}

/**
 * Checks type compatibility between Firebird and MySQL data types.
 * Identifies risky conversions that may cause data loss.
 * 
 * @param {string} firebirdType - Firebird data type
 * @param {string} mysqlType - MySQL data type
 * @returns {Object} - { safe: boolean, risk: string, message: string }
 */
function checkTypeCompatibility(firebirdType, mysqlType) {
	const fbType = String(firebirdType).toUpperCase();
	const myType = String(mysqlType).toUpperCase();

	// Mapping of safe Firebird → MySQL type conversions
	const conversions = {
		'SMALLINT': ['TINYINT', 'SMALLINT', 'INT', 'BIGINT'],
		'INTEGER': ['INT', 'BIGINT'],
		'BIGINT': ['BIGINT'],
		'NUMERIC': ['DECIMAL', 'DOUBLE', 'FLOAT', 'NUMERIC'],
		'DECIMAL': ['DECIMAL', 'DOUBLE', 'FLOAT', 'NUMERIC'],
		'FLOAT': ['FLOAT', 'DOUBLE'],
		'DOUBLE': ['DOUBLE', 'FLOAT'],
		'CHAR': ['CHAR', 'VARCHAR', 'TEXT', 'TINYTEXT', 'MEDIUMTEXT', 'LONGTEXT'],
		'VARCHAR': ['VARCHAR', 'TEXT', 'TINYTEXT', 'MEDIUMTEXT', 'LONGTEXT'],
		'BLOB': ['LONGBLOB', 'BLOB', 'MEDIUMBLOB', 'LONGTEXT'],
		'DATE': ['DATE', 'DATETIME'],
		'TIMESTAMP': ['DATETIME', 'TIMESTAMP'],
		'TIME': ['TIME'],
		'BOOLEAN': ['TINYINT', 'BOOLEAN', 'BOOL']
	};

	// Find matching conversion rule
	for (const [fbBaseType, allowedMyTypes] of Object.entries(conversions)) {
		if (fbType.includes(fbBaseType)) {
			const safe = allowedMyTypes.some(t => myType.includes(t));
			return {
				safe,
				risk: safe ? 'none' : 'high',
				message: safe
					? `${fbType} → ${myType} is safe`
					: `${fbType} → ${myType} may cause data loss or truncation`
			};
		}
	}

	// Unknown type, warn but don't block
	return {
		safe: false,
		risk: 'medium',
		message: `Unknown type conversion: ${fbType} → ${myType}. Manual verification recommended.`
	};
}

/**
 * Validates data type mappings between Firebird source and MySQL target.
 * Checks for unsafe type conversions and precision mismatches.
 * 
 * @param {Object} pool - MySQL connection pool
 * @param {Object} firebirdConfig - Firebird connection configuration
 * @param {string} sourceTable - Firebird source table name
 * @param {string} targetTable - MySQL target table name
 * @param {Object} columnMap - Column mapping object
 * @returns {Promise<Array>} - Array of warnings for risky conversions
 */
/**
 * Wraps a database operation in a transaction with automatic rollback on error.
 * Ensures data consistency by committing only on success or rolling back on failure.
 * 
 * @param {Object} pool - MySQL connection pool
 * @param {string} tableName - Table name for logging purposes
 * @param {Function} callback - Async function that performs the operation, receives connection as parameter
 * @param {Function} logRun - Logging function
 * @returns {Promise<*>} - Result of the callback function
 * @throws {Error} - Throws original error after rollback
 */
async function withTransaction(pool, tableName, callback, logRun) {
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const result = await callback(conn);
		await conn.commit();
		return result;
	} catch (err) {
		try {
			await conn.rollback();
			logRun({
				level: 'info',
				phase: 'transaction',
				table: tableName,
				action: 'rollback',
				reason: err.message
			});
		} catch (rollbackErr) {
			logRun({
				level: 'error',
				phase: 'transaction',
				table: tableName,
				action: 'rollback_failed',
				error: rollbackErr.message
			});
		}
		throw err;
	} finally {
		conn.release();
	}
}

/**
 * Identifies numeric columns for checksum validation.
 * Returns column names that should be summed for integrity verification.
 * 
 * @param {string} tableName - Table name (case insensitive)
 * @returns {Array<string>} - List of numeric column names to validate
 */
function identifyNumericColumns(tableName) {
	const numericTables = {
		'SPARES_USED': ['quantity', 'cost_price', 'sales_price'],
		'INVOICES': ['inv_totalexlvat', 'inv_totalinclvat'],
		'ACCOUNTS': ['balance', 'credit', 'debit'],
		'PAYMENTS': ['amount'],
		'QUOTES': ['total_amount'],
		'ORDERS': ['total_amount']
	};
	return numericTables[tableName.toUpperCase()] || [];
}

/**
 * Validates migration integrity with zero-loss tolerance.
 * Checks row counts and numeric checksums to detect data loss or corruption.
 * 
 * @param {Object} pool - MySQL connection pool
 * @param {Object} firebirdConfig - Firebird connection configuration
 * @param {string} tableName - Target MySQL table name
 * @param {string} sourceTable - Source Firebird table name
 * @param {Object} stats - Migration statistics
 * @param {Function} logRun - Logging function
 * @returns {Promise<void>}
 * @throws {Error} - Throws if data loss or checksum mismatch detected
 */
async function validateMigrationIntegrity(pool, firebirdConfig, tableName, sourceTable, stats, logRun) {
	const { readRows, insertedRows, updatedRows, skippedRows, errorRows } = stats;

	// Validate row accounting with ZERO tolerance
	const accountedRows = insertedRows + updatedRows + skippedRows + errorRows;
	const unaccountedRows = readRows - accountedRows;

	if (unaccountedRows > 0) {
		throw new Error(
			`Data loss detected in ${tableName}: ` +
			`Read ${readRows} rows but only accounted for ${accountedRows}. ` +
			`Lost ${unaccountedRows} rows. ` +
			`Breakdown: ${insertedRows} inserted, ${updatedRows} updated, ${skippedRows} skipped, ${errorRows} errors. ` +
			`This may indicate a duplicate key problem or mapping issue.`
		);
	}

	// Checksum validation for numeric columns
	const numericColumns = identifyNumericColumns(tableName);
	if (numericColumns.length > 0) {
		try {
			// Get Firebird checksums
			const fbChecksum = await firebird.query(firebirdConfig, `
				SELECT ${numericColumns.map(c => `SUM("${c.toUpperCase()}") as ${c}`).join(', ')}
				FROM ${sourceTable}
			`);

			// Get MySQL checksums
			const [mysqlChecksum] = await pool.query(`
				SELECT ${numericColumns.map(c => `SUM(\`${c}\`) as ${c}`).join(', ')}
				FROM \`${tableName}\`
			`);

			// Compare sums with 1% variance tolerance for rounding
			const checksumResults = [];
			for (const col of numericColumns) {
				const fbSum = Number(fbChecksum[0]?.[col] || fbChecksum[0]?.[col.toUpperCase()] || 0);
				const mysqlSum = Number(mysqlChecksum[0]?.[col] || 0);
				const variance = Math.abs(fbSum - mysqlSum) / (Math.abs(fbSum) + 0.01);

				checksumResults.push({
					column: col,
					firebird_sum: fbSum,
					mysql_sum: mysqlSum,
					variance: (variance * 100).toFixed(4) + '%'
				});

				if (variance > 0.01) { // 1% variance tolerance
					throw new Error(
						`Checksum mismatch in ${tableName}.${col}: ` +
						`Firebird sum=${fbSum.toFixed(2)}, MySQL sum=${mysqlSum.toFixed(2)}, ` +
						`variance=${(variance * 100).toFixed(2)}%. ` +
						`This indicates data loss or incorrect transforms.`
					);
				}
			}

			logRun({
				level: 'info',
				phase: 'post_migration_validation',
				table: tableName,
				validation: 'checksum',
				checksums: checksumResults,
				status: 'passed'
			});
		} catch (err) {
			if (err.message.includes('Checksum mismatch')) {
				throw err;
			}
			// Log warning but don't fail if checksum query fails
			logRun({
				level: 'warn',
				phase: 'post_migration_validation',
				table: tableName,
				validation: 'checksum',
				status: 'error',
				error: err.message
			});
		}
	}

	logRun({
		level: 'info',
		phase: 'post_migration_validation',
		table: tableName,
		status: 'passed',
		readRows,
		inserted: insertedRows,
		updated: updatedRows,
		skipped: skippedRows,
		errors: errorRows,
		unaccounted: unaccountedRows
	});
}

async function validateDataTypeMapping(pool, firebirdConfig, sourceTable, targetTable, columnMap) {
	const warnings = [];

	try {
		// Get MySQL column types
		const [mysqlColumns] = await pool.query(`
			SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE
			FROM information_schema.COLUMNS
			WHERE TABLE_SCHEMA = DATABASE()
			AND TABLE_NAME = ?
		`, [targetTable]);

		const mysqlColumnMap = new Map(
			mysqlColumns.map(c => [c.COLUMN_NAME.toLowerCase(), c])
		);

		// Get Firebird column types
		const fbColumns = await firebird.query(firebirdConfig, `
			SELECT 
				rf.RDB$FIELD_NAME as FIELD_NAME,
				f.RDB$FIELD_TYPE as FIELD_TYPE,
				f.RDB$FIELD_LENGTH as FIELD_LENGTH,
				f.RDB$FIELD_PRECISION as FIELD_PRECISION,
				f.RDB$FIELD_SCALE as FIELD_SCALE
			FROM RDB$RELATION_FIELDS rf
			JOIN RDB$FIELDS f ON rf.RDB$FIELD_SOURCE = f.RDB$FIELD_NAME
			WHERE rf.RDB$RELATION_NAME = '${sourceTable.toUpperCase()}'
		`);

		const fbColumnMap = new Map();
		for (const col of fbColumns) {
			const name = (col.FIELD_NAME || col.field_name || '').trim().toLowerCase();
			const typeCode = col.FIELD_TYPE || col.field_type;

			// Map Firebird type codes to names
			const typeMap = {
				7: 'SMALLINT',
				8: 'INTEGER',
				16: 'BIGINT',
				10: 'FLOAT',
				27: 'DOUBLE',
				12: 'DATE',
				13: 'TIME',
				35: 'TIMESTAMP',
				14: 'CHAR',
				37: 'VARCHAR',
				261: 'BLOB',
				23: 'BOOLEAN'
			};

			fbColumnMap.set(name, {
				type: typeMap[typeCode] || 'UNKNOWN',
				length: col.FIELD_LENGTH || col.field_length,
				precision: col.FIELD_PRECISION || col.field_precision,
				scale: Math.abs(col.FIELD_SCALE || col.field_scale || 0)
			});
		}

		// Check each mapped column
		for (const [sourceCol, rule] of Object.entries(columnMap || {})) {
			const fbCol = fbColumnMap.get(sourceCol.toLowerCase());
			const mysqlCol = mysqlColumnMap.get(rule.target.toLowerCase());

			if (!fbCol || !mysqlCol) continue;

			// Check type compatibility
			const compatibility = checkTypeCompatibility(fbCol.type, mysqlCol.DATA_TYPE);

			if (!compatibility.safe) {
				warnings.push({
					table: targetTable,
					sourceColumn: sourceCol,
					sourceType: fbCol.type,
					targetColumn: rule.target,
					targetType: mysqlCol.COLUMN_TYPE,
					risk: compatibility.risk,
					message: compatibility.message
				});
			}

			// Check for precision loss in NUMERIC/DECIMAL
			if (fbCol.type === 'NUMERIC' || fbCol.type === 'DECIMAL') {
				if (mysqlCol.DATA_TYPE.toUpperCase().includes('DECIMAL')) {
					// Extract MySQL precision/scale from COLUMN_TYPE (e.g., "decimal(10,2)")
					const match = mysqlCol.COLUMN_TYPE.match(/\((\d+),(\d+)\)/);
					if (match) {
						const myPrecision = parseInt(match[1], 10);
						const myScale = parseInt(match[2], 10);

						if (fbCol.precision > myPrecision || fbCol.scale > myScale) {
							warnings.push({
								table: targetTable,
								sourceColumn: sourceCol,
								sourceType: `${fbCol.type}(${fbCol.precision},${fbCol.scale})`,
								targetColumn: rule.target,
								targetType: mysqlCol.COLUMN_TYPE,
								risk: 'high',
								message: `Precision mismatch: source has (${fbCol.precision},${fbCol.scale}) but target is (${myPrecision},${myScale})`
							});
						}
					}
				}
			}
		}

		return warnings;
	} catch (err) {
		console.warn(`Failed to validate data types for ${targetTable}: ${err.message}`);
		return [];
	}
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

	const logEmitter = logger.startRunLogger(runId);
	const logRun = (entry) => {
		logger.logEvent(runId, entry);
	};

	const emitter = getEmitter(runId) || createEmitter(runId);
	const runState = getRunState(runId) || createRunState(runId, plan, mapping);
	const includedSteps = (plan || []).filter((step) => step.include);
	const tableStateMap = new Map(runState.tables.map((table) => [table.name, table]));
	let runFailed = false;
	let failureInfo = null;
	emitRunState(runId, emitter);
	const totals = {
		rows_total_migrated: 0,
		rows_total_error: 0,
		rows_total_skipped_duplicates: 0
	};

	const maskConfig = (config) => {
		if (!config) return {};
		return {
			host: config.host || "",
			port: config.port || "",
			database: config.database || "",
			user: config.user ? `${String(config.user).slice(0, 2)}***` : ""
		};
	};

	const runTimed = async (label, fn) => {
		const start = Date.now();
		const result = await fn();
		const durationMs = Date.now() - start;
		logRun({ level: "debug", phase: label, durationMs });
		return result;
	};

	const preflightConnectivity = async () => {
		const checkFirebird = async () => {
			await Promise.race([
				firebird.query(firebirdConfig, "select 1 from rdb$database"),
				new Promise((_, reject) => setTimeout(() => reject(new Error("Firebird timeout")), 3000))
			]);
		};
		const checkMysql = async () => {
			await Promise.race([
				pool.query({ sql: "select 1 as ok", timeout: 3000 }),
				new Promise((_, reject) => setTimeout(() => reject(new Error("MySQL timeout")), 3000))
			]);
		};

		let lastError = null;
		const attempt = async (attemptNumber) => {
			try {
				try {
					await checkFirebird();
				} catch (err) {
					throw new Error(`Firebird connection failed: ${err?.message || "Unknown error"}`);
				}
				try {
					await checkMysql();
				} catch (err) {
					throw new Error(`MySQL connection failed: ${err?.message || "Unknown error"}`);
				}
				logRun({ level: "info", phase: "preflight", attempt: attemptNumber, status: "ok" });
				return true;
			} catch (err) {
				lastError = err;
				logRun({
					level: "warn",
					phase: "preflight",
					attempt: attemptNumber,
					status: "failed",
					error: err?.message,
					firebird: maskConfig(firebirdConfig),
					mysql: { host: mysqlConfig?.host || "", port: mysqlConfig?.port || "", schema: schemaName || "" }
				});
				return false;
			}
		};

		const okFirst = await attempt(1);
		if (okFirst) return;
		await new Promise((resolve) => setTimeout(resolve, 900));
		const okSecond = await attempt(2);
		if (!okSecond) {
			throw new Error(lastError?.message || "Preflight connectivity check failed. Verify Firebird and MySQL connections.");
		}
	};

	let keepaliveTimer = null;
	const startKeepalive = () => {
		const runKeepalive = async () => {
			try {
				await preflightConnectivity();
				logRun({ level: "debug", phase: "keepalive", status: "ok" });
			} catch (err) {
				logRun({ level: "error", phase: "keepalive", status: "failed", error: err?.message });
				requestAbort(runId, err?.message || "Connectivity check failed");
			}
		};
		keepaliveTimer = setInterval(runKeepalive, 20000);
	};

	const markRemainingNotRun = (failedTableName) => {
		for (const table of runState.tables) {
			if (table.name === failedTableName) continue;
			if (table.status === "QUEUED" || table.status === "RUNNING") {
				table.status = "NOT_RUN";
			}
		}
	};

	try {
		logRun({
			level: "info",
			phase: "run_start",
			runId,
			dryRun,
			batchSize,
			fkChecks,
			tables: (plan || []).filter((step) => step.include).map((step) => ({
				table: step.table,
				mode: step.mode,
				keyStrategy: step.keyStrategy,
				dedupeKeys: step.dedupeKeys || [],
				onDuplicate: step.onDuplicate || "SKIP",
				clean: Array.isArray(step.cleanBefore) ? step.cleanBefore : step.cleanBefore
			}))
		});
		await runTimed("preflight", preflightConnectivity);

		// Validate NOT NULL constraints for all tables before starting migration
		logRun({ level: "info", phase: "preflight", action: "nullability_validation", status: "start" });
		const nullabilityViolations = [];

		for (const step of includedSteps) {
			const tableName = step.table;
			const mappingEntry = resolveMappingForTarget(tableName, mapping);

			if (mappingEntry && mappingEntry.columns) {
				const validation = await validateColumnNullability(pool, tableName, mappingEntry.columns);

				if (!validation.safe) {
					for (const violation of validation.violations) {
						nullabilityViolations.push({
							table: tableName,
							...violation
						});
					}
				}
			}
		}

		if (nullabilityViolations.length > 0) {
			const errorMessages = nullabilityViolations.map(v =>
				`  • [${v.table}] ${v.message} ${v.suggestion}`
			).join('\n');

			logRun({
				level: "error",
				phase: "preflight",
				action: "nullability_validation",
				status: "failed",
				violations: nullabilityViolations
			});

			throw new Error(
				`Column NOT NULL constraint violations detected:\n${errorMessages}\n\n` +
				`Fix these mapping issues before starting migration.`
			);
		}

		logRun({ level: "info", phase: "preflight", action: "nullability_validation", status: "passed" });

		startKeepalive();
		checkAbort(runId);
		const firebirdTables = await firebird.listTables(firebirdConfig);
		const firebirdTableMap = new Map(
			firebirdTables.map((name) => [name.toLowerCase(), name])
		);

		// Auto-migrate old INVOICES column mapping to match actual schema
		if (mapping?.tables?.INVOICES?.columns) {
			const cols = mapping.tables.INVOICES.columns;
			const renames = {
				INVOICE_NR: "INV_NR",
				IDATE: "INVOICE_DATE",
				TOTAL: "INV_TOTALEXLVAT",
				TOTALINCLVAT: "INV_TOTALINCLVAT"
			};
			const targetRenames = {
				idate: "invoice_date",
				total: "inv_totalexlvat",
				totalinclvat: "inv_totalinclvat"
			};
			for (const [oldKey, newKey] of Object.entries(renames)) {
				if (cols[oldKey] && !cols[newKey]) {
					cols[newKey] = cols[oldKey];
					delete cols[oldKey];
					logRun({ level: "info", phase: "mapping_migrate", table: "INVOICES", oldKey, newKey });
				}
			}
			for (const rule of Object.values(cols)) {
				const lower = String(rule.target || "").toLowerCase();
				if (targetRenames[lower]) {
					logRun({ level: "info", phase: "mapping_migrate", table: "INVOICES", oldTarget: rule.target, newTarget: targetRenames[lower] });
					rule.target = targetRenames[lower];
				}
			}
		}

		// Auto-migrate old SPARES_USED column names
		if (mapping?.tables?.SPARES_USED?.columns) {
			const cols = mapping.tables.SPARES_USED.columns;
			const renames = {
				JOB_NUMBER: "JOB_NR",
				QTY: "QUANTITY",
				SPARE_ID: "SPARES_ID"
			};
			for (const [oldKey, newKey] of Object.entries(renames)) {
				if (cols[oldKey] && !cols[newKey]) {
					cols[newKey] = cols[oldKey];
					delete cols[oldKey];
					logRun({ level: "info", phase: "mapping_migrate", table: "SPARES_USED", oldKey, newKey });
				}
			}
		}
		// Fix dedupe keys for spares_used based on keyStrategy
		for (const step of plan || []) {
			if (step.table === "spares_used") {
				// Get the mapping entry to check keyStrategy
				const mappingEntry = mapping?.tables?.SPARES_USED;
				const keyStrategy = step.keyStrategy || mappingEntry?.keyStrategy || "preserve";

				if (keyStrategy === "preserve" && step.dedupeKeys && !step.dedupeKeys.includes("spares_id")) {
					// For preserve mode, dedupe on the primary key
					step.dedupeKeys = ["spares_id"];
					logRun({ level: "info", phase: "plan_migrate", table: "spares_used", keyStrategy, message: "Set dedupe keys to primary key: spares_id" });
				} else if (keyStrategy === "rekey" && step.dedupeKeys && step.dedupeKeys.includes("spares_id")) {
					// For rekey mode, use natural composite key (job_number + lnr is unique per job)
					step.dedupeKeys = ["job_number", "lnr"];
					logRun({ level: "info", phase: "plan_migrate", table: "spares_used", keyStrategy, message: "Set dedupe keys to natural composite: job_number, lnr" });
				}
			}
		}

		// Store original FK state and disable if requested
		let originalFkState = true;
		try {
			if (fkChecks) {
				const [result] = await pool.query("SELECT @@foreign_key_checks as fk_checks");
				originalFkState = result[0].fk_checks === 1;
				await pool.query("SET FOREIGN_KEY_CHECKS=0");
				logRun({
					level: 'info',
					phase: 'preflight',
					action: 'foreign_key_checks_disabled',
					original_state: originalFkState
				});
			}

			logRun({ level: 'debug', phase: 'table_loop', action: 'starting', includedCount: includedSteps.length, mappingTableCount: Object.keys(mapping?.tables || {}).length });

			for (const step of includedSteps) {
				checkAbort(runId);
				const tableName = step.table;
				logRun({ level: 'debug', phase: 'table_loop', action: 'processing', tableName, mappingTableKeys: Object.keys(mapping?.tables || {}).slice(0, 5) });
				const mappingEntry = resolveMappingForTarget(tableName, mapping);
				logRun({ level: 'debug', phase: 'table_loop', action: 'mapping_resolved', tableName, hasMappingEntry: !!mappingEntry, mappingTarget: mappingEntry?.target });
				const tableState = tableStateMap.get(tableName);
				let tableRunId = null; // Initialize early to avoid ReferenceError in failRun

				const failRun = async (errorMessage, hint, phase = "unknown") => {
					if (!tableState) return;
					runFailed = true;
					failureInfo = { tableName, errorMessage, hint };
					tableState.status = "FAILED";
					tableState.lastError = { message: errorMessage, hint, phase };
					runState.status = "FAILED";
					runState.currentTable = tableName;
					runState.finishedAt = new Date().toISOString();
					logRun({ level: "error", phase: "table_finalize", tableName, tableRunId, status: "failed", error: errorMessage, hint });
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
					await failRun(errorMessage, hint, "precheck");
					break;
				}

				const mappedSource = mappingEntry.sourceTable;
				const sourceTable = resolveFirebirdSourceTable(mappedSource, firebirdTableMap);
				const columnsMap = mappingEntry.columns;
				// Filter out omitted columns from validation
				const firebirdColumns = Object.keys(columnsMap || {}).filter(srcCol => {
					const colConfig = columnsMap[srcCol];
					return !colConfig.omit; // Exclude omitted columns
				});
				const targetColumns = Object.values(columnsMap || {})
					.filter(c => !c.omit) // Exclude omitted columns
					.map((c) => c.target);
				const dedupeKeys = Array.isArray(step.dedupeKeys)
					? step.dedupeKeys
					: step.dedupeKeys
						? [step.dedupeKeys]
						: [];
				const onDuplicate = step.onDuplicate || "SKIP";

				const tableRun = await runStore.getTableRun(pool, runId, tableName);
				tableRunId = tableRun?.id || null;
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
						const newId = await runStore.startTableRun(pool, runId, tableName, step.mode, step.keyStrategy);
						tableRunId = newId;
					}
					await runStore.finishTableRun(pool, runId, tableName, "failed", errorMessage);
					await failRun(errorMessage, "Check that the Firebird schema contains this table and the mapping is correct.", "precheck");
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
						const newId = await runStore.startTableRun(pool, runId, tableName, step.mode, step.keyStrategy);
						tableRunId = newId;
					}
					await runStore.finishTableRun(pool, runId, tableName, "failed", errorMessage);
					await failRun(errorMessage, "Update your mapping or target schema so columns match.", "precheck");
					break;
				}

				// Validate dedupe keys for NULL values in source data
				if (dedupeKeys.length && !dryRun) {
					const dedupeSourceCols = dedupeKeys
						.map(targetCol => {
							const entry = Object.entries(columnsMap || {}).find(([, rule]) => rule.target === targetCol);
							return entry ? entry[0] : null;
						})
						.filter(Boolean);

					if (dedupeSourceCols.length === dedupeKeys.length) {
						try {
							const nullCheckQuery = `SELECT COUNT(*) as null_count FROM ${sourceTable} WHERE ${dedupeSourceCols.map(c => `${c} IS NULL`).join(' OR ')}`;
							const nullCheckResult = await firebird.query(firebirdConfig, nullCheckQuery);
							const nullCount = nullCheckResult[0]?.NULL_COUNT || 0;

							if (nullCount > 0) {
								logRun({
									level: 'warn',
									phase: 'preflight',
									table: tableName,
									action: 'dedupe_keys_validation',
									message: `Found ${nullCount} rows with NULL values in dedupe key columns [${dedupeKeys.join(', ')}]`,
									hint: 'These rows will be inserted without deduplication. Consider choosing dedupe keys without NULLs or adding transforms to provide default values.'
								});
							}
						} catch (err) {
							// Non-critical validation - log and continue
							logRun({
								level: 'debug',
								phase: 'preflight',
								table: tableName,
								action: 'dedupe_keys_validation',
								error: err.message
							});
						}
					}
				}

				if (step.keyStrategy === "rekey" && step.mode === "UPSERT" && !dedupeKeys.length) {
					const errorMessage = `UPSERT with re-key IDs requires dedupe keys for table ${tableName}.`;
					if (!tableRun) {
						const newId = await runStore.startTableRun(pool, runId, tableName, step.mode, step.keyStrategy);
						tableRunId = newId;
					}
					await runStore.finishTableRun(pool, runId, tableName, "failed", errorMessage);
					await failRun(errorMessage, "Select dedupe keys in the plan or switch to Preserve IDs.", "precheck");
					break;
				}

				if (!tableRun) {
					const newId = await runStore.startTableRun(pool, runId, tableName, step.mode, step.keyStrategy);
					tableRunId = newId;
				}

				// Ensure tableRunId is always set
				if (!tableRunId) {
					throw new Error(`tableRunId not initialized for table ${tableName}`);
				}

				emitRunState(runId, emitter);

				const primaryKeys = await mysql.getPrimaryKeys(pool, tableName);
				let targetColumnsForInsert = targetColumns;
				const sourceIdColumn = primaryKeys.length
					? Object.entries(columnsMap).find(([, rule]) => rule.target === primaryKeys[0])?.[0]
					: null;

				let tempIndexName = null;
				if (dedupeKeys.length && !dryRun) {
					try {
						const uniqueIndexes = await mysql.listUniqueIndexes(pool, tableName);
						const hasDedupeIndex = mysql.hasUniqueIndexForColumns(uniqueIndexes, dedupeKeys);
						if (!hasDedupeIndex) {
							tempIndexName = buildTempIndexName(runId, tableName);
							await mysql.createUniqueIndex(pool, tableName, tempIndexName, dedupeKeys);
						}
					} catch (err) {
						// best-effort: continue without temp index
						tempIndexName = null;
					}
				}

				const conn = await pool.getConnection();
				try {
					const cleanBefore = step.cleanBefore === true;
					if (step.keyStrategy === "rekey" && primaryKeys.length) {
						targetColumnsForInsert = targetColumnsForInsert.filter((c) => !primaryKeys.includes(c));
					}

					if (cleanBefore && !dryRun && step.mode !== "TRUNCATE+INSERT") {
						logRun({ level: "info", phase: "clean", tableName, tableRunId, status: "start" });
						const cleanStart = Date.now();
						try {
							const [result] = await conn.query(`delete from \`${tableName}\``);
							const durationMs = Date.now() - cleanStart;
							logRun({
								level: "info",
								phase: "clean",
								tableName,
								tableRunId,
								status: "success",
								affectedRows: Number(result?.affectedRows || 0),
								durationMs
							});
							tableState.cleaned = true;
						} catch (err) {
							const errorMessage = formatDbError(err, { firebirdConfig });
							logRun({
								level: "error",
								phase: "clean",
								tableName,
								tableRunId,
								status: "failed",
								error: errorMessage
							});
							await runStore.finishTableRun(pool, runId, tableName, "failed", errorMessage);
							await failRun(errorMessage, "Clean step failed. Remove dependent rows or fix foreign key constraints.", "clean");
							break;
						}
					} else if (cleanBefore && step.mode === "TRUNCATE+INSERT") {
						logRun({ level: "warn", phase: "clean", tableName, tableRunId, status: "skipped", reason: "TRUNCATE+INSERT already clears table" });
					}

					if (step.mode === "TRUNCATE+INSERT" && !dryRun) {
						await conn.query(`truncate table \`${tableName}\``);
					}

					let offset = tableRun?.last_offset || 0;
					let rowsMigrated = tableRun?.rows_migrated || 0;
					let rowsInserted = 0;
					let rowsUpdated = 0;
					let rowsError = tableRun?.rows_error || 0;
					let rowsSkippedDuplicates = tableRun?.rows_skipped_duplicates || 0;
					const tableStart = Date.now();
					logRun({ level: "info", phase: "table_start", tableName, tableRunId, mode: step.mode, keyStrategy: step.keyStrategy, dedupeKeys });

					const totalSource = await firebird.countRows(firebirdConfig, sourceTable);
					await runStore.updateTableProgress(pool, runId, tableName, { rows_source: totalSource });
					tableState.total = totalSource;
					logRun({ level: "info", phase: "fetch", tableName, tableRunId, sourceRows: totalSource });
					emitRunState(runId, emitter);

					const ignoreDuplicatesForInsert = onDuplicate !== "ERROR";
					const { sql } = buildInsertStatement(
						tableName,
						targetColumnsForInsert,
						step.mode,
						primaryKeys,
						ignoreDuplicatesForInsert
					);
					const updateColumns = targetColumnsForInsert.filter((c) => !primaryKeys.includes(c));
					const useDedupe = dedupeKeys.length > 0;

					const logRowError = async (sourceRow, rowIndex, errorMessage) => {
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
					};

					while (offset < totalSource) {
						checkAbort(runId);
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
							const dedupeValues = dedupeKeys.map((key) => mappedRow[key]);
							rowsToInsert.push({ values, sourceId, dedupeValues, mappedRow });
						}

						const batchStart = Date.now();
						let batchInserted = 0;
						let batchUpdated = 0;
						let batchSkipped = 0;
						logRun({ level: "debug", phase: "write", tableName, tableRunId, status: "start", batchSize: rowsToInsert.length });

						if (!dryRun) {
							if (useDedupe) {
								const existingMap = new Map();
								const tuples = [];
								const tupleKeys = new Set();
								for (const row of rowsToInsert) {
									const ready = row.dedupeValues?.every((v) => v !== undefined && v !== null);
									if (!ready) continue;
									const key = normalizeDedupeKey(row.dedupeValues);
									if (!tupleKeys.has(key)) {
										tupleKeys.add(key);
										tuples.push(row.dedupeValues);
									}
								}
								const dedupeQuery = buildDedupeQuery(tableName, dedupeKeys, tuples);
								if (dedupeQuery) {
									let selectSql = dedupeQuery.sql;
									if (primaryKeys.length) {
										const selectCols = dedupeKeys.map((c) => `\`${c}\``).join(", ");
										selectSql = selectSql.replace(
											`select ${selectCols} from`,
											`select ${selectCols}, \`${primaryKeys[0]}\` as __pk from`
										);
									}
									const [existingRows] = await conn.query(selectSql, dedupeQuery.params);
									for (const existing of existingRows) {
										const keyValues = dedupeKeys.map((k) => existing[k]);
										const key = normalizeDedupeKey(keyValues);
										existingMap.set(key, primaryKeys.length ? existing.__pk : true);
									}
								}

								const batchSeen = new Set();
								const toInsert = [];
								const toUpdate = [];
								for (let rowIndex = 0; rowIndex < rowsToInsert.length; rowIndex += 1) {
									const row = rowsToInsert[rowIndex];
									const sourceRow = batch[rowIndex] || null;
									const ready = row.dedupeValues?.every((v) => v !== undefined && v !== null);

									// If dedupe keys contain NULL values, always insert the row (cannot reliably deduplicate)
									if (!ready) {
										logRun({
											level: 'debug',
											phase: 'deduplication',
											table: tableName,
											action: 'null_dedupe_keys',
											dedupe_keys: dedupeKeys,
											dedupe_values: row.dedupeValues,
											message: 'Row has NULL dedupe key values; inserting without deduplication'
										});
										toInsert.push({ row, sourceRow, rowIndex });
										continue; // Skip deduplication logic for this row
									}

									let matched = false;
									let key = null;
									key = normalizeDedupeKey(row.dedupeValues);
									matched = existingMap.has(key) || batchSeen.has(key);
									batchSeen.add(key);

									if (matched) {
										if (step.mode === "UPSERT") {
											toUpdate.push({ row, sourceRow, rowIndex, key });
											const existingPk = existingMap.get(key);
											if (step.keyStrategy === "rekey" && existingPk && row.sourceId !== undefined) {
												await runStore.storeIdMap(pool, {
													runId,
													tableName,
													sourceId: row.sourceId,
													targetId: existingPk
												});
											}
										} else {
											if (onDuplicate === "ERROR") {
												await logRowError(sourceRow, rowIndex, `Duplicate record detected for ${tableName} (dedupe keys: ${dedupeKeys.join(", ")}).`);
											} else {
												// Log individual skipped row with dedupe key values
												const dedupKeyValues = dedupeKeys.map(k => row[k]);
												logRun({
													level: 'debug',
													phase: 'deduplication',
													table: tableName,
													action: 'row_skipped',
													dedupe_keys: dedupeKeys,
													dedupe_values: dedupKeyValues,
													reason: 'duplicate_key'
												});
												rowsSkippedDuplicates += 1;
												batchSkipped += 1;
												totals.rows_total_skipped_duplicates += 1;
											}
										}
									} else {
										toInsert.push({ row, sourceRow, rowIndex });
									}
								}

								if (step.mode === "UPSERT" && toUpdate.length) {
									const updateSql = updateColumns.length
										? buildUpdateStatement(tableName, updateColumns, dedupeKeys)
										: null;
									for (const item of toUpdate) {
										const { row, sourceRow, rowIndex } = item;
										try {
											if (updateSql) {
												const updateValues = updateColumns.map((c) => row.mappedRow[c]);
												await conn.beginTransaction();
												await conn.query(updateSql, [...updateValues, ...row.dedupeValues]);
												await conn.commit();
											}
											rowsMigrated += 1;
											rowsUpdated += 1;
											batchUpdated += 1;
											totals.rows_total_migrated += 1;
										} catch (err) {
											try {
												await conn.rollback();
											} catch (rollbackErr) {
												// ignore
											}
											const errorMessage = formatDbError(err, { firebirdConfig });
											await logRowError(sourceRow, rowIndex, errorMessage);
										}
									}
								}

								if (toInsert.length) {
									if (step.keyStrategy === "rekey" && primaryKeys.length) {
										for (const item of toInsert) {
											const { row, sourceRow, rowIndex } = item;
											try {
												await conn.beginTransaction();
												const [result] = await conn.query(sql, [[row.values]]);
												await conn.commit();
												if (ignoreDuplicatesForInsert && result.affectedRows === 0) {
													rowsSkippedDuplicates += 1;
													batchSkipped += 1;
													totals.rows_total_skipped_duplicates += 1;
													continue;
												}
												rowsMigrated += 1;
												rowsInserted += 1;
												batchInserted += 1;
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
													if (onDuplicate === "ERROR") {
														const errorMessage = formatDbError(err, { firebirdConfig });
														await logRowError(sourceRow, rowIndex, errorMessage);
													} else {
														rowsSkippedDuplicates += 1;
														batchSkipped += 1;
														totals.rows_total_skipped_duplicates += 1;
													}
													continue;
												}
												const errorMessage = formatDbError(err, { firebirdConfig });
												await logRowError(sourceRow, rowIndex, errorMessage);
											}
										}
									} else {
										try {
											await conn.beginTransaction();
											const [result] = await conn.query(sql, [toInsert.map((r) => r.row.values)]);
											await conn.commit();
											const totalRows = toInsert.length;
											const affected = Number(result?.affectedRows || 0);

											// MySQL UPSERT: affectedRows = (inserts * 1) + (updates * 2)
											// So if affectedRows > totalRows, some were updates
											let inserted, updated;
											if (step.mode === "UPSERT") {
												// Calculate inserts and updates from affectedRows
												// affected = inserted + (updated * 2)
												// totalRows = inserted + updated
												// Solving: updated = affected - totalRows, inserted = totalRows - updated
												updated = Math.max(affected - totalRows, 0);
												inserted = totalRows - updated;
											} else {
												inserted = affected;
												updated = 0;
											}

											const skipped =
												ignoreDuplicatesForInsert && step.mode !== "UPSERT"
													? Math.max(totalRows - inserted, 0)
													: 0;
											rowsMigrated += inserted + updated;
											rowsInserted += inserted;
											rowsUpdated += updated;
											batchInserted += inserted;
											batchUpdated += updated;
											rowsSkippedDuplicates += skipped;
											batchSkipped += skipped;
											totals.rows_total_migrated += inserted + updated;
											totals.rows_total_skipped_duplicates += skipped;
										} catch (err) {
											try {
												await conn.rollback();
											} catch (rollbackErr) {
												// ignore
											}
											for (const item of toInsert) {
												const { row, sourceRow, rowIndex } = item;
												try {
													await conn.beginTransaction();
													const [result] = await conn.query(sql, [[row.values]]);
													await conn.commit();
													if (ignoreDuplicatesForInsert && result.affectedRows === 0) {
														rowsSkippedDuplicates += 1;
														batchSkipped += 1;
														totals.rows_total_skipped_duplicates += 1;
														continue;
													}
													rowsMigrated += 1;
													rowsInserted += 1;
													batchInserted += 1;
													totals.rows_total_migrated += 1;
												} catch (rowErr) {
													try {
														await conn.rollback();
													} catch (rollbackErr) {
														// ignore
													}
													if (isDuplicateErr(rowErr)) {
														if (onDuplicate === "ERROR") {
															const errorMessage = formatDbError(rowErr, { firebirdConfig });
															await logRowError(sourceRow, rowIndex, errorMessage);
														} else {
															rowsSkippedDuplicates += 1;
															batchSkipped += 1;
															totals.rows_total_skipped_duplicates += 1;
														}
														continue;
													}
													const errorMessage = formatDbError(rowErr, { firebirdConfig });
													await logRowError(sourceRow, rowIndex, errorMessage);
												}
											}
										}
									}
								}
							} else {
								if (step.keyStrategy === "rekey" && primaryKeys.length) {
									for (let rowIndex = 0; rowIndex < rowsToInsert.length; rowIndex += 1) {
										const row = rowsToInsert[rowIndex];
										const sourceRow = batch[rowIndex] || null;
										try {
											await conn.beginTransaction();
											const [result] = await conn.query(sql, [[row.values]]);
											await conn.commit();
											if (ignoreDuplicatesForInsert && result.affectedRows === 0) {
												rowsSkippedDuplicates += 1;
												batchSkipped += 1;
												totals.rows_total_skipped_duplicates += 1;
												continue;
											}
											const affected = Number(result?.affectedRows || 0);
											if (step.mode === "UPSERT" && affected > 1) {
												rowsMigrated += 1;
												rowsUpdated += 1;
												batchUpdated += 1;
												totals.rows_total_migrated += 1;
											} else {
												rowsMigrated += 1;
												rowsInserted += 1;
												batchInserted += 1;
												totals.rows_total_migrated += 1;
											}
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
												if (onDuplicate === "ERROR") {
													const errorMessage = formatDbError(err, { firebirdConfig });
													await logRowError(sourceRow, rowIndex, errorMessage);
												} else {
													rowsSkippedDuplicates += 1;
													batchSkipped += 1;
													totals.rows_total_skipped_duplicates += 1;
												}
												continue;
											}
											const errorMessage = formatDbError(err, { firebirdConfig });
											await logRowError(sourceRow, rowIndex, errorMessage);
										}
									}
								} else {
									try {
										await conn.beginTransaction();
										const [result] = await conn.query(sql, [rowsToInsert.map((r) => r.values)]);
										await conn.commit();
										const totalRows = rowsToInsert.length;
										const affected = Number(result?.affectedRows || 0);
										const updated = step.mode === "UPSERT" ? Math.max(affected - totalRows, 0) : 0;
										const inserted = step.mode === "UPSERT"
											? Math.max(totalRows - updated, 0)
											: affected;
										const skipped =
											ignoreDuplicatesForInsert && step.mode !== "UPSERT"
												? Math.max(totalRows - inserted, 0)
												: 0;
										rowsMigrated += inserted + updated;
										rowsInserted += inserted;
										rowsUpdated += updated;
										batchInserted += inserted;
										batchUpdated += updated;
										rowsSkippedDuplicates += skipped;
										batchSkipped += skipped;
										totals.rows_total_migrated += inserted + updated;
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
												if (ignoreDuplicatesForInsert && result.affectedRows === 0) {
													rowsSkippedDuplicates += 1;
													batchSkipped += 1;
													totals.rows_total_skipped_duplicates += 1;
													continue;
												}
												rowsMigrated += 1;
												rowsInserted += 1;
												batchInserted += 1;
												totals.rows_total_migrated += 1;
											} catch (rowErr) {
												try {
													await conn.rollback();
												} catch (rollbackErr) {
													// ignore
												}
												if (isDuplicateErr(rowErr)) {
													if (onDuplicate === "ERROR") {
														const errorMessage = formatDbError(rowErr, { firebirdConfig });
														await logRowError(sourceRow, rowIndex, errorMessage);
													} else {
														rowsSkippedDuplicates += 1;
														batchSkipped += 1;
														totals.rows_total_skipped_duplicates += 1;
													}
													continue;
												}
												const errorMessage = formatDbError(rowErr, { firebirdConfig });
												await logRowError(sourceRow, rowIndex, errorMessage);
											}
										}
									}
								}
							}
						} else {
							rowsMigrated += rowsToInsert.length;
							rowsInserted += rowsToInsert.length;
							batchInserted += rowsToInsert.length;
							totals.rows_total_migrated += rowsToInsert.length;
						}

						logRun({
							level: "debug",
							phase: "write",
							tableName,
							tableRunId,
							status: "end",
							inserted: batchInserted,
							updated: batchUpdated,
							skipped: batchSkipped,
							durationMs: Date.now() - batchStart
						});

						offset += rowsToInsert.length;

						await runStore.updateTableProgress(pool, runId, tableName, {
							last_offset: offset,
							rows_migrated: rowsMigrated,
							rows_error: rowsError,
							rows_skipped_duplicates: rowsSkippedDuplicates
						});
						tableState.migrated = rowsMigrated;
						tableState.inserted = rowsInserted;
						tableState.updated = rowsUpdated;
						tableState.errors = rowsError;
						tableState.skippedDuplicates = rowsSkippedDuplicates;
						emitRunState(runId, emitter);
					}

					if (rowsError > 0) {
						const errorMessage = `Table ${tableName} completed with ${rowsError} errors.`;
						await runStore.finishTableRun(pool, runId, tableName, "failed", errorMessage);
						await failRun(errorMessage, "Fix the row errors, then run the migration again.", "validate");
						break;
					}

					// Post-table validation for spares_used
					if (tableName === "spares_used") {
						logRun({ level: "info", phase: "post_validation", tableName, tableRunId, status: "start" });
						try {
							// Use comprehensive validation with zero-loss tolerance
							await validateMigrationIntegrity(
								pool,
								firebirdConfig,
								tableName,
								sourceTable,
								{
									readRows: offset,
									insertedRows: rowsInserted,
									updatedRows: rowsUpdated,
									skippedRows: rowsSkippedDuplicates,
									errorRows: rowsError
								},
								logRun
							);

							// Check price fields: ensure cost_price and sales_price were migrated correctly
							const [priceCheck] = await pool.query(`
							SELECT 
								COUNT(*) as total_rows,
								COUNT(CASE WHEN cost_price = 0 AND sales_price = 0 THEN 1 END) as zero_price_count,
								COUNT(CASE WHEN cost_price > 0 OR sales_price > 0 THEN 1 END) as nonzero_price_count
							FROM \`${tableName}\`
						`);

							// Query Firebird to check if source has non-zero prices
							const sourceNonZeroCount = await firebird.query(firebirdConfig, `
							SELECT COUNT(*) as cnt 
							FROM ${sourceTable}
							WHERE COST_PRICE > 0 OR SALES_PRICE > 0
						`);
							const fbNonZeroCount = sourceNonZeroCount[0]?.cnt || sourceNonZeroCount[0]?.CNT || 0;

							const mysqlTotal = priceCheck[0]?.total_rows || 0;
							const mysqlZeroPrice = priceCheck[0]?.zero_price_count || 0;
							const mysqlNonZeroPrice = priceCheck[0]?.nonzero_price_count || 0;

							logRun({
								level: "info",
								phase: "post_validation",
								tableName,
								tableRunId,
								validation: "price_check",
								firebird_nonzero: fbNonZeroCount,
								mysql_total: mysqlTotal,
								mysql_zero: mysqlZeroPrice,
								mysql_nonzero: mysqlNonZeroPrice
							});

							// If Firebird has many non-zero prices but MySQL has mostly zeros, fail
							if (fbNonZeroCount > 50 && mysqlNonZeroPrice < fbNonZeroCount * 0.5) {
								const errorMessage = `Validation failed for spares_used: Price fields not migrated correctly. Firebird has ${fbNonZeroCount} rows with non-zero prices, but MySQL only has ${mysqlNonZeroPrice}. Likely mapping is missing COST_PRICE/SALES_PRICE columns or transform is coercing nulls to 0.`;
								await runStore.finishTableRun(pool, runId, tableName, "failed", errorMessage);
								await failRun(errorMessage, "Check mapping includes COST_PRICE and SALES_PRICE columns with toNumber transform (which preserves nulls).", "post_validation");
								break;
							}

							logRun({ level: "info", phase: "post_validation", tableName, tableRunId, status: "passed" });
						} catch (validationErr) {
							logRun({ level: "warn", phase: "post_validation", tableName, tableRunId, status: "error", error: validationErr?.message });
							// Don't fail the migration for validation errors, just log them
						}
					}

					const durationMs = Date.now() - tableStart;
					await runStore.finishTableRun(pool, runId, tableName, "success");
					tableState.status = "SUCCESS";
					tableState.durationMs = durationMs;
					tableState.inserted = rowsInserted;
					tableState.updated = rowsUpdated;
					logRun({
						level: "info",
						phase: "table_finalize",
						tableName,
						tableRunId,
						status: "success",
						inserted: rowsInserted,
						updated: rowsUpdated,
						skipped: rowsSkippedDuplicates,
						errors: rowsError,
						durationMs
					});
					emitRunState(runId, emitter);
				} finally {
					conn.release();
					if (tempIndexName) {
						try {
							await mysql.dropIndex(pool, tableName, tempIndexName);
						} catch (err) {
							// ignore
						}
					}
				}

				if (runFailed) break;
			}

			if (runFailed) {
				await runStore.finishRun(pool, runId, "FAILED", failureInfo?.errorMessage || null);
				logRun({ level: "error", phase: "run_finalize", status: "failed", error: failureInfo?.errorMessage || null });
				emitRunState(runId, emitter);
			} else {
				runState.status = "SUCCESS";
				runState.finishedAt = new Date().toISOString();
				await runStore.finishRun(pool, runId, "SUCCESS");
				logRun({ level: "info", phase: "run_finalize", status: "success" });
				emitRunState(runId, emitter);
			}
		} finally {
			// Always restore FK_CHECKS state, even on error
			if (fkChecks && !originalFkState) {
				try {
					await pool.query("SET FOREIGN_KEY_CHECKS=1");
					logRun({
						level: 'info',
						phase: 'cleanup',
						action: 'foreign_key_checks_restored',
						restored_state: 1
					});
				} catch (err) {
					logRun({
						level: 'error',
						phase: 'cleanup',
						action: 'foreign_key_checks_restore_failed',
						error: err.message
					});
					throw new Error('Failed to restore FOREIGN_KEY_CHECKS=1. Database may be in inconsistent state.');
				}
			}
		}
	} catch (err) {
		console.error('[Runner] Migration error caught:', err);
		const errorMessage = formatDbError(err, { firebirdConfig });
		const hint = getDbErrorHint(errorMessage);
		logRun({ level: 'error', phase: 'run_error', error: errorMessage, stack: err?.stack?.split('\n').slice(0, 5).join('\n') });
		runState.status = "FAILED";
		runState.finishedAt = new Date().toISOString();
		if (runState.currentTable) {
			const tableState = tableStateMap.get(runState.currentTable);
			if (tableState) {
				tableState.status = "FAILED";
				tableState.lastError = { message: errorMessage, hint, phase: "run" };
			}
			try {
				await runStore.finishTableRun(pool, runId, runState.currentTable, "failed", errorMessage);
			} catch (finishErr) {
				// ignore
			}
		}
		if (!runState.currentTable) {
			runState.lastError = { message: errorMessage, hint, phase: "preflight" };
		}
		markRemainingNotRun(runState.currentTable);
		await runStore.finishRun(pool, runId, "FAILED", errorMessage);
		emitRunState(runId, emitter);
	} finally {
		runAbortFlags.delete(runId);
		if (keepaliveTimer) {
			clearInterval(keepaliveTimer);
			keepaliveTimer = null;
		}
		await pool.end();
		logger.closeRunLogger(runId);
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
	getRunState,
	requestAbort,
	isRunActive
};
