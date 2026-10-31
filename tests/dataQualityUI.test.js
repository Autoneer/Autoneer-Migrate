const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup() {
	const elements = new Map(['data-quality-results', 'data-quality-scan'].map(id => [id, { innerHTML: '', disabled: false }]));
	const context = vm.createContext({ window: { WizardState: {}, PlanAPI: {} }, console, setInterval, clearInterval, setTimeout: callback => callback(), document: { getElementById: id => elements.get(id) } });
	vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/public/js/steps/plan-ui.js'), 'utf8'), context);
	const ui = new context.window.PlanUI({});
	ui.plan = { id: 9 };
	return { ui, elements, window: context.window };
}

test('wizard saves current selection before starting a full audit and polls until complete', async () => {
	const { ui, elements } = setup();
	const events = [];
	ui.onNext = async () => { events.push('save'); return true; };
	let polls = 0;
	ui.api = { auditDataQuality: async id => { events.push(`audit:${id}`); return { auditId: 'audit-id' }; },
		getDataQualityAudit: async () => ++polls === 1 ? { status: 'running', progress: { table: 'stock', scanned: 1000, total: 1200 } }
			: { id: 'audit-id', status: 'blocked', totals: { scanned: 1200, accepted: 1199, review: 1 }, tables: [] } };
	await ui.runDataQualityAudit();
	assert.deepEqual(events, ['save', 'audit:9']);
	assert.equal(polls, 2);
	assert.match(elements.get('data-quality-results').innerHTML, /Migration blocked/);
	assert.match(elements.get('data-quality-results').innerHTML, /download=quarantine/);
	assert.equal(elements.get('data-quality-scan').disabled, false);
});

test('audit report escapes names and error messages from database content', () => {
	const { ui } = setup();
	ui.dataQualityReport = { status: 'blocked', error: '<script>bad()</script>', tables: [{ table: '<img src=x onerror=bad()>', sourceTable: 'SOURCE', scanned: 1, accepted: 0, quarantined: 0, review: 1, errors: ['<b>unsafe</b>'] }] };
	const html = ui.renderDataQualityReport();
	assert.doesNotMatch(html, /<script>|<img|<b>unsafe/);
	assert.match(html, /&lt;script&gt;/);
});

test('failed plan save prevents an audit request', async () => {
	const { ui, elements } = setup();
	ui.onNext = async () => false;
	ui.api = { auditDataQuality: async () => { throw Error('must not start'); } };
	await ui.runDataQualityAudit();
	assert.equal(ui.auditRunning, false);
	assert.match(elements.get('data-quality-results').innerHTML, /Scan could not start/);
});

test('click immediately displays progress and prevents duplicate starts while saving', async () => {
	const { ui, elements } = setup();
	let finishSave;
	let saves = 0;
	ui.onNext = () => { saves++; return new Promise(resolve => { finishSave = resolve; }); };
	const pending = ui.runDataQualityAudit();
	assert.equal(elements.get('data-quality-scan').disabled, true);
	assert.match(elements.get('data-quality-scan').textContent, /Scan in progress/);
	assert.match(elements.get('data-quality-results').innerHTML, /Looking for an existing scan/);
	await ui.runDataQualityAudit();
	assert.equal(saves, 1);
	finishSave(false);
	await pending;
	assert.equal(elements.get('data-quality-scan').disabled, false);
});

test('thrown save errors appear beside the button and release the busy state', async () => {
	const { ui, elements } = setup();
	ui.onNext = async () => { throw Error('Save unavailable'); };
	await ui.runDataQualityAudit();
	assert.match(elements.get('data-quality-results').innerHTML, /Save unavailable/);
	assert.equal(ui.auditRunning, false);
	assert.equal(elements.get('data-quality-scan').disabled, false);
});

