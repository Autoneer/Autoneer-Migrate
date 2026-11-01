const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const job = (job_number, wip, last_moved, reason, extra = {}) => ({
	job_number, wip, last_moved, status: 'COMPLETED', reason, writeOff: reason !== 'UNFINISHED', locked: false, recent: false, ...extra
});

function previewResponse(overrides = {}) {
	return {
		success: true, schema: 'tenant_a', missingTables: [], posted: null, busy: false,
		backfill: { id: 1, status: 'DONE', from_date: '2016-04-26', to_date: '2026-10-30' },
		cutoverDate: '2026-10-31', defaultCutover: '2026-10-31', openingStockDate: null, keepFrom: '2026-05-01', keepMonths: 6,
		controls: { wip: { accnr: 3250, name: 'Work In Progress', status: 'mapped' }, opening: { accnr: 4900, name: 'Opening Balances', status: 'mapped' } },
		summary: { wipBalance: 1000 },
		reasons: { NO_JOB: 'No job on the line', NOT_IN_TENANT: 'Job not in the tenant', INVOICED: "Left after the job's invoice", CANCELLED: 'Cancelled or deleted job', UNFINISHED: 'Unfinished job' },
		jobs: [
			job(19546, 600, '2024-11-01', 'NOT_IN_TENANT', { status: '' }),
			job(8001, -50, '2026-09-01', 'INVOICED'),
			job(13646, 200, '2020-06-30', 'UNFINISHED', { writeOff: true }),
			job(20256, 150, '2026-06-22', 'UNFINISHED', { status: 'QUOTE', recent: true }),
			job(24914, 100, '2026-10-07', 'UNFINISHED', { status: 'WAITING FOR SPARES', recent: true, locked: true })
		],
		blockers: [], warnings: [], canPost: true,
		...overrides
	};
}

function setup(responses) {
	const elements = new Map();
	const listeners = new Map();
	const card = { classList: { toggle() {} }, querySelector: () => ({ hidden: true }) };
	const element = (id) => {
		if (!elements.has(id)) {
			elements.set(id, {
				id, innerHTML: '', value: '', hidden: false, disabled: false,
				addEventListener: (type, fn) => listeners.set(`${id}:${type}`, fn),
				insertAdjacentHTML(_where, html) { this.innerHTML = html + this.innerHTML; },
				querySelector: () => null,
				closest: () => card
			});
		}
		return elements.get(id);
	};
	const requests = [];
	const fetch = async (url, options = {}) => {
		requests.push({ url, body: options.body ? JSON.parse(options.body) : null });
		const data = responses.shift();
		return { ok: true, json: async () => data };
	};
	const context = vm.createContext({
		window: {}, fetch, setTimeout, clearTimeout, console, CustomEvent: class { constructor(type) { this.type = type; } },
		document: {
			readyState: 'complete', getElementById: element, addEventListener() {}, dispatchEvent() {},
			createElement: () => ({ set textContent(value) { this.innerHTML = value.replaceAll('&', '&amp;').replaceAll('<', '&lt;'); } })
		}
	});
	context.window.document = context.document;
	for (const file of ['gl-backfill-common.js', 'gl-backfill-wip.js']) {
		vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/public/js/tools', file), 'utf8'), context);
	}
	return { elements, listeners, requests, context };
}

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = (listeners, jobNumber, checked) => listeners.get('gl-wip-details:change')({
	target: { closest: () => ({ dataset: { wipJob: String(jobNumber) }, checked }) }
});

test('the preview shows the journal, the unfinished jobs to tick and the rest folded, and enables posting', async () => {
	const { elements, requests } = setup([previewResponse()]);
	await settle();
	assert.equal(requests[0].url, '/api/tools/gl-backfill/wip-write-off/preview');
	assert.deepEqual(requests[0].body, { cutoverDate: null, keepFrom: null, keepJobs: [], writeOffJobs: [] });
	assert.equal(elements.get('gl-wip-date').value, '2026-10-31');
	assert.equal(elements.get('gl-wip-keep-from').value, '2026-05-01', 'the keep-from date shows the default the server used');
	assert.match(elements.get('gl-wip-scope').innerHTML, /WIP: <strong>3250<\/strong> Work In Progress.*Opening Stock: <strong>4900<\/strong> Opening Balances/s);
	const details = elements.get('gl-wip-details').innerHTML;
	// Amounts follow the machine's locale, so any group and decimal separator matches.
	assert.match(details, /WIP at 2026-10-31 is <strong>1.000.00<\/strong>\. Writing off <strong>750.00<\/strong> on 3 jobs leaves <strong>250.00<\/strong> on 2 jobs/);
	assert.match(details, /<td>3250<\/td><td>Work In Progress<\/td><td class="gl-backfill-num">50.00<\/td><td class="gl-backfill-num">800.00<\/td>/);
	assert.match(details, /<td>4900<\/td><td>Opening Balances<\/td><td class="gl-backfill-num">750.00<\/td><td class="gl-backfill-num"><\/td>/);
	assert.match(details, /data-wip-job="13646" checked aria-label/);
	assert.match(details, /data-wip-job="20256" aria-label/);
	assert.match(details, /data-wip-job="24914" disabled aria-label.*The opening stock counts on it/s);
	assert.match(details, /data-fold="other"><summary><h4>Other jobs written off \(2\)<\/h4>/, 'the long list starts folded');
	assert.equal(elements.get('btn-gl-wip-post').disabled, false);
	assert.equal(elements.get('btn-gl-wip-post-top').disabled, false);
	assert.equal(elements.get('btn-gl-wip-undo').hidden, true);
});

