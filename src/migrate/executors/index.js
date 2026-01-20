/**
 * Central export for all executors
 * Makes imports cleaner: const { PreflightExecutor, TableExecutor } = require('./executors');
 */

const PreflightExecutor = require('./PreflightExecutor');
const TableExecutor = require('./TableExecutor');

module.exports = {
	PreflightExecutor,
	TableExecutor
};
