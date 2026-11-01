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
	return { elements, listeners, requests };
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
	assert.equal(elements.get('btn-gl-opening-post').disabled, false);
	assert.equal(elements.get('btn-gl-opening-undo').hidden, true);
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
	assert.equal(postedView.elements.get('btn-gl-opening-undo').hidden, false);
	assert.equal(postedView.elements.get('btn-gl-opening-undo').disabled, false);
	assert.equal(postedView.elements.get('gl-opening-date').disabled, true);
});