test('a tick updates the totals without a reload and is sent only when it differs from the keep-from rule', async () => {
	const { elements, listeners, requests, context } = setup([previewResponse()]);
	await settle();
	tick(listeners, 13646, false);
	tick(listeners, 20256, true);
	tick(listeners, 20256, false);
	tick(listeners, 24914, true);
	await settle(600);
	assert.equal(requests.length, 1, 'no preview reload for a tick');
	assert.match(elements.get('gl-wip-totals').innerHTML, /Writing off <strong>550.00<\/strong> on 2 jobs leaves <strong>450.00<\/strong> on 3 jobs/);
	assert.match(elements.get('gl-wip-totals').innerHTML, /<td>4900<\/td><td>Opening Balances<\/td><td class="gl-backfill-num">550.00<\/td>/);

	const shown = [];
	context.window.Modal = { custom: async (options) => { shown.push(options); return false; } };
	await listeners.get('btn-gl-wip-post:click')();
	assert.match(shown[0].contentHTML, /<td>Written off<\/td><td class="gl-backfill-num">2<\/td><td class="gl-backfill-num">-550.00<\/td>/);
	assert.match(shown[0].contentHTML, /gl-confirm-total"><td>WIP after<\/td><td class="gl-backfill-num">3<\/td><td class="gl-backfill-num">450.00<\/td>/);
	assert.match(shown[0].contentHTML, /Don't invoice a written-off job in AUTONEER-PWA/);

	tick(listeners, 20256, true);
	listeners.get('gl-wip-keep-from:change')();
	await settle(600);
	assert.deepEqual(requests[1].body, { cutoverDate: '2026-10-31', keepFrom: '2026-05-01', keepJobs: [13646], writeOffJobs: [20256] },
		'a picked keep-from date and the ticks go to the server; the locked job does not');
});

test('posting shows the bouncing dots, then the result and the posted write-off with Undo', async () => {
	const posted = { journalId: 9, sourceId: 'WO-2026-10-31', trxdate: '2026-10-31', jobs: 3, value: 750, wipAtCutover: 250, wipNow: 250, canUndo: true, undoBlockers: [] };
	const { elements, listeners, requests, context } = setup([previewResponse()]);
	await settle();
	context.window.Modal = { custom: async () => true };
	let answer;
	context.fetch = (url, options) => {
		requests.push({ url, body: JSON.parse(options.body) });
		if (url.endsWith('/wip-write-off/post')) {
			return new Promise((resolve) => { answer = () => resolve({ ok: true, json: async () => ({ success: true, sourceId: 'WO-2026-10-31', cutoverDate: '2026-10-31', jobs: 3, value: 750, wipAtCutover: 250 }) }); });
		}
		return Promise.resolve({ ok: true, json: async () => ({ success: true, schema: 'tenant_a', missingTables: [], busy: false, posted }) });
	};
	const posting = listeners.get('btn-gl-wip-post-top:click')();
	await settle();
	assert.match(elements.get('gl-wip-details').innerHTML, /gl-dots.*<strong>Posting the WIP write-off…<\/strong> 3 job lines/s);
	assert.equal(elements.get('gl-wip-keep-from').disabled, true);
	assert.equal(requests.at(-1).body.confirm, true);
	answer();
	await posting;
	assert.match(elements.get('gl-wip-result').innerHTML, /Posted journal WO-2026-10-31 on 2026-10-31: 3 jobs, 750.00 written off\. WIP at cut-over is 250.00/);
	assert.match(elements.get('gl-wip-scope').innerHTML, /Posted on 2026-10-31: journal WO-2026-10-31, 3 jobs, 750.00 written off/);
	assert.equal(elements.get('gl-wip-details').innerHTML, '');
	assert.equal(elements.get('btn-gl-wip-post').hidden, true);
	assert.equal(elements.get('btn-gl-wip-undo').hidden, false);
	assert.equal(elements.get('btn-gl-wip-undo').disabled, false);
	assert.equal(elements.get('gl-wip-date').disabled, true);
});

test('a write-off with nothing left to write off cannot be posted', async () => {
	const { elements, listeners } = setup([previewResponse({ jobs: [job(13646, 200, '2020-06-30', 'UNFINISHED', { writeOff: true })] })]);
	await settle();
	assert.equal(elements.get('btn-gl-wip-post').disabled, false);
	tick(listeners, 13646, false);
	assert.equal(elements.get('btn-gl-wip-post').disabled, true);
	assert.doesNotMatch(elements.get('gl-wip-totals').innerHTML, /<table>/, 'no journal');
});
