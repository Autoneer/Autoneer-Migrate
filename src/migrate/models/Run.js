/**
 * Execution state of a migration (result tracking)
 * Represents a single migration run and its progress
 */

class Run {
	/**
	 * @param {integer} id - Database run ID
	 * @param {Plan} plan - Migration plan being executed
	 * @param {Object} options - { dryRun, batchSize, fkChecks }
	 */
	constructor(id, plan, options = {}) {
		this.id = id;
		this.plan = plan;
		this.dryRun = options.dryRun || false;
		this.batchSize = options.batchSize || 500;
		this.fkChecks = options.fkChecks !== undefined ? options.fkChecks : true;

		// Status tracking
		this.status = 'RUNNING'; // RUNNING, SUCCESS, FAILED, ABORTED
		this.startedAt = new Date();
		this.finishedAt = null;
		this.currentTable = null;
		this.lastError = null;

		// Per-table results
		this.tableResults = new Map(); // { TABLE: { status, inserted, updated, skipped, errors, ... } }

		// Totals
		this.totals = {
			migrated: 0,
			inserted: 0,
			updated: 0,
			skipped: 0,
			errors: 0,
			cleaned: 0
		};
	}

	/**
	 * Mark a table as currently processing
	 * @param {string} tableName
	 */
	startTable(tableName) {
		this.currentTable = tableName;
		this.tableResults.set(tableName, {
			table: tableName,
			status: 'RUNNING',
			startedAt: new Date(),
			inserted: 0,
			updated: 0,
			skipped: 0,
			errors: 0,
			cleaned: 0
		});
	}

	/**
	 * Record successful table completion
	 * @param {string} tableName
	 * @param {Object} stats - { inserted, updated, skipped, errors, cleaned }
	 */
	recordTableSuccess(tableName, stats) {
		this.tableResults.set(tableName, {
			table: tableName,
			status: 'SUCCESS',
			...stats,
			finishedAt: new Date()
		});

		this.totals.inserted += stats.inserted || 0;
		this.totals.updated += stats.updated || 0;
		this.totals.skipped += stats.skipped || 0;
		this.totals.errors += stats.errors || 0;
		this.totals.cleaned += stats.cleaned || 0;
		this.totals.migrated += (stats.inserted || 0) + (stats.updated || 0);
	}

	/**
	 * Record table failure
	 * @param {string} tableName
	 * @param {string} errorMessage
	 * @param {string} [hint]
	 */
	recordTableFailure(tableName, errorMessage, hint = null) {
		const existing = this.tableResults.get(tableName) || {
			table: tableName,
			inserted: 0,
			updated: 0,
			skipped: 0,
			errors: 0,
			cleaned: 0
		};

		this.tableResults.set(tableName, {
			...existing,
			status: 'FAILED',
			errorMessage,
			hint,
			finishedAt: new Date()
		});

		this.currentTable = tableName;
		this.lastError = { table: tableName, message: errorMessage, hint };
		this.status = 'FAILED';
	}

	/**
	 * Record table as skipped (user choice)
	 * @param {string} tableName
	 * @param {string} [reason]
	 */
	recordTableSkipped(tableName, reason = null) {
		this.tableResults.set(tableName, {
			table: tableName,
			status: 'SKIPPED',
			reason,
			finishedAt: new Date(),
			inserted: 0,
			updated: 0,
			skipped: 0,
			errors: 0,
			cleaned: 0
		});
	}

	/**
	 * Update progress for current table
	 * @param {string} tableName
	 * @param {Object} progress - { inserted, updated, skipped, errors }
	 */
	updateTableProgress(tableName, progress) {
		const existing = this.tableResults.get(tableName);
		if (existing) {
			this.tableResults.set(tableName, {
				...existing,
				...progress,
				lastUpdated: new Date()
			});
		}
	}

