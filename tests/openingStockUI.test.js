const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const row = (stock_id, partnr, legacy_quantity, value, candidate = false) => ({
	stock_id, partnr, description: `${partnr} item`, stocktype: 'PARTS', legacy_quantity, quantity: legacy_quantity, cost: 1, value, candidate
});

function previewResponse(overrides = {}) {
	return {
		success: true, schema: 'tenant_a', missingTables: [], posted: null, busy: false,
		backfill: { id: 2, status: 'DONE', from_date: '2016-04-26', to_date: '2026-10-30' },
		legacy: { database: 'AUTONEER.FDB', rows: 17345, withQuantity: 2013, ids: 'preserved ids' },
		cutoverDate: '2026-10-31', defaultCutover: '2026-10-31', latestDocument: '2026-10-30', placeholderMinQty: 900,
		controls: { inventory: { accnr: 3200, name: 'Inventory', status: 'mapped' }, opening: { accnr: 4900, name: 'Opening Balances', status: 'mapped' } },
		summary: {
			counted: { items: 2, value: 150, quantity: 3 }, placeholders: { items: 2, value: 991288104.4 }, negatives: { items: 1, value: -5 },
			zeroCost: { items: 0 }, negativeCost: { items: 0, value: 0 }, alreadyStocked: { items: 0, value: 0 },
			openJobs: { jobs: 1, value: 40 }, inventoryBalance: -136663.63, inventoryAfter: 190, journalTotal: 136853.63
		},
		journal: [{ accnr: 3200, name: 'Inventory', debit: 136853.63, credit: 0 }, { accnr: 4900, name: 'Opening Balances', debit: 0, credit: 136853.63 }],
		openJobs: [{ job_number: 24914, parts: 2, cost: 40, wip: 0, accounts: [{ accnr: 3200, name: 'Inventory', amount: 40 }] }],
		lists: {
			counted: [row(1, 'FILTER', 2, 100), row(3, 'STAGE1', 1, 50)],
			placeholders: [row(2, 'AC-REGAS', 9999880, 991288104.4, true), row(4, 'UBER001', 5, 10)],
			negatives: [row(5, 'TAPE', -1, -5)], zeroCost: [], negativeCost: [], alreadyStocked: []
		},
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
				querySelectorAll: () => [],
				closest: () => card
			});
		}
		return elements.get(id);
	};
	element('gl-opening-min-qty').value = '900';
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
	for (const file of ['gl-backfill-common.js', 'gl-backfill-opening-stock.js']) {
		vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/public/js/tools', file), 'utf8'), context);
	}
	return { elements, listeners, requests, context };
}

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

test('the preview shows the journal, the placeholders and the open-job stock, and enables posting', async () => {
	const { elements, requests } = setup([previewResponse()]);
	await settle();
	assert.equal(requests[0].url, '/api/tools/gl-backfill/opening-stock/preview');
	assert.deepEqual(requests[0].body, { cutoverDate: null, placeholderMinQty: 900, keepStockIds: [], zeroStockIds: [] });
	assert.equal(elements.get('gl-opening-date').value, '2026-10-31', 'the default cut-over fills the date');
	const scope = elements.get('gl-opening-scope').innerHTML;
	assert.match(scope, /AUTONEER\.FDB/);
	assert.match(scope, /Opening Stock: <strong>4900<\/strong> Opening Balances/);
	const details = elements.get('gl-opening-details').innerHTML;
	assert.match(details, /Journal on 2026-10-31/);
	// Amounts follow the machine's locale, so any group and decimal separator matches.
	assert.match(details, /left Inventory at <strong>-136.663.63<\/strong>/);
	assert.match(details, /Placeholders set to 0.*AC-REGAS/s);
	assert.match(details, /data-opening-toggle="placeholder" data-stock-id="2" checked/);
	assert.match(details, /data-opening-toggle="counted" data-stock-id="3" aria-label/);
	assert.match(details, /Stock on open jobs.*24914/s);
	assert.match(details, /<div class="gl-opening-bar"><div class="gl-backfill-stats">.*<button type="button" class="btn secondary" data-fold-all>Collapse all<\/button><\/div>/s);
	assert.equal(elements.get('btn-gl-opening-post').disabled, false);
	assert.equal(elements.get('btn-gl-opening-post-top').disabled, false, 'the Post at the top of the card follows the bottom one');
	assert.equal(elements.get('btn-gl-opening-undo').hidden, true);
});

