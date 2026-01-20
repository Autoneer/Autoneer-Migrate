const firebird = require("../../db/firebird");
const mysql = require("../../db/mysql");
const fs = require("fs").promises;
const path = require("path");

/**
 * In-memory representation of Firebird and MySQL schemas
 * Cached after first discovery for performance
 * 
 * Structure:
 * Schema.firebird.tables['CUSTOMER'] = {
 *   name: 'CUSTOMER',
 *   columns: {
 *     'CID': { name: 'CID', type: 'INTEGER', nullable: false, ... },
 *     'NAME': { name: 'NAME', type: 'VARCHAR', length: 255, ... }
 *   },
 *   primaryKey: ['CID'],
 *   uniqueIndexes: [...]
 * }
 */

class Schema {
	constructor() {
		this.firebird = { tables: {}, lastUpdated: null };
		this.mysql = { tables: {}, lastUpdated: null };
	}

	/**	 * Discover schemas from both Firebird and MySQL databases
	 * @param {Object} firebirdConfig
	 * @param {Object} mysqlConfig
	 * @param {string} schemaName - MySQL schema/database name
	 * @returns {Promise<void>}
	 */
	async discover(firebirdConfig, mysqlConfig, schemaName) {
		// Discover both schemas in parallel
		await Promise.all([
			this.discoverFirebird(firebirdConfig),
			this.discoverMySQL(mysqlConfig, schemaName)
		]);
	}

	/**	 * Discover Firebird schema by querying RDB$RELATIONS
	 * @param {Object} firebirdConfig
	 * @returns {Promise<void>}
	 */
	async discoverFirebird(firebirdConfig) {
		const db = await firebird.attach(firebirdConfig);

		// Helper to promisify db.query
		const query = (sql, params = []) => {
			return new Promise((resolve, reject) => {
				db.query(sql, params, (err, result) => {
					if (err) return reject(err);
					resolve(result);
				});
			});
		};

		try {
			// Get all user tables
			const tablesQuery = `
				SELECT TRIM(RDB$RELATION_NAME) AS TABLE_NAME
				FROM RDB$RELATIONS
				WHERE RDB$SYSTEM_FLAG = 0
				AND RDB$VIEW_BLR IS NULL
				ORDER BY RDB$RELATION_NAME
			`;

			const tables = await query(tablesQuery);

			for (const tableRow of tables) {
				if (!tableRow || !tableRow.TABLE_NAME) continue;
				const tableName = tableRow.TABLE_NAME.toUpperCase();

				// Get columns for this table
				const columnsQuery = `
					SELECT
						TRIM(rf.RDB$FIELD_NAME) AS COLUMN_NAME,
						TRIM(f.RDB$FIELD_TYPE) AS FIELD_TYPE,
						f.RDB$FIELD_SUB_TYPE AS FIELD_SUB_TYPE,
						f.RDB$FIELD_LENGTH AS FIELD_LENGTH,
						f.RDB$FIELD_PRECISION AS FIELD_PRECISION,
						f.RDB$FIELD_SCALE AS FIELD_SCALE,
						rf.RDB$NULL_FLAG AS NULL_FLAG,
						rf.RDB$DEFAULT_SOURCE AS DEFAULT_SOURCE
					FROM RDB$RELATION_FIELDS rf
					JOIN RDB$FIELDS f ON rf.RDB$FIELD_SOURCE = f.RDB$FIELD_NAME
					WHERE rf.RDB$RELATION_NAME = ?
					ORDER BY rf.RDB$FIELD_POSITION
				`;

				const columns = await query(columnsQuery, [tableName]);

				// Get primary key
				const pkQuery = `
					SELECT TRIM(sg.RDB$FIELD_NAME) AS COLUMN_NAME
					FROM RDB$RELATION_CONSTRAINTS rc
					JOIN RDB$INDEX_SEGMENTS sg ON rc.RDB$INDEX_NAME = sg.RDB$INDEX_NAME
					WHERE rc.RDB$RELATION_NAME = ?
					AND rc.RDB$CONSTRAINT_TYPE = 'PRIMARY KEY'
					ORDER BY sg.RDB$FIELD_POSITION
				`;

				const pkRows = await query(pkQuery, [tableName]);
				const columnMap = {};
				for (const col of columns) {
					if (!col || !col.COLUMN_NAME) continue; const columnName = col.COLUMN_NAME.toUpperCase();
					columnMap[columnName] = {
						name: columnName,
						type: this._mapFirebirdType(col),
						nullable: col.NULL_FLAG !== 1,
						defaultValue: col.DEFAULT_SOURCE ? col.DEFAULT_SOURCE.trim() : null,
						length: col.FIELD_LENGTH,
						precision: col.FIELD_PRECISION,
						scale: col.FIELD_SCALE
					};
				}

				this.firebird.tables[tableName] = {
					name: tableName,
					columns: columnMap,
					primaryKey: primaryKey,
					uniqueIndexes: []
				};
			}

			this.firebird.lastUpdated = new Date();
		} finally {
			db.detach();
		}
	}