	/**
	 * Get result for a specific table
	 * @param {string} tableName
	 * @returns {Object|null}
	 */
	getTableResult(tableName) {
		return this.tableResults.get(tableName.toUpperCase()) || null;
	}

	/**
	 * Get all completed table names
	 * @returns {string[]}
	 */
	getCompletedTables() {
		return Array.from(this.tableResults.entries())
			.filter(([_, result]) => ['SUCCESS', 'FAILED', 'SKIPPED'].includes(result.status))
			.map(([table, _]) => table);
	}

	/**
	 * Get all failed table names
	 * @returns {string[]}
	 */
	getFailedTables() {
		return Array.from(this.tableResults.entries())
			.filter(([_, result]) => result.status === 'FAILED')
			.map(([table, _]) => table);
	}

	/**
	 * Mark run as complete
	 * @param {'SUCCESS'|'FAILED'|'ABORTED'} status
	 */
	finish(status = 'SUCCESS') {
		this.status = status;
		this.finishedAt = new Date();
		this.currentTable = null;
	}

	/**
	 * Mark run as aborted
	 * @param {string} reason
	 */
	abort(reason = 'Migration aborted by user') {
		this.status = 'ABORTED';
		this.finishedAt = new Date();
		this.lastError = { message: reason };
		this.currentTable = null;
	}

	/**
	 * Check if run is still active
	 * @returns {boolean}
	 */
	isActive() {
		return this.status === 'RUNNING';
	}

	/**
	 * Check if run is complete
	 * @returns {boolean}
	 */
	isComplete() {
		return ['SUCCESS', 'FAILED', 'ABORTED'].includes(this.status);
	}

	/**
	 * Get progress as percentage
	 * @returns {number} 0-100
	 */
	getProgress() {
		const total = this.plan.getIncludedTables().length;
		if (!total) return 0;

		const completed = this.getCompletedTables().length;

		return Math.round((completed / total) * 100);
	}

	/**
	 * Get elapsed time in seconds
	 * @returns {number}
	 */
	getElapsedSeconds() {
		const end = this.finishedAt || new Date();
		return Math.floor((end - this.startedAt) / 1000);
	}

	/**
	 * Get estimated time remaining in seconds
	 * @returns {number|null}
	 */
	getEstimatedSecondsRemaining() {
		const completed = this.getCompletedTables().length;
		const total = this.plan.getIncludedTables().length;

		if (completed === 0 || completed === total) {
			return null;
		}

		const elapsed = this.getElapsedSeconds();
		const avgPerTable = elapsed / completed;
		const remaining = total - completed;

		return Math.floor(avgPerTable * remaining);
	}

	/**
	 * Serialize for API response
	 * @returns {Object}
	 */
	toJSON() {
		return {
			id: this.id,
			status: this.status,
			startedAt: this.startedAt.toISOString(),
			finishedAt: this.finishedAt?.toISOString() || null,
			dryRun: this.dryRun,
			progress: this.getProgress(),
			elapsedSeconds: this.getElapsedSeconds(),
			estimatedSecondsRemaining: this.getEstimatedSecondsRemaining(),
			tableResults: Array.from(this.tableResults.values()),
			totals: this.totals,
			currentTable: this.currentTable,
			lastError: this.lastError
		};
	}

	/**
	 * Create a summary for database storage
	 * @returns {Object}
	 */
	toSummary() {
		return {
			runId: this.id,
			planId: this.plan.mappingId,
			status: this.status,
			startedAt: this.startedAt,
			finishedAt: this.finishedAt,
			dryRun: this.dryRun,
			tablesProcessed: this.getCompletedTables().length,
			tablesTotal: this.plan.getIncludedTables().length,
			totalInserted: this.totals.inserted,
			totalUpdated: this.totals.updated,
			totalSkipped: this.totals.skipped,
			totalErrors: this.totals.errors,
			totalCleaned: this.totals.cleaned
		};
	}
}

module.exports = Run;