test('Collapse all folds every section, keeps them folded on reload, and then offers Expand all', async () => {
	const { elements, listeners } = setup([previewResponse(), previewResponse()]);
	await settle();
	const details = elements.get('gl-opening-details');
	const button = { textContent: 'Collapse all' };
	const sections = ['journal', 'placeholders', 'counted'].map((fold, i) => ({ dataset: { fold }, open: i !== 1 }));
	details.querySelector = (selector) => (selector === '[data-fold-all]' ? button : null);
	details.querySelectorAll = () => sections;
	const click = () => listeners.get('gl-opening-details:click')({ target: { closest: (selector) => (selector === '[data-fold-all]' ? button : null) } });
	click();
	assert.deepEqual(sections.map((s) => s.open), [false, false, false]);
	assert.equal(button.textContent, 'Expand all');
	listeners.get('gl-opening-min-qty:change')();
	await settle(600);
	assert.match(details.innerHTML, /data-fold="journal"><summary>/);
	assert.match(details.innerHTML, /data-fold="counted"><summary>/);
	click();
	assert.deepEqual(sections.map((s) => s.open), [true, true, true]);
	assert.equal(button.textContent, 'Collapse all');
});

test('typing a placeholder threshold reloads the preview with it, without leaving the field', async () => {
	const { elements, listeners, requests } = setup([previewResponse(), previewResponse({ placeholderMinQty: 500 })]);
	await settle();
	elements.get('gl-opening-min-qty').value = '500';
	listeners.get('gl-opening-min-qty:input')();
	await settle(600);
	assert.equal(requests[1].body.placeholderMinQty, 500);
	assert.match(elements.get('gl-opening-details').innerHTML, /Quantities of 500 or more/);
});

test('ticking and unticking items sends them as kept or set to 0', async () => {
	const { listeners, requests } = setup([previewResponse(), previewResponse(), previewResponse()]);
	await settle();
	const change = listeners.get('gl-opening-details:change');
	const toggle = (stockId, checked) => change({ target: { closest: () => ({ dataset: { stockId: String(stockId) }, checked }) } });
	toggle(2, false); // AC-REGAS is a candidate: keep it
	toggle(3, true); // STAGE1 is counted: set it to 0
	await settle(600);
	assert.deepEqual(requests[1].body.keepStockIds, [2]);
	assert.deepEqual(requests[1].body.zeroStockIds, [3]);
	toggle(4, false); // UBER001 was set to 0 by hand and is not a candidate: count it again
	await settle(600);
	assert.deepEqual(requests[2].body.zeroStockIds, [3]);
	assert.deepEqual(requests[2].body.keepStockIds, [2]);
});

test('each section folds to its title and stays folded when the preview reloads', async () => {
	const { elements, listeners } = setup([previewResponse(), previewResponse()]);
	await settle();
	assert.match(elements.get('gl-opening-details').innerHTML, /data-fold="placeholders" open><summary><h4>Placeholders set to 0<\/h4><\/summary>/);
	assert.match(elements.get('gl-opening-details').innerHTML, /data-fold="counted" open>/);
	listeners.get('gl-opening-details:toggle')({ target: { dataset: { fold: 'placeholders' }, open: false } });
	listeners.get('gl-opening-min-qty:change')();
	await settle(600);
	const details = elements.get('gl-opening-details').innerHTML;
	assert.match(details, /data-fold="placeholders"><summary>/);
	assert.match(details, /data-fold="counted" open>/);
	assert.match(details, /data-fold="journal" open>/);
});

