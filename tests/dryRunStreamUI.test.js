const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Lines are deliberately split across chunks to check the reader buffers partial lines.
function streamOf(chunks) {
	const encoder = new TextEncoder();
	return new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } });
}
function planApi(fetch) {
	const context = vm.createContext({ window: { apiClient: { baseURL: '/api' } }, fetch, TextDecoder, Uint8Array, console });
	vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/public/js/api/plan-api.js'), 'utf8'), context);
	return context.window.PlanAPI;
}

test('the streamed dry run reports each table as it arrives and returns the final results', async () => {
	const events = [];
	let request;
	const api = planApi(async (url, options) => {
		request = { url, body: JSON.parse(options.body) };
		return { ok: true, body: streamOf(['{"type":"start","tables":["BANKS","STAFF"]}\n{"type":"ta', 'ble","table":{"tableName":"BANKS","errors":[]}}\n', '{"type":"table","table":{"tableName":"STAFF","errors":["x"]}}\n{"type":"done","results":{"tableCount":2}}\n']) };
	});
	const results = await api.dryRunStream(7, event => events.push(event));
	assert.equal(request.url, '/api/plans/7/dry-run');
	assert.equal(request.body.stream, true);
	assert.deepEqual(events.map(event => event.type === 'table' ? event.table.tableName : event.type), ['start', 'BANKS', 'STAFF']);
	assert.equal(results.tableCount, 2);
});

test('a dry run that fails part-way reports the server error', async () => {
	const api = planApi(async () => ({ ok: true, body: streamOf(['{"type":"start","tables":["A"]}\n{"type":"error","error":"Firebird went away"}\n']) }));
	await assert.rejects(api.dryRunStream(1), /Firebird went away/);
});

test('the live dry run lists every table and fills in statuses in order', () => {
	const element = { innerHTML: '', style: {} };
	const context = vm.createContext({ window: { WizardState: {}, PlanAPI: {} }, console, document: { getElementById: id => id === 'dry-run-results' ? element : null } });
	vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/public/js/steps/plan-ui.js'), 'utf8'), context);
	const ui = new context.window.PlanUI({});
	ui.dryRunLive = { tables: ['BANKS', 'INVOICES', 'STAFF'], results: new Map(), started: true };
	ui.dryRunLive.results.set('BANKS', { tableName: 'BANKS', estimatedRows: 1, errors: [], warnings: [] });
	ui.dryRunLive.results.set('INVOICES', { tableName: 'INVOICES', estimatedRows: 17974, errors: ['Target primary key column INVOICE_NR would receive NULL'], warnings: [] });
	ui.drawDryRunLive();
	const html = element.innerHTML;
	assert.match(html, /Checking 3 of 3 tables/);
	assert.match(html, /BANKS<\/td><td class="num">1<\/td><td class="status-col"><span class="status-badge status-success">/);
	assert.match(html, /INVOICES<\/td><td class="num">17[,\s]?974<\/td><td class="status-col"><span class="status-badge status-warning">✕ Errors/);
	assert.match(html, /STAFF<\/td><td class="num">—<\/td><td class="status-col"><span class="status-badge status-checking">/);
	assert.match(html, /<li><strong>INVOICES<\/strong> Target primary key column INVOICE_NR would receive NULL<\/li>/);
});

test('the finished dry run summarises failures with readable counts and duration', () => {
	const element = { innerHTML: '', style: {} };
	const context = vm.createContext({ window: { WizardState: {}, PlanAPI: {} }, console, document: { getElementById: () => element } });
	vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/public/js/steps/plan-ui.js'), 'utf8'), context);
	const ui = new context.window.PlanUI({});
	ui.dryRunResults = { tableCount: 2, estimatedRows: 296185, estimatedTime: '2962 seconds', perTable: [
		{ tableName: 'BANKS', estimatedRows: 1, errors: [], warnings: [] },
		{ tableName: 'INVOICES', estimatedRows: 17974, errors: ['<b>bad</b>'], warnings: [] }
	] };
	const html = ui.renderDryRunResults();
	assert.match(html, /✕ 1 of 2 tables have errors/);
	assert.match(html, /<strong>296[,\s]?185<\/strong> estimated rows/);
	assert.match(html, /about <strong>49 min<\/strong> to migrate/);
	assert.match(html, /&lt;b&gt;bad&lt;\/b&gt;/);
});
