const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function setup(status = 'FAILED') {
	const saved = new Map();
	const elements = new Map();
	const element = () => ({ innerHTML: '', style: {}, classList: { add() {}, remove() {} }, querySelectorAll: () => [], addEventListener() {} });
	const context = vm.createContext({ window: { scrollTo() {} }, console: { log() {}, error() {}, warn() {}, info() {} },
		setTimeout: () => 0, clearInterval() {}, URLSearchParams,
		localStorage: { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
		document: { addEventListener() {}, querySelectorAll: () => [], createElement: element,
			getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); } } });
	for (const file of ['utils/storage.js', 'utils/state.js', 'steps/results-ui.js', 'steps/run-ui.js', 'wizard.js']) {
		vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/public/js', file), 'utf8'), context);
	}
	const state = context.window.WizardState;
	state.set('run.id', 1);
	state.set('run.status', status);
	context.window.RunAPI = { getById: async () => ({ id: 1, status }) };
	const wizard = new context.window.MigrationWizard();
	wizard.steps[3].component = new context.window.RunUI(wizard);
	wizard.steps[3].component.run = { id: 1, status };
	wizard.showError = message => { throw Error(message); };
	return { context, state, wizard, elements };
}

test('Next after failure branches to failure results without completing execution or conversion', async () => {
	const { wizard, state, elements } = setup();
	wizard.currentStep = 4; state.setCurrentStep(4);
	await wizard.nextStep();
	assert.equal(wizard.currentStep, 6);
	assert.equal(wizard.storage.isStepComplete(4), false);
	assert.equal(wizard.storage.isStepComplete(5), false);
	const progress = elements.get('wizard-progress').innerHTML;
	assert.ok(progress.indexOf('Failure Results') < progress.indexOf('Convert Acc Numbers'));
	assert.match(progress, /blocked/);
	// Previous must return to execution, not conversion.
	wizard.steps[3].component.initialize = async () => {};
	await wizard.previousStep();
	assert.equal(wizard.currentStep, 4);
});

test('conversion cannot be opened via stale completed steps, a direct link, or a stopped run', async () => {
	for (const status of ['FAILED', 'COMPLETED_WITH_ERRORS', 'STOPPED', 'CANCELLED']) {
		const { wizard } = setup(status);
		wizard.storage.markStepComplete(4); wizard.storage.markStepComplete(5);
		await wizard.showStep(5);
		assert.equal(wizard.currentStep, 6, status);
	}
});

test('successful run still proceeds to Step 5', async () => {
	const { wizard, state } = setup('SUCCESS');
	wizard.currentStep = 4; state.setCurrentStep(4);
	await wizard.nextStep();
	assert.equal(wizard.currentStep, 5);
	assert.equal(wizard.storage.isStepComplete(4), true);
});

test('amending plan keeps mapping and plan but clears stale run across reloads', async () => {
	const { wizard, state, context } = setup();
	state.set('plan', { id: 2, name: 'Saved plan', tables: ['invoices'], config: { batchSize: 1000 } });
	state.set('mapping', { id: 2, name: 'Saved mapping', tables: { INVOICES: {} } });
	wizard.storage.markStepComplete(3); wizard.storage.markStepComplete(4);
	await wizard.steps[3].component.editMigration(3);
	assert.equal(wizard.currentStep, 3);
	assert.equal(state.get('run.id'), null);
	assert.equal(wizard.storage.getRunId(), null);
	state.initialize();
	assert.equal(state.get('run.id'), null);
	assert.equal(state.get('plan.id'), 2);
	assert.equal(state.get('mapping.id'), 2);
	assert.equal(context.window.WizardStorage.isStepComplete(3), true);
	assert.equal(context.window.WizardStorage.isStepComplete(4), false);
});

test('results escape database error content and identify invoice numbers', () => {
	const { context } = setup();
	const renderer = context.window.ResultsRenderer;
	const html = renderer.renderErrors([{ table: 'invoices', row: 6968, message: '<script>bad()</script>', value: 0 }]);
	assert.match(html, /Source invoice number/);
	assert.match(html, /&lt;script&gt;/);
	assert.doesNotMatch(html, /<script>/);
	assert.match(html, /<code>0<\/code>/);
});
