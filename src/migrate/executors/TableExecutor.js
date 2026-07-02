const firebird = require('../../db/firebird');
const mysql = require('../../db/mysql');
const { applyTransform } = require('../mappers');
const { applyMigrationMarker } = require('../migrationMarkers');

/**
 * Table executor - migrates a single table
 * Handles reading from source, transforming, and writing to target
 */

class TableExecutor {
	/**
	 * @param {Object} tableConfig - From Plan
	 * @param {string} sourceTable - Firebird table
	 * @param {string} targetTable - MySQL table
	 * @param {Mapping} mapping
	 * @param {Schema} schema
	 * @param {Object} connections - { firebird, mysql }
	 * @param {Object} logger
	 */
	constructor(tableConfig, sourceTable, targetTable, mapping, schema, connections, logger) {
		this.tableConfig = tableConfig;
		this.sourceTable = sourceTable;
		this.targetTable = targetTable;
		this.mapping = mapping;
		this.schema = schema;
		this.connections = connections;
		this.logger = logger;

		this.stats = {
			inserted: 0,
			updated: 0,
			skipped: 0,
			errors: 0,
			cleaned: 0
		};
	}

	/**
	 * Execute migration for this table
	 * @param {Object} options - { batchSize, dryRun }
	 * @returns {Promise<{ inserted: number, updated: number, skipped: number, errors: number }>}
	 */
	async execute(options = {}) {
		let { batchSize = 500, dryRun = false } = options;

		// Defensive clamping: ensure batchSize is a sane positive integer
		batchSize = Number(batchSize) || 500;
		if (Number.isNaN(batchSize) || !isFinite(batchSize)) batchSize = 500;
		batchSize = Math.min(Math.max(Math.floor(batchSize), 1), 10000);

		this.logger?.log({
			level: 'info',
			phase: 'table_start',
			table: this.targetTable,
			mode: this.tableConfig.mode,
			strategy: this.tableConfig.keyStrategy
		});

		try {
			// 1. Pre-check
			await this.preCheck();

			// 2. Clean if needed
			if (this.tableConfig.cleanBefore && !dryRun) {
				await this.clean();
			}

			// 3. Migrate in batches (using clamped batch size)
			await this.migrateInBatches(batchSize, dryRun);

			// 4. Post-validation (if implemented)
			// await this.postValidate(this.stats);

			this.logger?.log({
				level: 'info',
				phase: 'table_end',
				table: this.targetTable,
				...this.stats
			});

			return this.stats;
		} catch (err) {
			this.logger?.log({
				level: 'error',
				phase: 'table_error',
				table: this.targetTable,
				error: err.message
			});
			throw err;
		}
	}

	/**
	 * Pre-check: verify table and columns exist
	 * @returns {Promise<void>}
	 */
	async preCheck() {
		// Verify source table exists
		if (!this.schema.tableExists('firebird', this.sourceTable)) {
			throw new Error(`Source table not found: ${this.sourceTable}`);
		}

		// Verify target table exists
		if (!this.schema.tableExists('mysql', this.targetTable)) {
			throw new Error(`Target table not found: ${this.targetTable}`);
		}

		// Verify field maps exist
		const fieldMaps = this.mapping.getFieldMaps(this.sourceTable);
		if (!fieldMaps || fieldMaps.size === 0) {
			throw new Error(`No field mappings found for ${this.sourceTable}`);
		}
	}