test('a tick refreshes the totals but keeps the tick lists in place; other changes redraw them', async () => {
	const { elements, listeners } = setup([previewResponse(), previewResponse(), previewResponse()]);
	await settle();
	const details = elements.get('gl-opening-details');
	const moved = [];
	details.querySelector = (selector) => ({ selector, scrollTop: 0, contains: () => false, replaceWith(other) { moved.push([this.selector, other.selector]); } });
	listeners.get('gl-opening-details:change')({ target: { closest: () => ({ dataset: { stockId: '3' }, checked: true }) } });
	await settle(600);
	assert.deepEqual(moved.map(([selector]) => selector), [
		'[data-fold="placeholders"] .gl-backfill-table-wrap', '[data-fold="counted"] .gl-backfill-table-wrap'
	], 'both tick lists are put back');
	listeners.get('gl-opening-min-qty:change')();
	await settle(600);
	assert.equal(moved.length, 2, 'a threshold change redraws the lists');
});

test('a slow preview that a newer one overtook is ignored', async () => {
	let answerSlow;
	const slow = new Promise((resolve) => { answerSlow = resolve; });
	const { elements, listeners } = setup([previewResponse(), slow, previewResponse({ cutoverDate: '2026-10-30' })]);
	await settle();
	listeners.get('gl-opening-min-qty:change')();
	await settle(600);
	listeners.get('gl-opening-min-qty:change')();
	await settle(600);
	answerSlow(previewResponse({ cutoverDate: '2026-10-29' }));
	await settle();
	assert.match(elements.get('gl-opening-details').innerHTML, /Journal on 2026-10-30/);
	assert.equal(elements.get('btn-gl-opening-post').disabled, false);
});

test('every counted item is listed, with raw values to sort by', async () => {
	const counted = Array.from({ length: 60 }, (_, i) => row(100 + i, `P${i}`, 1, 1000 - i));
	const { elements } = setup([previewResponse({ lists: { ...previewResponse().lists, counted }, summary: { ...previewResponse().summary, counted: { items: 60, value: 1, quantity: 60 } } })]);
	await settle();
	const details = elements.get('gl-opening-details').innerHTML;
	assert.equal(details.match(/data-opening-toggle="counted"/g).length, 60);
	assert.doesNotMatch(details, /Showing/);
	assert.match(details, /<td class="gl-backfill-num" data-sort="1000">/);
	assert.match(details, /data-sort-col="0" data-sort-first="desc" title="Sort by Set to 0"/);
});

test('a column title sorts its list in place, and a second click reverses it', async () => {
	const { listeners } = setup([previewResponse()]);
	await settle();
	const cell = (text, sort) => ({ textContent: text, dataset: sort === undefined ? {} : { sort: String(sort) }, querySelector: () => null });
	const fakeRow = (part, value, ticked) => ({ part, cells: [{ querySelector: () => ({ checked: ticked }) }, cell(part), cell(`${part} item`), cell('1', 1), cell('1.00', 1), cell(String(value), value)] });
	const body = { rows: [fakeRow('B10', 5, false), fakeRow('a2', 300, false), fakeRow('B9', 20, true)], append(...rows) { this.rows = rows; } };
	const ths = [0, 1, 2, 3, 4, 5].map((cellIndex) => ({ cellIndex, setAttribute(name, value) { this[name] = value; } }));
	const wrap = { querySelector: () => body, querySelectorAll: () => ths };
	const click = (col, first) => listeners.get('gl-opening-details:click')({ target: { closest: (selector) => selector !== '[data-sort-col]' ? null : {
		dataset: { sortCol: String(col), ...(first ? { sortFirst: first } : {}) },
		closest: (s) => (s === '[data-fold]' ? { dataset: { fold: 'counted' } } : wrap)
	} } });
	const parts = () => body.rows.map((r) => r.part);
	click(5, 'desc');
	assert.deepEqual(parts(), ['a2', 'B9', 'B10'], 'largest value first');
	assert.equal(ths[5]['aria-sort'], 'descending');
	assert.equal(ths[1]['aria-sort'], 'none');
	click(5, 'desc');
	assert.deepEqual(parts(), ['B10', 'B9', 'a2'], 'the second click reverses it');
	assert.equal(ths[5]['aria-sort'], 'ascending');
	click(1);
	assert.deepEqual(parts(), ['a2', 'B9', 'B10'], 'part numbers A to Z, their digits in number order');
	click(0, 'desc');
	assert.equal(parts()[0], 'B9', 'ticked items first');
});