	/**
	 * Discover MySQL schema from information_schema
	 * @param {Object} mysqlConfig
	 * @param {string} schemaName
	 * @returns {Promise<void>}
	 */
	async discoverMySQL(mysqlConfig, schemaName) {
		const db = await mysql.connectToSchema(mysqlConfig, schemaName);

		try {
			// Get all tables
			const tablesQuery = `
				SELECT TABLE_NAME
				FROM information_schema.TABLES
				WHERE TABLE_SCHEMA = ?
				AND TABLE_TYPE = 'BASE TABLE'
				ORDER BY TABLE_NAME
			`;

			const [tables] = await db.query(tablesQuery, [schemaName]);

			for (const tableRow of tables) {
				const tableName = tableRow.TABLE_NAME.toUpperCase();

				// Get columns for this table
				const columnsQuery = `
					SELECT
						COLUMN_NAME,
						DATA_TYPE,
						COLUMN_TYPE,
						IS_NULLABLE,
						COLUMN_DEFAULT,
						CHARACTER_MAXIMUM_LENGTH,
						NUMERIC_PRECISION,
						NUMERIC_SCALE,
						COLUMN_KEY
					FROM information_schema.COLUMNS
					WHERE TABLE_SCHEMA = ?
					AND TABLE_NAME = ?
					ORDER BY ORDINAL_POSITION
				`;

				const [columns] = await db.query(columnsQuery, [schemaName, tableRow.TABLE_NAME]);

				// Get primary key
				const pkQuery = `
					SELECT COLUMN_NAME
					FROM information_schema.KEY_COLUMN_USAGE
					WHERE TABLE_SCHEMA = ?
					AND TABLE_NAME = ?
					AND CONSTRAINT_NAME = 'PRIMARY'
					ORDER BY ORDINAL_POSITION
				`;

				const [pkRows] = await db.query(pkQuery, [schemaName, tableRow.TABLE_NAME]);
				const primaryKey = pkRows.map(row => row.COLUMN_NAME.toUpperCase());

				// Build column metadata
				const columnMap = {};
				for (const col of columns) {
					const columnName = col.COLUMN_NAME.toUpperCase();
					columnMap[columnName] = {
						name: columnName,
						type: col.DATA_TYPE.toUpperCase(),
						columnType: col.COLUMN_TYPE,
						nullable: col.IS_NULLABLE === 'YES',
						defaultValue: col.COLUMN_DEFAULT,
						length: col.CHARACTER_MAXIMUM_LENGTH,
						precision: col.NUMERIC_PRECISION,
						scale: col.NUMERIC_SCALE,
						isPrimaryKey: col.COLUMN_KEY === 'PRI',
						isUnique: col.COLUMN_KEY === 'UNI'
					};
				}

				this.mysql.tables[tableName] = {
					name: tableName,
					columns: columnMap,
					primaryKey: primaryKey,
					uniqueIndexes: []
				};
			}

			this.mysql.lastUpdated = new Date();
		} finally {
			await db.end();
		}
	}

	/**
	 * Check if schema has been cached recently
	 * @param {number} maxAgeMs - Max cache age in milliseconds (default: 5 minutes)
	 * @returns {boolean}
	 */
	isCached(maxAgeMs = 300000) {
		const now = Date.now();

		if (!this.firebird.lastUpdated || !this.mysql.lastUpdated) {
			return false;
		}

		const firebirdAge = now - this.firebird.lastUpdated.getTime();
		const mysqlAge = now - this.mysql.lastUpdated.getTime();

		return firebirdAge < maxAgeMs && mysqlAge < maxAgeMs;
	}

