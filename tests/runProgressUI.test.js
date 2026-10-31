const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function setup() {
	const elements = new Map();
	const values = new Map();
	let interval;
	const getElement = key => {
		if (!elements.has(key)) elements.set(key, { style: {}, innerHTML: '', textContent: '', children: [], appendChild(child) { this.children.push(child); } });
		return elements.get(key);
	};
	const context = vm.createContext({ window: {
		WizardState: { get: key => values.get(key), set: (key, value) => values.set(key, value) },
		RunAPI: { getLogs: async () => [] }
	}, console, setInterval: callback => { interval = callback; return 1; }, clearInterval() {},
		document: { querySelector: getElement, getElementById: getElement,
			createElement: () => ({ children: [], appendChild(child) { this.children.push(child); } }) } });
	vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/public/js/steps/run-ui.js'), 'utf8'), context);
	const ui = new context.window.RunUI({ escapeHtml: value => value.replaceAll('<', '&lt;').replaceAll('>', '&gt;') });
	ui.run = { id: 3, status: 'RUNNING' };
	ui.plan = { tables: ['invoices', 'stock'] };
	return { ui, elements, values, tick: () => interval() };
}

test('live log only adds one final result per table across repeated snapshots', () => {
	const { ui, elements } = setup();
	const events = [
		{ phase: 'run_start' }, { phase: 'table_start', tableName: 'stock' },
		{ phase: 'fetch', tableName: 'stock', sourceRows: 47977 },
		{ phase: 'write', level: 'debug', tableName: 'stock' },
		{ phase: 'table_finalize', tableName: 'stock', status: 'success', skipped: 47977 },
		{ phase: 'row_error', level: 'error', tableName: 'invoices', error: 'Duplicate entry' },
		{ phase: 'row_error_summary', level: 'error', tableName: 'invoices', errors: 364 },
		{ phase: 'table_finalize', tableName: 'invoices', status: 'failed', errors: 364 },
		{ phase: 'run_finalize', status: 'failed' }
	];
	ui.appendLogEntries(events);
	ui.appendLogEntries(events);
	const lines = elements.get('log-container').children;
	assert.equal(lines.length, 2);
	assert.match(lines[0].title, /stock: completed/);
	assert.equal(lines[0].children[1].children[0].textContent, 'STOCK');
	assert.match(lines[0].children[1].children[1].textContent, /^47[,\s]977 skipped$/);
	assert.match(lines[1].title, /invoices: failed — 364 row errors/);
	assert.equal(lines[1].children[1].children[1].textContent, 'failed · 364 row errors');
	assert.doesNotMatch(lines.map(line => line.title).join(''), /Duplicate entry/);
});

test('table rows show execution order, all processed records, zero totals and validation status', () => {
	const { ui } = setup();
	const html = ui.renderTableStatus([
		{ table: 'stock', status: 'completed', rowsProcessed: 47977, totalRows: 47977, rowsMigrated: 0, skippedDuplicates: 47977, progress: 100 },
		{ table: 'banks', status: 'completed', rowsProcessed: 0, totalRows: 0, progress: 100 },
		{ table: 'invoices', status: 'running', rowsProcessed: 2, totalRows: 2, rowsMigrated: 2, phase: 'validating', progress: 100 }
	]);
	assert.ok(html.indexOf('STOCK') < html.indexOf('INVOICES'));
	assert.match(html, /47[,\s]977 \/ 47[,\s]977/);
	assert.match(html, /0 written · 47[,\s]977 skipped · 0 failed/);
	assert.match(html, /0 \/ 0/);
	assert.match(html, /validating/);
	assert.match(html, /table-status-running/);
});

test('updates the execution progress bar, active table and completed count', async () => {
	const { ui, elements } = setup();
	await ui.updateProgressDisplay({ percent: 22, tablesCompleted: 4, tablesTotal: 21,
		tables: [{ table: 'invoices', status: 'running', rowsProcessed: 100, totalRows: 55903, errors: 100 }] });
	assert.equal(elements.get('#run-content .overall-progress .progress-bar-fill').style.width, '22%');
	assert.equal(elements.has('.progress-bar-fill'), false);
	assert.match(elements.get('current-table-status').textContent, /Migrating: INVOICES · 4 of 21 tables completed/);
});

test('slow polls cannot overlap and an old run response cannot overwrite a new run', async () => {
	const { ui, tick, values } = setup();
	let resolve, calls = 0;
	ui.api.getProgress = () => { calls++; return new Promise(done => { resolve = done; }); };
	ui.startPolling();
	await tick(); await tick();
	assert.equal(calls, 1);
	ui.stopPolling();
	ui.run = { id: 4, status: 'RUNNING' };
	ui.startPolling();
	resolve({ status: 'RUNNING', percent: 90, tables: [] });
	await new Promise(setImmediate);
	assert.equal(values.has('run.progress'), false);
	const pending = tick();
	assert.equal(calls, 2);
	resolve({ status: 'RUNNING', percent: 10, tables: [] });
	await pending;
	assert.equal(values.get('run.progress'), 10);
	ui.stopPolling();
});

test('execution shows full-audit progress before any table starts importing', async () => {
	const { ui, elements } = setup();
	await ui.updateProgressDisplay({ status: 'RUNNING', percent: 0, tables: [], tablesCompleted: 0, tablesTotal: 4,
		dataQualityProgress: { table: 'stock', scanned: 1500 }, dataQuality: null });
	assert.match(elements.get('current-table-status').textContent, /Checking data quality: stock · 1[,\s]500 rows scanned/);
});

test('table rows show per-table audit progress until the audit finishes', async () => {
	const { ui, elements } = setup();
	const tables = [
		{ table: 'banks', status: 'pending', audit: { phase: 'checked', done: true, scanned: 12, total: 12, flagged: 1 } },
		{ table: 'stock', status: 'pending', audit: { phase: 'reading', scanned: 800, total: 3200, flagged: 0 } },
		{ table: 'invoices', status: 'pending', audit: null }
	];
	await ui.updateProgressDisplay({ status: 'RUNNING', percent: 0, tables, tablesCompleted: 0, tablesTotal: 3,
		dataQualityProgress: { table: 'stock', tableIndex: 2, tableCount: 3, scanned: 800 }, dataQuality: null });
	const html = elements.get('table-status-list').innerHTML;
	assert.match(html, /✓ checked[\s\S]*12 checked[\s\S]*1 flagged for review[\s\S]*width: 100%/);
	assert.match(html, /checking<\/span>[\s\S]*800 \/ 3[,\s]200[\s\S]*width: 25%/);
	assert.match(html, /waiting to check/);
	assert.match(elements.get('current-table-status').textContent, /stock \(2 of 3\) · 800 rows scanned/);
	await ui.updateProgressDisplay({ status: 'RUNNING', percent: 0, tables, tablesCompleted: 0, tablesTotal: 3,
		dataQualityProgress: { table: 'stock' }, dataQuality: { id: 'a', status: 'ready' } });
	assert.doesNotMatch(elements.get('table-status-list').innerHTML, /checked|waiting to check/);
});
