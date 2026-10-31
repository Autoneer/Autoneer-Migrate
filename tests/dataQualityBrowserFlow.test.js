const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the actual browser HTTP client, API wrapper and UI together.
// Only fetch and the DOM are stand-ins; no tenant database is contacted.
function setup(fetch) {
	const elements = new Map(['data-quality-results', 'data-quality-scan'].map(id => [id, { innerHTML: '', disabled: false }]));
	let now = 100000;
	const ticks = new Map();
	let timerId = 0;
	const context = vm.createContext({ window: { WizardState: {} }, console, AbortController, URLSearchParams, fetch: (url, options) => url === '/api/quality-audits/active' ? Promise.resolve(response({ report: null })) : fetch(url, options),
		Date: class extends Date { static now() { return now; } },
		setTimeout: (callback, ms) => ms === 1500 ? setTimeout(callback, 0) : setTimeout(callback, ms), clearTimeout,
		setInterval: callback => { ticks.set(++timerId, callback); return timerId; }, clearInterval: id => ticks.delete(id),
		document: { getElementById: id => elements.get(id) } });
	for (const file of ['api/client.js', 'api/plan-api.js', 'steps/plan-ui.js']) {
		vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/public/js', file), 'utf8'), context);
	}
	const ui = new context.window.PlanUI({});
	ui.plan = { id: 9 };
	ui.onNext = async () => true;
	return { ui, elements, ticks, api: context.window.PlanAPI, tick: seconds => { now += seconds * 1000; for (const callback of ticks.values()) callback(); } };
}
const response = body => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => body });

test('real client sends scan start once, timer advances while awaiting it, and queued stop reaches server', async () => {
	const requests = [];
	let finishStart, startSeen;
	const started = new Promise(resolve => { startSeen = resolve; });
	const { ui, elements, tick, ticks } = setup(async (url, options) => {
		requests.push([url, options.method]);
		if (url === '/api/plans/9/data-quality') { startSeen(); return new Promise(resolve => { finishStart = resolve; }); }
		if (url === '/api/quality-audits/scan-id/stop') return response({ success: true, status: 'stopping' });
		if (url === '/api/quality-audits/scan-id') return response({ report: { status: 'cancelled' } });
		throw Error(`Unexpected request ${url}`);
	});
	const running = ui.runDataQualityAudit();
	await started;
	tick(5);
	assert.match(elements.get('data-quality-results').innerHTML, /Elapsed: 5s/);
	assert.equal(elements.get('data-quality-scan').disabled, true);
	assert.match(elements.get('data-quality-scan').textContent, /Scan in progress/);
	await ui.stopDataQualityAudit();
	finishStart(response({ auditId: 'scan-id' }));
	await running;
	assert.deepEqual(requests, [['/api/plans/9/data-quality', 'POST'], ['/api/quality-audits/scan-id/stop', 'POST'], ['/api/quality-audits/scan-id', 'GET']]);
	assert.match(elements.get('data-quality-results').innerHTML, /Scan stopped/);
	assert.equal(ticks.size, 0);
});

test('no-retry start failure performs one request and displays its actual error', async () => {
	let requests = 0;
	const { ui, elements, ticks } = setup(async () => { requests++; throw Error('Server unavailable'); });
	await ui.runDataQualityAudit();
	assert.equal(requests, 1);
	assert.match(elements.get('data-quality-results').innerHTML, /Scan could not start/);
	assert.match(elements.get('data-quality-results').innerHTML, /Server unavailable/);
	assert.doesNotMatch(elements.get('data-quality-results').innerHTML, /quality-spinner/);
	assert.equal(ticks.size, 0);
	assert.equal(elements.get('data-quality-scan').disabled, false);
});

test('real client polls the scan and replaces live table progress with completed results', async () => {
	let polls = 0;
	let view;
	const { ui, elements } = setup(async url => {
		if (url.endsWith('/data-quality')) return response({ auditId: 'scan-id' });
		if (++polls === 1) return response({ report: { status: 'running', progress: { stage: 'rows', phase: 'reading', table: 'invoices', tableIndex: 2, tableCount: 21, scanned: 100, total: 15000 } } });
		view = elements.get('data-quality-results').innerHTML;
		return response({ report: { status: 'ready', tables: [], totals: { scanned: 15000, accepted: 15000 } } });
	});
	await ui.runDataQualityAudit();
	assert.equal(polls, 2);
	assert.match(view, /Table 2 of 21/);
	assert.match(view, /100 of 15[,\s]000 records read/);
	assert.match(elements.get('data-quality-results').innerHTML, /Scan complete/);
});

test('empty rejection cannot leave a frozen running panel', async () => {
	const { ui, elements, ticks } = setup(async () => { throw Error('Unexpected network request'); });
	ui.api.auditDataQuality = async () => { throw undefined; };
	await ui.runDataQualityAudit();
	assert.match(elements.get('data-quality-results').innerHTML, /Scan could not start/);
	assert.match(elements.get('data-quality-results').innerHTML, /without an error message/);
	assert.equal(ticks.size, 0);
	assert.equal(ui.auditRunning, false);
});

test('a simultaneous start in another tab reconnects using the conflict response audit ID', async () => {
	let starts = 0, polls = 0;
	const { ui, elements } = setup(async url => {
		if (url.endsWith('/data-quality')) {
			starts++;
			return { ...response({ error: 'Already running', auditId: 'existing' }), ok: false, status: 409 };
		}
		assert.equal(url, '/api/quality-audits/existing');
		polls++;
		return response({ report: { id: 'existing', status: 'ready', tables: [] } });
	});
	await ui.runDataQualityAudit();
	assert.equal(starts, 1); assert.equal(polls, 1);
	assert.equal(ui.auditResumed, true);
	assert.match(elements.get('data-quality-results').innerHTML, /Scan complete/);
});