test('progress distinguishes table reading from relationship checks and completion', () => {
	const { ui } = setup();
	ui.auditStartedAt = Date.now();
	ui.dataQualityReport = { status: 'running', progress: { phase: 'reading', table: 'INVOICES', scanned: 1000, total: 17000 } };
	assert.match(ui.renderDataQualityReport(), /1[,\s]000 of 17[,\s]000 records read/);
	assert.match(ui.renderDataQualityReport(), /aria-valuemax="17000" aria-valuenow="1000"/);
	ui.dataQualityReport.progress = { phase: 'checking_relationships' };
	assert.match(ui.renderDataQualityReport(), /Checking links between records/);
	// The current-table bar is indeterminate when the record count is unknown; only the overall bar has a value.
	assert.match(ui.renderDataQualityReport(), /class="qbar table indeterminate" role="progressbar" aria-label="Current table records">/);
	assert.match(ui.renderDataQualityReport(), /aria-label="Overall scan progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="\d+"/);
	ui.dataQualityReport = { status: 'ready', totals: { scanned: 5, accepted: 4, quarantined: 1 }, tables: [] };
	assert.match(ui.renderDataQualityReport(), /Scan complete/);
	assert.match(ui.renderDataQualityReport(), /5 checked · 4 accepted · 1 quarantined/);
});

test('active table panel resets its counts and ordinal on the next table and clears at completion', () => {
	const { ui } = setup();
	ui.dataQualityReport = { status: 'running', progress: { stage: 'rows', phase: 'reading', table: 'invoices', tableIndex: 1, tableCount: 90, nextTable: 'stock', scanned: 100, total: 15000 } };
	let html = ui.renderDataQualityReport();
	assert.match(html, /Table 1 of 90/);
	assert.match(html, /100 of 15[,\s]000 records read/);
	assert.match(html, /Next table: STOCK/);
	ui.dataQualityReport.progress = { stage: 'rows', phase: 'reading', table: 'stock', tableIndex: 2, tableCount: 90, scanned: 0, total: 750 };
	html = ui.renderDataQualityReport();
	assert.match(html, /Table 2 of 90/);
	assert.match(html, /0 of 750 records read/);
	assert.doesNotMatch(html, /INVOICES|15[,\s]000|Next table:/);
	ui.dataQualityReport = { status: 'ready', tables: [], totals: {} };
	html = ui.renderDataQualityReport();
	assert.match(html, /Scan complete/);
	assert.doesNotMatch(html, /quality-spinner|quality-stages|<progress|qbar/);
});

test('polling failures do not claim the server audit failed or that zero rows were checked', async () => {
	const { ui, elements } = setup();
	ui.onNext = async () => true;
	ui.api = { auditDataQuality: async () => ({ auditId: 'audit-id' }), getDataQualityAudit: async () => { throw Error('Network unavailable'); } };
	await ui.runDataQualityAudit();
	const html = elements.get('data-quality-results').innerHTML;
	assert.match(html, /Unable to retrieve scan progress/);
	assert.match(html, /may still be running/);
	assert.match(html, /audit-id\?download=report/);
	assert.doesNotMatch(html, /0 checked/);
});

test('stop during plan save prevents the server scan from starting', async () => {
	const { ui, elements } = setup();
	let finish;
	ui.onNext = () => new Promise(resolve => { finish = resolve; });
	ui.api = { auditDataQuality: () => assert.fail('must not start') };
	const running = ui.runDataQualityAudit();
	await ui.stopDataQualityAudit();
	assert.match(elements.get('data-quality-results').innerHTML, /Stopping scan/);
	finish(true);
	await running;
	assert.match(elements.get('data-quality-results').innerHTML, /Scan stopped/);
	assert.equal(ui.auditRunning, false);
});

test('stop queued during start is dispatched once and polling continues through stopping', async () => {
	const { ui, elements } = setup();
	let finishStart, started;
	const startCalled = new Promise(resolve => { started = resolve; });
	ui.onNext = async () => true;
	let stops = 0, polls = 0;
	ui.api = {
		auditDataQuality: () => { started(); return new Promise(resolve => { finishStart = resolve; }); },
		stopDataQualityAudit: async id => { assert.equal(id, 'scan-id'); stops++; },
		getDataQualityAudit: async () => ({ status: ++polls === 1 ? 'stopping' : 'cancelled' })
	};
	const running = ui.runDataQualityAudit();
	await startCalled;
	await ui.stopDataQualityAudit();
	await ui.stopDataQualityAudit();
	finishStart({ auditId: 'scan-id' });
	await running;
	assert.equal(stops, 1);
	assert.equal(polls, 2);
	assert.match(elements.get('data-quality-results').innerHTML, /Scan stopped/);
	assert.doesNotMatch(elements.get('data-quality-results').innerHTML, /ready to migrate|download=quarantine/);
});

test('failed stop request leaves the scan running and permits retry', async () => {
	const { ui, elements } = setup();
	ui.auditRunning = true; ui.activeAuditId = 'scan-id';
	ui.dataQualityReport = { status: 'running' };
	ui.api = { stopDataQualityAudit: async () => { throw Error('Network unavailable'); } };
	await ui.stopDataQualityAudit();
	assert.equal(ui.auditRunning, true);
	assert.equal(ui.auditStopRequested, false);
	assert.match(elements.get('data-quality-results').innerHTML, /Could not request stop: Network unavailable/);
});

test('returning to Step 3 reconnects without saving or starting and restores stop and elapsed time', async () => {
	const { ui, elements } = setup();
	const createdAt = new Date(Date.now() - 300000).toISOString();
	let reachedPoll, finishPoll, stops = 0;
	const polling = new Promise(resolve => { reachedPoll = resolve; });
	ui.onNext = () => assert.fail('must not save a new plan');
	ui.api = {
		getActiveDataQualityAudit: async () => ({ id: 'existing', status: 'running', createdAt, progress: { table: 'invoices', stage: 'rows', phase: 'reading', tableIndex: 3, tableCount: 21, scanned: 500, total: 1000 } }),
		auditDataQuality: () => assert.fail('must not start a new scan'),
		getDataQualityAudit: () => { reachedPoll(); return new Promise(resolve => { finishPoll = resolve; }); },
		stopDataQualityAudit: async id => { assert.equal(id, 'existing'); stops++; }
	};
	const running = ui.runDataQualityAudit({ resumeOnly: true });
	await polling;
	assert.equal(ui.activeAuditId, 'existing');
	assert.ok(Date.now() - ui.auditStartedAt >= 300000);
	assert.match(elements.get('data-quality-results').innerHTML, /Reconnected|Table 3 of 21/);
	assert.match(elements.get('data-quality-results').innerHTML, /Stop Scan/);
	await ui.stopDataQualityAudit();
	assert.equal(stops, 1);
	finishPoll({ status: 'cancelled' });
	await running;
});

test('returning with no active scan leaves the page idle without starting work', async () => {
	const { ui } = setup();
	ui.api = { getActiveDataQualityAudit: async () => null };
	ui.onNext = () => assert.fail('must not save');
	await ui.runDataQualityAudit({ resumeOnly: true });
	assert.equal(ui.auditRunning, false);
	assert.equal(ui.dataQualityReport, null);
});

test('blocked results list short next steps: missing parent tables, repair decisions, then rescan', () => {
	const { ui } = setup();
	ui.dataQualityReport = { id: 'audit-1', status: 'blocked', totals: { review: 102 }, tables: [{ table: 'invoices', rules: { MISSING_PARENT: 100, TARGET_KEY_CONFLICT: 2 }, samples: [{ ordinal: 0, reasons: [{ message: 'No accepted job_information parent (job_number)' }] }] }] };
	const html = ui.renderDataQualityReport();
	assert.match(html, /What to do next/);
	assert.match(html, /Add the missing tables in Step 2:<\/strong> job_information/);
	assert.match(html, /Decide what to do with 102 blocked records/);
	assert.match(html, /audit-1\/groups">Review grouped repair decisions/);
	assert.match(html, /Leave them all out and rescan/);
	assert.match(html, /Run Check All Selected Tables again/);
});

test('returning to Step 3 restores completed server results without starting or saving another scan', async () => {
	const { ui, elements } = setup();
	ui.api = { getActiveDataQualityAudit: async () => null, getLatestDataQualityAudit: async id => {
		assert.equal(id, 9); return { id: 'saved-audit', status: 'blocked', settingsChanged: true, tables: [], totals: { review: 12 } };
	} };
	ui.onNext = () => assert.fail('restoring results must not save or scan');
	await ui.runDataQualityAudit({ resumeOnly: true });
	assert.equal(ui.dataQualityReport.id, 'saved-audit');
	assert.equal(ui.auditRunning, false);
	assert.match(elements.get('data-quality-results').innerHTML, /Saved scan results/);
	assert.match(elements.get('data-quality-results').innerHTML, /Review grouped repair decisions/);
	assert.match(elements.get('data-quality-results').innerHTML, /12 need review/);
});

test('bulk exclusion needs an explicit choice, retains target data, and reruns the audit', async () => {
	const { ui, window } = setup();
	ui.plan.tables = ['STAFF']; ui.plan.tableConfigs = { STAFF: { cleanBefore: true, mode: 'UPSERT' } };
	ui.dataQualityReport = { totals: { review: 50 } };
	let scans = 0;
	ui.runDataQualityAudit = async () => { scans++; };
	window.confirm = () => false;
	await ui.setUnresolvedPolicy(true);
	assert.equal(scans, 0);
	window.confirm = text => { assert.match(text, /50/); return true; };
	await ui.setUnresolvedPolicy(true);
	assert.equal(ui.plan.config.dataQuality.excludeUnresolved, true);
	assert.equal(ui.plan.tableConfigs.STAFF.cleanBefore, false);
	assert.equal(ui.plan.tableConfigs.STAFF.mode, 'INSERT');
	assert.equal(scans, 1);
	await ui.setUnresolvedPolicy(false);
	assert.equal(ui.plan.config.dataQuality.excludeUnresolved, false);
	assert.equal(scans, 2);
});

test('overall progress combines stages and tables and says how much is left', () => {
	const { ui } = setup();
	ui.auditStartedAt = Date.now();
	ui.dataQualityReport = { status: 'running', progress: { stage: 'rows', phase: 'reading', table: 'spares_used', tableIndex: 17, tableCount: 22, scanned: 11400, total: 89935 } };
	const html = ui.renderDataQualityReport();
	// Prepare (5) + 60% of rows weighted by tables: (16 + 0.127) / 22 → 49%.
	assert.match(html, /aria-valuenow="49"/);
	assert.match(html, /Stage 2 of 4 · 5 tables left in this stage, then 2 more stages/);
	ui.dataQualityReport.progress = { stage: 'results', phase: 'saving_quarantine', table: 'stock', tableIndex: 22, tableCount: 22, scanned: 10, total: 10 };
	assert.match(ui.renderDataQualityReport(), /Stage 4 of 4 · 0 tables left in this stage/);
	assert.match(ui.renderDataQualityReport(), /aria-valuenow="99"/);
});

test('a current, ready full check is marked so the dry run can be hidden; stale or blocked results are not', () => {
	const { ui } = setup();
	ui.dataQualityReport = { status: 'ready', totals: {}, tables: [] };
	assert.match(ui.renderDataQualityReport(), /class="quality-result validation-success is-ready"/);
	ui.dataQualityReport = { status: 'ready', settingsChanged: true, totals: {}, tables: [] };
	assert.doesNotMatch(ui.renderDataQualityReport(), /is-ready/);
	ui.dataQualityReport = { status: 'blocked', totals: {}, tables: [] };
	assert.doesNotMatch(ui.renderDataQualityReport(), /is-ready/);
});

test('the scan result folds to its status line and an out-of-date result does not say to continue', () => {
	const { ui } = setup();
	ui.dataQualityReport = { status: 'ready', settingsChanged: true, totals: { scanned: 5 }, tables: [] };
	let html = ui.renderDataQualityReport();
	assert.match(html, /<details id="quality-result" class="quality-result[^"]*" open>\s*<summary class="quality-result-head">/);
	assert.doesNotMatch(html, /Click <strong>Next/);
	ui.dataQualityReport = { status: 'ready', totals: { scanned: 5 }, tables: [] };
	assert.match(ui.renderDataQualityReport(), /Click <strong>Next/);
	ui.resultCollapsed = true;
	html = ui.renderDataQualityReport();
	assert.match(html, /<details id="quality-result" class="quality-result[^"]*">/);
});