	/**
	 * Clean target table before migration
	 * @returns {Promise<void>}
	 */
	async clean() {
		this.logger?.log({
			level: 'info',
			phase: 'table_clean',
			table: this.targetTable,
			action: 'start'
		});

		let pool = this.connections.mysql;
		let conn = pool;
		let releaseConn = false;
		try {
			if (typeof pool.getConnection === 'function') {
				conn = await pool.getConnection();
				releaseConn = true;
			}

			let fkDisabled = false;
			try {
				// Attempt to disable FK checks for this session (best-effort)
				try {
					await conn.query('SET FOREIGN_KEY_CHECKS=0');
					fkDisabled = true;
					this.logger?.log({ level: 'debug', phase: 'table_clean', table: this.targetTable, action: 'fk_checks_disabled' });
				} catch (e) {
					// ignore - continue
					this.logger?.log({ level: 'warn', phase: 'table_clean', table: this.targetTable, action: 'fk_disable_failed', error: e.message });
				}

				// Prefer TRUNCATE, fallback to DELETE
				let method = 'TRUNCATE';
				let affectedRows = null;
				try {
					await conn.query(`truncate table \`${this.targetTable}\``);
				} catch (truncateErr) {
					method = 'DELETE';
					const [result] = await conn.query(`delete from \`${this.targetTable}\``);
					affectedRows = Number(result?.affectedRows || 0);
				}

				// Post-clean verification
				let postCount = null;
				try {
					const [rows] = await conn.query(`select count(*) as cnt from \`${this.targetTable}\``);
					postCount = Number(rows[0]?.cnt || 0);
				} catch (e) {
					this.logger?.log({ level: 'warn', phase: 'table_clean', table: this.targetTable, action: 'post_clean_count_failed', error: e.message });
				}

				this.stats.cleaned = affectedRows || 0;
				this.logger?.log({ level: 'info', phase: 'table_clean', table: this.targetTable, action: 'complete', method, affectedRows, postCount });

				if (typeof postCount === 'number' && postCount > 0) {
					throw new Error(`Post-clean verification failed: ${postCount} rows remain in ${this.targetTable}`);
				}
			} finally {
				if (fkDisabled) {
					try {
						await conn.query('SET FOREIGN_KEY_CHECKS=1');
						this.logger?.log({ level: 'debug', phase: 'table_clean', table: this.targetTable, action: 'fk_checks_restored' });
					} catch (e) {
						this.logger?.log({ level: 'error', phase: 'table_clean', table: this.targetTable, action: 'fk_restore_failed', error: e.message });
					}
				}
			}
		} finally {
			if (releaseConn && conn && typeof conn.release === 'function') {
				try { await conn.release(); } catch (e) { /* ignore */ }
			}
		}
	}

	/**
	 * Migrate data in batches
	 * @param {number} batchSize
	 * @param {boolean} dryRun
	 * @returns {Promise<void>}
	 */
	async migrateInBatches(batchSize, dryRun) {
		const fieldMaps = this.mapping.getFieldMaps(this.sourceTable);

		// Build source query
		const sourceColumns = Array.from(fieldMaps.keys());
		const query = `SELECT ${sourceColumns.join(', ')} FROM ${this.sourceTable}`;

		this.logger?.log({
			level: 'info',
			phase: 'table_fetch',
			table: this.sourceTable,
			query: query
		});

		// Fetch all rows from Firebird
		const sourceRows = await firebird.query(this.connections.firebird, query);

		this.logger?.log({
			level: 'info',
			phase: 'table_fetch',
			table: this.sourceTable,
			rowCount: sourceRows.length
		});

		// Process in batches
		for (let i = 0; i < sourceRows.length; i += batchSize) {
			const batch = sourceRows.slice(i, i + batchSize);
			await this.processBatch(batch, fieldMaps, dryRun);

			this.logger?.log({
				level: 'info',
				phase: 'batch_complete',
				table: this.targetTable,
				batchStart: i + 1,
				batchEnd: Math.min(i + batchSize, sourceRows.length),
				totalRows: sourceRows.length
			});
		}
	}

	/**
	 * Process a single batch of rows
	 * @param {Array} rows
	 * @param {Map} fieldMaps
	 * @param {boolean} dryRun
	 * @returns {Promise<void>}
	 */
	async processBatch(rows, fieldMaps, dryRun) {
		const transformedRows = [];

		// Transform each row
		for (const sourceRow of rows) {
			try {
				const transformedRow = this.transformRow(sourceRow, fieldMaps);
				transformedRows.push(transformedRow);
			} catch (err) {
				this.logger?.log({
					level: 'error',
					phase: 'transform_error',
					table: this.sourceTable,
					error: err.message,
					row: sourceRow
				});
				this.stats.errors++;
			}
		}

		// Insert into MySQL
		if (!dryRun && transformedRows.length > 0) {
			try {
				const insertCount = await this.insertBatch(transformedRows, fieldMaps);
				this.stats.inserted += insertCount;
			} catch (err) {
				this.logger?.log({
					level: 'error',
					phase: 'insert_error',
					table: this.targetTable,
					error: err.message
				});
				this.stats.errors += transformedRows.length;
				throw err;
			}
		} else if (dryRun) {
			this.stats.inserted += transformedRows.length;
		}
	}

