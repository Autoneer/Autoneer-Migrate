const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup(fetch) {
	const elements = new Map();
	const getElement = key => {
		if (!elements.has(key)) elements.set(key, { innerHTML: '', querySelector: () => ({ addEventListener() {} }) });
		return elements.get(key);
	};
	const context = vm.createContext({ window: { WizardState: { get: () => null } }, fetch, TextDecoder,
		document: { getElementById: getElement, createElement: () => ({ set textContent(value) { this.innerHTML = value.replaceAll('&', '&amp;').replaceAll('<', '&lt;'); } }) } });
	vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/public/js/steps/accnr-convert-ui.js'), 'utf8'), context);
	const wizard = { renderNavigation() {} };
	return { ui: new context.window.AccnrConvertUI(wizard), elements, wizard };
}

function streamResponse(chunks) {
	let index = 0;
	return { ok: true, headers: { get: () => 'application/x-ndjson' }, body: { getReader: () => ({
		read: async () => index < chunks.length ? { value: Buffer.from(chunks[index++]), done: false } : { done: true }, releaseLock() {}
	}) } };
}

test('shows per-field and per-table progress, including the current stage', () => {
	const { ui, elements } = setup();
	ui._updateConversionProgress({ completed: 5, total: 19, stages: [
		{ id: 'customers.acc', status: 'completed' },
		{ id: 'stock.siid', status: 'completed' }, { id: 'stock.acc', status: 'running' }, { id: 'stock.accasset', status: 'pending' }
	] });
	const summary = elements.get('accnr-conversion-progress').innerHTML;
	assert.match(summary, /5 of 19 field stages completed \(26%\)/);
	assert.match(summary, /Stage 6 of 19: Converting stock\.acc/);
	const rows = elements.get('accnr-conversion-rows').innerHTML;
	assert.match(rows, /accnr-field-completed.*?<code>siid<\/code>: Done/s);
	assert.match(rows, /accnr-field-running.*?<code>acc<\/code>: Converting/s);
	assert.match(rows, /accnr-field-pending.*?<code>accasset<\/code>: Waiting/s);
	assert.match(rows, /aria-label="stock fields completed".*?<small>1 \/ 3 fields/s);
});

test('reads split JSON messages and multiple messages in one chunk', async () => {
	const { ui } = setup();
	const events = [
		{ type: 'preparing' }, { type: 'progress', completed: 0, total: 1, stages: [{ id: 'customers.acc', status: 'running' }] },
		{ type: 'heartbeat' }, { type: 'complete', completed: 1, total: 1, stages: [{ id: 'customers.acc', status: 'completed' }] }
	].map(event => JSON.stringify(event)).join('\n');
	await ui._readConversionStream(streamResponse([events.slice(0, 47), events.slice(47, 63), events.slice(63)]));
	assert.equal(ui._conversionProgress.completed, 1);
	assert.equal(ui._conversionProgress.stages[0].status, 'completed');
});

test('conversion stays busy and blocks duplicate requests and navigation while streaming', async () => {
	let resolve;
	let calls = 0;
	const { ui, wizard } = setup(async (_, options) => {
		calls++;
		assert.equal(options.headers.Accept, 'application/x-ndjson');
		return new Promise(done => { resolve = done; });
	});
	const running = ui._runConversion();
	assert.equal(ui._busy, true);
	assert.equal(wizard._isBusy, true);
	assert.equal(await ui.onNext(), false);
	assert.equal(await ui.onPrevious(), false);
	await ui._runConversion();
	assert.equal(calls, 1);
	resolve(streamResponse([JSON.stringify({ type: 'complete', completed: 19, total: 19, stages: [] }) + '\n']));
	await running;
	assert.equal(ui._converted, true);
	assert.equal(ui._busy, false);
	assert.equal(wizard._isBusy, false);
	assert.equal(await ui.onNext(), true);
});

test('server errors show the failing stage while preserving completed fields', async () => {
	const response = streamResponse([
		JSON.stringify({ type: 'progress', completed: 1, total: 19, stages: [{ id: 'customers.acc', status: 'completed' }, { id: 'suppliers.acc', status: 'failed' }] }) + '\n',
		JSON.stringify({ type: 'error', message: 'suppliers.acc: Update failed' }) + '\n'
	]);
	const { ui, elements } = setup(async () => response);
	await ui._runConversion();
	assert.equal(ui._converted, false);
	assert.equal(ui._conversionProgress.completed, 1);
	assert.match(elements.get('accnr-convert-content').innerHTML, /Failed: suppliers\.acc/);
	assert.match(elements.get('accnr-convert-content').innerHTML, /Conversion failed: suppliers\.acc: Update failed/);
	assert.equal(ui._busy, false);
});

test('a disconnected stream cannot be mistaken for a successful conversion', async () => {
	const response = streamResponse([JSON.stringify({ type: 'progress', completed: 0, total: 19,
		stages: [{ id: 'customers.acc', status: 'running' }] }) + '\n']);
	const { ui, elements } = setup(async () => response);
	await ui._runConversion();
	assert.equal(ui._converted, false);
	assert.equal(ui._conversionProgress.stages[0].status, 'interrupted');
	assert.match(elements.get('accnr-convert-content').innerHTML, /may still be running on the server/);
	assert.match(elements.get('accnr-convert-content').innerHTML, /Interrupted/);
});

test('JSON fallback completes all field indicators with an older server', async () => {
	const { ui } = setup(async () => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => ({ success: true }) }));
	await ui._runConversion();
	assert.equal(ui._converted, true);
	assert.equal(ui._conversionProgress.completed, 19);
	assert.equal(ui._conversionProgress.stages.length, 19);
	assert.ok(ui._conversionProgress.stages.every(stage => stage.status === 'completed'));
});