test('the post dialog shows the stock take, the journal and how Inventory gets there, and warns of a large clearing', async () => {
	const open = async (overrides) => {
		const { listeners, context } = setup([previewResponse(overrides)]);
		const shown = [];
		context.window.Modal = { custom: async (options) => { shown.push(options); return false; } };
		await settle();
		await listeners.get('btn-gl-opening-post:click')();
		assert.equal(shown[0].size, 'xl', 'a wide dialog');
		return shown[0].contentHTML;
	};
	const html = await open();
	assert.match(html, /^<div class="gl-control-fix gl-confirm-grid">/);
	assert.equal(html.match(/<div class="gl-confirm-table">/g).length, 3, 'stock take, journal and Inventory each in a grid cell');
	assert.match(html, /<strong>tenant_a<\/strong> on <strong>2026-10-31<\/strong>/);
	assert.match(html, /<td>Counted<\/td><td class="gl-backfill-num">2<\/td><td class="gl-backfill-num">150.00<\/td>/);
	assert.match(html, /<td>3200 Inventory<\/td><td class="gl-backfill-num">136.853.63<\/td><td class="gl-backfill-num"><\/td>/);
	assert.match(html, /<td>Left by the backfill<\/td><td class="gl-backfill-num">-136.663.63<\/td>/);
	assert.match(html, /<td>Stock on open jobs<\/td><td class="gl-backfill-num">40.00<\/td>/);
	assert.match(html, /gl-confirm-total"><td>Inventory after<\/td><td class="gl-backfill-num">190.00<\/td>/);
	assert.match(html, /gl-backfill-warning">The backfill clearing \(136.663.63\) is larger than the stock counted\. It goes to 4900 Opening Balances/);

	const small = await open({ summary: { ...previewResponse().summary, inventoryBalance: -100, inventoryAfter: 190 } });
	assert.doesNotMatch(small, /gl-backfill-warning/);
});

test('a blocked preview cannot be posted, and a posted take offers undo', async () => {
	const blockedView = setup([previewResponse({ canPost: false, blockers: ['Map the Opening Stock control account to an Equity account in the Tenant Check.'] })]);
	await settle();
	assert.equal(blockedView.elements.get('btn-gl-opening-post').disabled, true);
	assert.match(blockedView.elements.get('gl-opening-scope').innerHTML, /gl-backfill-blocked">Map the Opening Stock/);

	const posted = { takeid: 2, takedate: '2026-10-31', status: 'FINALISED', lines: 1771, value: 2490150.09, journal: { id: 363, total: 2675031.58, inventory: 2657060.75 },
		inventoryAtCutover: 2520397.12, inventoryNow: 2520397.12, valuationNow: 2490150.08, canUndo: true, undoBlockers: [] };
	const postedView = setup([{ success: true, schema: 'tenant_a', missingTables: [], busy: false, posted }]);
	await settle();
	assert.match(postedView.elements.get('gl-opening-scope').innerHTML, /Posted on 2026-10-31: stock take ST-2, 1.771 items worth 2.490.150.09/);
	assert.equal(postedView.elements.get('btn-gl-opening-post').hidden, true);
	assert.equal(postedView.elements.get('btn-gl-opening-post-top').hidden, true);
	assert.equal(postedView.elements.get('btn-gl-opening-undo').hidden, false);
	assert.equal(postedView.elements.get('btn-gl-opening-undo').disabled, false);
	assert.equal(postedView.elements.get('gl-opening-date').disabled, true);
});

// A response whose NDJSON body the test sends one event at a time.
function ndjsonResponse() {
	const encoder = new TextEncoder();
	const queue = [];
	const waiting = [];
	const push = (chunk) => (waiting.length ? waiting.shift()(chunk) : queue.push(chunk));
	const reader = { read: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiting.push(resolve))) };
	return {
		response: { ok: true, headers: { get: () => 'application/x-ndjson' }, body: { getReader: () => reader } },
		send: (event) => push({ done: false, value: encoder.encode(`${JSON.stringify(event)}\n`) }),
		end: () => push({ done: true })
	};
}

const postedTake = { takeid: 1, takedate: '2026-10-31', status: 'FINALISED', lines: 1762, value: 2041282.39, journal: { id: 98, total: 3037001.29, inventory: 1071750.55 },
	inventoryAtCutover: 2047869.63, inventoryNow: 2047869.63, valuationNow: 2041282.37, canUndo: true, undoBlockers: [] };

test('posting shows the bouncing dots and each step under the form, keeps the inputs still, then shows the result', async () => {
	const { elements, listeners, context } = setup([previewResponse()]);
	await settle();
	context.TextDecoder = TextDecoder;
	context.window.Modal = { custom: async () => true };
	const stream = ndjsonResponse();
	context.fetch = async (url) => (url.endsWith('/opening-stock/post') ? stream.response
		: { ok: true, json: async () => ({ success: true, schema: 'tenant_a', missingTables: [], busy: false, posted: postedTake }) });

	const posting = listeners.get('btn-gl-opening-post-top:click')();
	await settle();
	const details = elements.get('gl-opening-details');
	assert.match(details.innerHTML, /^<div class="gl-backfill-working" role="status"><span class="gl-dots" aria-hidden="true"/);
	assert.equal(details.innerHTML.match(/<span style="--i:\d"><\/span>/g).length, 7, 'seven dots');
	assert.match(details.innerHTML, /<strong>Posting the opening stock…<\/strong> Starting/);
	assert.equal(elements.get('gl-opening-min-qty').disabled, true, 'the threshold waits for the post');
	assert.equal(elements.get('gl-opening-date').disabled, true);
	assert.equal(elements.get('btn-gl-opening-post-top').disabled, true);

	stream.send({ type: 'progress', phase: 'read' });
	await settle();
	assert.match(details.innerHTML, /Posting the opening stock…<\/strong> Reading the legacy stock</);
	stream.send({ type: 'progress', phase: 'stock', processed: 1000, total: 1762 });
	await settle();
	assert.match(details.innerHTML, /Setting quantities: 1.000 of 1.762</);

	stream.send({ type: 'complete', takeid: 1, takedate: '2026-10-31', lines: 1762, value: 2041282.39, inventoryAtCutover: 2047869.63 });
	stream.end();
	await posting;
	assert.equal(details.innerHTML, '', 'the posted card has no lists or progress left');
	assert.match(elements.get('gl-opening-result').innerHTML, /Posted stock take ST-1 on 2026-10-31: 1.762 items worth 2.041.282.39/);
	assert.equal(elements.get('btn-gl-opening-undo').hidden, false);
});

test('undo shows the bouncing dots and what it is undoing until it finishes', async () => {
	const { elements, listeners, context } = setup([{ success: true, schema: 'tenant_a', missingTables: [], busy: false, posted: postedTake }]);
	await settle();
	context.window.Modal = { custom: async () => true };
	let answer;
	context.fetch = (url) => (url.endsWith('/opening-stock/undo')
		? new Promise((resolve) => { answer = () => resolve({ ok: true, json: async () => ({ success: true, restored: 1762, journalDeleted: true }) }); })
		: Promise.resolve({ ok: true, json: async () => previewResponse() }));

	const undoing = listeners.get('btn-gl-opening-undo:click')();
	await settle();
	const details = elements.get('gl-opening-details');
	assert.match(details.innerHTML, /gl-dots.*<strong>Undoing the opening stock…<\/strong> Setting 1.762 items back to 0 and deleting journal ST-1/s);
	assert.equal(elements.get('btn-gl-opening-undo').disabled, true);
	answer();
	await undoing;
	assert.match(details.innerHTML, /Journal on 2026-10-31/, 'the preview comes back');
	assert.match(elements.get('gl-opening-result').innerHTML, /Undone: 1.762 items set back to 0 and the journal deleted/);
});