	/**
	 * Transform a single row using field maps
	 * @param {Object} sourceRow
	 * @param {Map} fieldMaps
	 * @returns {Object}
	 */
	transformRow(sourceRow, fieldMaps) {
		const transformedRow = {};

		for (const [sourceCol, fieldMap] of fieldMaps) {
			// Skip omitted fields
			if (fieldMap.omit) {
				continue;
			}

			let value = sourceRow[sourceCol.toLowerCase()] ?? sourceRow[sourceCol.toUpperCase()];

			// Apply default if null
			if ((value === null || value === undefined) && fieldMap.defaultValue !== null) {
				value = fieldMap.defaultValue;
			}

			// Apply transform
			if (fieldMap.transform && value !== null && value !== undefined) {
				try {
					value = applyTransform(fieldMap.transform, value);
				} catch (err) {
					throw new Error(`Transform ${fieldMap.transform} failed on ${sourceCol}: ${err.message}`);
				}
			}

			const targetColumn = fieldMap.targetColumn.toLowerCase();
			transformedRow[targetColumn] = applyMigrationMarker(this.targetTable, targetColumn, value);
		}

		return transformedRow;
	}

	/**
	 * Insert a batch of rows into MySQL
	 * @param {Array} rows
	 * @param {Map} fieldMaps
	 * @returns {Promise<number>} - Number of rows inserted
	 */
	async insertBatch(rows, fieldMaps) {
		if (rows.length === 0) return 0;

		// Get target columns from field maps (excludes omitted fields)
		const targetColumns = Array.from(fieldMaps.values())
			.filter(fm => !fm.omit)  // Exclude omitted fields
			.map(fm => fm.targetColumn.toLowerCase());

		// Build INSERT query
		const placeholders = rows.map(() =>
			`(${targetColumns.map(() => '?').join(', ')})`
		).join(', ');

		const query = `INSERT INTO ${this.targetTable} (${targetColumns.join(', ')}) VALUES ${placeholders}`;

		// Flatten values
		const values = rows.flatMap(row =>
			targetColumns.map(col => row[col])
		);

		// Execute
		const [result] = await this.connections.mysql.query(query, values);

		return result.affectedRows || 0;
	}

	/**
	 * Post-validation (checksums, row counts, etc.)
	 * @param {Object} stats
	 * @returns {Promise<void>}
	 */
	async postValidate(stats) {
		// TODO: Implement checksum validation
		// Compare row counts
		const sourceCount = await this.getSourceRowCount();
		const targetCount = await this.getTargetRowCount();

		this.logger?.log({
			level: 'info',
			phase: 'validation',
			table: this.targetTable,
			sourceRows: sourceCount,
			targetRows: targetCount,
			match: sourceCount === targetCount
		});

		if (sourceCount !== targetCount) {
			throw new Error(
				`Row count mismatch: source=${sourceCount}, target=${targetCount}`
			);
		}
	}

	/**
	 * Get source table row count
	 * @returns {Promise<number>}
	 */
	async getSourceRowCount() {
		const result = await firebird.query(
			this.connections.firebird,
			`SELECT COUNT(*) AS cnt FROM ${this.sourceTable}`
		);
		return result[0]?.CNT || 0;
	}

	/**
	 * Get target table row count
	 * @returns {Promise<number>}
	 */
	async getTargetRowCount() {
		const [result] = await this.connections.mysql.query(
			`SELECT COUNT(*) AS cnt FROM ${this.targetTable}`
		);
		return result[0]?.cnt || 0;
	}
}

module.exports = TableExecutor;
