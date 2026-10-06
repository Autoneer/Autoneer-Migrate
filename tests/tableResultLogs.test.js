const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadLogger() {
	const output = [], saved = [];
	const file = path.join(__dirname, '../src/migrate/logger.js');
	const context = vm.createContext({ module: { exports: {} }, __dirname: path.dirname(file),
		process: { env: { NODE_ENV: 'test' } },
		console: { log: line => output.push(line), warn: line => output.push(line), error: line => output.push(line) },
		require: name => name === 'fs' ? { mkdirSync() {}, createWriteStream: () => ({ write: line => saved.push(line), end() {} }) } : require(name) });
	vm.runInContext(fs.readFileSync(file, 'utf8'), context);
	return { logger: context.module.exports, output, saved };
}

test('console prints one result per table while preserving every detailed log event', () => {
	const { logger, output, saved } = loadLogger();
	logger.startRunLogger(42);
	logger.logEvent(42, { phase: 'run_start', tables: [{ table: 'stock' }, { table: 'invoices' }] });
	logger.logEvent(42, { phase: 'preflight', status: 'passed' });
	logger.logEvent(42, { phase: 'table_start', tableName: 'stock' });
	const stock = { phase: 'table_finalize', tableName: 'stock', status: 'success', skipped: 47977 };
	logger.logEvent(42, stock);
	for (let i = 0; i < 300; i++) logger.logEvent(42, { phase: 'row_error', level: 'error', tableName: 'invoices', error: `Duplicate entry '${i}'` });
	logger.logEvent(42, { phase: 'row_error_summary', level: 'error', tableName: 'invoices', errors: 300 });
	const failure = { phase: 'table_finalize', tableName: 'invoices', status: 'failed', errors: 300, error: 'Long\nrow error details' };
	logger.logEvent(42, failure);
	logger.logEvent(42, { phase: 'run_finalize', status: 'failed', error: failure.error });
	logger.logEvent(42, stock);
	assert.equal(output.length, 2);
	assert.match(output[0], /stock: completed.*47[,\s]977/);
	assert.match(output[1], /invoices: failed — 300 row errors/);
	assert.doesNotMatch(output.join(''), /Duplicate entry|Long\nrow/);
	assert.equal(saved.length, 308);
	assert.equal(saved.filter(line => JSON.parse(line).phase === 'row_error').length, 300);
	// Final results survive a full rolling buffer and string URL IDs resolve correctly.
	assert.equal(logger.getLogBuffer('42').length, 200);
	assert.deepEqual(Array.from(logger.getTableResultBuffer('42'), event => event.tableName), ['stock', 'invoices']);
	logger.closeRunLogger(42);
	assert.equal(logger.getTableResultBuffer('42'), null);
});

test('older failures and multiline precheck errors produce a compact single line', () => {
	const { logger, output } = loadLogger();
	logger.logEvent(43, { phase: 'table_finalize', tableName: 'invoices', status: 'failed', error: 'Table invoices completed with 364 errors.' });
	logger.logEvent(43, { phase: 'table_finalize', tableName: 'stock', status: 'failed', error: 'Missing\nsource\r\ncolumn' });
	assert.match(output[0], /364 row errors/);
	assert.match(output[1], /Missing source column/);
	assert.ok(output.every(line => !/[\r\n]/.test(line)));
});