	/**
	 * Serialize to disk cache
	 * @param {string} filepath
	 */
	async saveCache(filepath) {
		const data = {
			firebird: {
				tables: this.firebird.tables,
				lastUpdated: this.firebird.lastUpdated?.toISOString()
			},
			mysql: {
				tables: this.mysql.tables,
				lastUpdated: this.mysql.lastUpdated?.toISOString()
			}
		};

		await fs.mkdir(path.dirname(filepath), { recursive: true });
		await fs.writeFile(filepath, JSON.stringify(data, null, 2), 'utf8');
	}

	/**
	 * Load from disk cache
	 * @param {string} filepath
	 * @returns {Promise<boolean>} - True if loaded successfully
	 */
	async loadCache(filepath) {
		try {
			const data = await fs.readFile(filepath, 'utf8');
			const parsed = JSON.parse(data);

			this.firebird.tables = parsed.firebird.tables || {};
			this.firebird.lastUpdated = parsed.firebird.lastUpdated
				? new Date(parsed.firebird.lastUpdated)
				: null;

			this.mysql.tables = parsed.mysql.tables || {};
			this.mysql.lastUpdated = parsed.mysql.lastUpdated
				? new Date(parsed.mysql.lastUpdated)
				: null;

			return true;
		} catch (err) {
			// Cache file doesn't exist or is invalid
			return false;
		}
	}

	/**
	 * Get table metadata
	 * @param {'firebird'|'mysql'} db
	 * @param {string} tableName
	 * @returns {Object|null}
	 */
	getTable(db, tableName) {
		return this[db]?.tables?.[tableName.toUpperCase()] || null;
	}

	/**
	 * Get column metadata
	 * @param {'firebird'|'mysql'} db
	 * @param {string} tableName
	 * @param {string} columnName
	 * @returns {Object|null}
	 */
	getColumn(db, tableName, columnName) {
		const table = this.getTable(db, tableName);
		return table?.columns?.[columnName.toUpperCase()] || null;
	}

	/**
	 * Check if table exists
	 * @param {'firebird'|'mysql'} db
	 * @param {string} tableName
	 * @returns {boolean}
	 */
	tableExists(db, tableName) {
		return this.getTable(db, tableName) !== null;
	}

	/**
	 * Get all table names
	 * @param {'firebird'|'mysql'} db
	 * @returns {string[]}
	 */
	getTableNames(db) {
		return Object.keys(this[db]?.tables || {});
	}

	/**
	 * Map Firebird data type to generic type name
	 * @private
	 */
	_mapFirebirdType(col) {
		const typeMap = {
			7: 'SMALLINT',
			8: 'INTEGER',
			10: 'FLOAT',
			12: 'DATE',
			13: 'TIME',
			14: 'CHAR',
			16: 'BIGINT',
			27: 'DOUBLE',
			35: 'TIMESTAMP',
			37: 'VARCHAR',
			261: 'BLOB'
		};

		let type = typeMap[col.FIELD_TYPE] || 'UNKNOWN';

		// Handle numeric with precision
		if (col.FIELD_TYPE === 16 && col.FIELD_SUB_TYPE === 1) {
			type = 'NUMERIC';
		} else if (col.FIELD_TYPE === 16 && col.FIELD_SUB_TYPE === 2) {
			type = 'DECIMAL';
		}

		return type;
	}

	/**
	 * Serialize to JSON
	 */
	toJSON() {
		return {
			firebird: {
				tables: this.firebird.tables,
				lastUpdated: this.firebird.lastUpdated?.toISOString()
			},
			mysql: {
				tables: this.mysql.tables,
				lastUpdated: this.mysql.lastUpdated?.toISOString()
			}
		};
	}

	/**
	 * Create from JSON
	 */
	static fromJSON(obj) {
		const schema = new Schema();
		schema.firebird.tables = obj.firebird?.tables || {};
		schema.firebird.lastUpdated = obj.firebird?.lastUpdated
			? new Date(obj.firebird.lastUpdated)
			: null;
		schema.mysql.tables = obj.mysql?.tables || {};
		schema.mysql.lastUpdated = obj.mysql?.lastUpdated
			? new Date(obj.mysql.lastUpdated)
			: null;
		return schema;
	}
}

module.exports = Schema;
