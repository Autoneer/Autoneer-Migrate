const PlanValidator = require('../validators/PlanValidator');
const firebird = require('../../db/firebird');
const mysql = require('../../db/mysql');

/**
 * Preflight executor - runs pre-migration checks
 * Ensures connectivity, schema validity, and configuration correctness
 */

class PreflightExecutor {
	/**
	 * @param {Object} firebirdConfig
	 * @param {Object} mysqlConfig
	 * @param {string} schemaName
	 * @param {Object} logger
	 */
	constructor(firebirdConfig, mysqlConfig, schemaName, logger) {
		this.firebirdConfig = firebirdConfig;
		this.mysqlConfig = mysqlConfig;
		this.schemaName = schemaName;
		this.logger = logger;
	}

	/**
	 * Run all preflight checks
	 * @param {Plan} plan
	 * @param {Mapping} mapping
	 * @param {Schema} schema
	 * @returns {Promise<{ pass: bool, errors: [], warnings: [] }>}
	 */
	async execute(plan, mapping, schema) {
		const errors = [];
		const warnings = [];

		this.logger?.log({ level: 'info', phase: 'preflight', action: 'start' });

		try {
			// 1. Validate connectivity
			await this.checkConnectivity();
			this.logger?.log({ level: 'info', phase: 'preflight', action: 'connectivity', status: 'pass' });
		} catch (err) {
			errors.push(`Connectivity failed: ${err.message}`);
			return { pass: false, errors, warnings };
		}

		try {
			// 2. Validate plan against mapping + schema
			const planValidation = await PlanValidator.validate(plan, mapping, schema);
			if (!planValidation.canProceed) {
				errors.push(...planValidation.blockers);
			}
			warnings.push(...planValidation.warnings);

			if (!planValidation.canProceed) {
				return { pass: false, errors, warnings };
			}

			this.logger?.log({ level: 'info', phase: 'preflight', action: 'schema_validation', status: 'pass' });
		} catch (err) {
			errors.push(`Schema validation failed: ${err.message}`);
			return { pass: false, errors, warnings };
		}

		// 3. Check configuration issues
		try {
			const configCheck = PlanValidator.checkConfigurationIssues(plan);
			if (configCheck.issues.length > 0) {
				warnings.push(...configCheck.issues);
			}

			this.logger?.log({ level: 'info', phase: 'preflight', action: 'config_check', status: 'pass' });
		} catch (err) {
			warnings.push(`Configuration check warning: ${err.message}`);
		}

		// 4. Check foreign key state
		try {
			const fkState = await this.checkForeignKeyState();
			if (!fkState.enabled) {
				warnings.push('Foreign key checks are disabled. This may cause data integrity issues.');
			}
			this.logger?.log({ level: 'info', phase: 'preflight', action: 'fk_check', status: 'pass', enabled: fkState.enabled });
		} catch (err) {
			warnings.push(`Foreign key check warning: ${err.message}`);
		}

		// 5. Check schema freshness
		if (!schema.isCached(3600000)) { // 1 hour
			warnings.push('Schema cache is stale or missing. Consider refreshing schemas before migration.');
		}

		return {
			pass: errors.length === 0,
			errors,
			warnings
		};
	}

	/**
	 * Check connectivity to both databases
	 * @returns {Promise<void>}
	 */
	async checkConnectivity() {
		// Test Firebird connection
		try {
			const fbDb = await firebird.getConnection(this.firebirdConfig);
			await firebird.detach(fbDb);
		} catch (err) {
			throw new Error(`Firebird connection failed: ${err.message}`);
		}

		// Test MySQL connection
		try {
			const mysqlConn = await mysql.getConnection(this.mysqlConfig);
			await mysqlConn.end();
		} catch (err) {
			throw new Error(`MySQL connection failed: ${err.message}`);
		}
	}

	/**
	 * Check MySQL foreign key state
	 * @returns {Promise<{ enabled: bool }>}
	 */
	async checkForeignKeyState() {
		const conn = await mysql.getConnection(this.mysqlConfig);

		try {
			const [rows] = await conn.query('SELECT @@foreign_key_checks AS fk_enabled');
			return {
				enabled: rows[0]?.fk_enabled === 1
			};
		} finally {
			await conn.end();
		}
	}

	/**
	 * Get database stats for reporting
	 * @returns {Promise<Object>}
	 */
	async getDatabaseStats() {
		const stats = {
			firebird: {},
			mysql: {}
		};

		// Firebird stats
		try {
			const fbDb = await firebird.getConnection(this.firebirdConfig);
			try {
				const tables = await firebird.query(fbDb, `
					SELECT COUNT(*) AS table_count
					FROM RDB$RELATIONS
					WHERE RDB$SYSTEM_FLAG = 0
					AND RDB$VIEW_BLR IS NULL
				`);
				stats.firebird.tableCount = tables[0]?.TABLE_COUNT || 0;
			} finally {
				await firebird.detach(fbDb);
			}
		} catch (err) {
			stats.firebird.error = err.message;
		}

		// MySQL stats
		try {
			const mysqlConn = await mysql.getConnection(this.mysqlConfig);
			try {
				const [tables] = await mysqlConn.query(`
					SELECT COUNT(*) AS table_count
					FROM information_schema.TABLES
					WHERE TABLE_SCHEMA = ?
					AND TABLE_TYPE = 'BASE TABLE'
				`, [this.schemaName]);
				stats.mysql.tableCount = tables[0]?.table_count || 0;
			} finally {
				await mysqlConn.end();
			}
		} catch (err) {
			stats.mysql.error = err.message;
		}

		return stats;
	}
}

module.exports = PreflightExecutor;
