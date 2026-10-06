const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const mysql = require('../src/db/mysql');
const runStore = require('../src/migrate/runStore');
const router = require('../src/routes/api/mappings');
const profilesRouter = require('../src/routes/api/profiles');

const invoiceTables = () => ({ INVOICES: { targetTable: 'INVOICES', columns: {
	INVOICEID: { sourceColumn: 'INVOICEID', targetColumn: 'INVOICEID', transform: null, defaultValue: null, lookup: null, omit: false },
	UNUSED: { sourceColumn: 'UNUSED', targetColumn: null, transform: null, defaultValue: null, lookup: null, omit: true }
} } });

function setup(t) {
	const profiles = new Map();
	const mappings = new Map();
	const requests = [];
	let nextId = 20;
	let updateStatus = null;
	const pool = { end: async () => {} };
	t.mock.method(mysql, 'connectToSchema', async () => pool);
	t.mock.method(mysql, 'ensureMigrationTables', async () => {});
	t.mock.method(runStore, 'saveProfile', async (_, row) => {
		profiles.set('7', { profile_id: 7, name: row.name, mapping_json: JSON.stringify(row.mappingJson) });
		return 7;
	});
	t.mock.method(runStore, 'getProfile', async (_, id) => profiles.get(String(id)) || null);
	t.mock.method(runStore, 'getMappingProfile', async (_, id) => mappings.get(String(id)) || null);
	t.mock.method(runStore, 'saveMappingProfile', async (_, row) => {
		const id = nextId++;
		mappings.set(String(id), { id, name: row.name, mapping_json: row.mappingJson });
		return id;
	});
	t.mock.method(runStore, 'updateMappingProfile', async (_, id, row) => {
		Object.assign(mappings.get(String(id)), { name: row.name, mapping_json: row.mappingJson });
	});
	const saved = new Map();
	const select = { value: '7' };
	const errors = [];
	const context = vm.createContext({
		window: {}, console: { log() {}, info() {}, warn() {}, error() {} },
		URLSearchParams, AbortController, setTimeout, clearTimeout,
		localStorage: { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
		document: { getElementById: id => id === 'profile-load-select' ? select : null },
		Modal: {
			alert: data => { if (data.title === 'Error') errors.push(data.message); },
			custom: async options => options.onConfirm({ querySelector: id => ({ value: id === '#save-profile-name' ? 'INVOICES' : '' }) })
		},
		fetch: async (url, options = {}) => {
			const method = options.method || 'GET';
			const body = options.body ? JSON.parse(options.body) : {};
			requests.push({ url, method, body });
			let status = 200, result;
			if (method === 'PUT' && updateStatus) {
				status = updateStatus;
				result = { success: false, error: 'Database unavailable' };
			} else {
				const id = url.split('/')[3];
				const isProfile = url.startsWith('/api/profiles');
				const routeBase = isProfile ? '/profiles' : '/mappings';
				const routePath = id ? `${routeBase}/:id` : routeBase;
				const handler = (isProfile ? profilesRouter : router).stack.find(layer => layer.route?.path === routePath && layer.route.methods[method.toLowerCase()]).route.stack[0].handle;
				const res = { status(code) { status = code; return this; }, json(data) { result = data; } };
				await handler({ params: { id }, body }, res);
			}
			return { ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => result };
		}
	});
	for (const file of ['utils/storage.js', 'utils/state.js', 'api/client.js', 'api/mapping-api.js', 'steps/mapping-ui.js']) {
		vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/public/js', file), 'utf8'), context);
	}
	context.window.apiClient.maxRetries = 1;
	const state = context.window.WizardState;
	const ui = new context.window.MappingUI({ clearMessages() {}, showLoading() {}, hideLoading() {}, showError: message => errors.push(message) });
	ui.render = () => {};
	ui.loadProfiles = async () => {};
	return { ui, state, context, profiles, mappings, requests, errors, setUpdateStatus: status => { updateStatus = status; } };
}

test('saving and loading an INVOICES snapshot creates a separate mapping and retains fields across reload and Next', async t => {
	const { ui, state, profiles, mappings, requests, errors } = setup(t);
	const unrelated = { id: 3, name: 'Other mapping', mapping_json: JSON.stringify({ id: 3, name: 'Other mapping', tables: {} }) };
	mappings.set('3', unrelated);
	ui.mapping = {
		id: 3, mappingProfileId: 3, profileId: 3, name: 'Original name', tables: invoiceTables()
	};
	await ui.handleSaveProfile();
	assert.equal(profiles.get('7').name, 'INVOICES');
	await ui.handleLoadProfile();
	assert.equal(ui.mapping.name, 'INVOICES');
	assert.equal(ui.mapping.id, null);
	assert.equal(ui.mapping.mappingProfileId, null);
	assert.equal(ui.mapping.profileId, null);
	assert.equal(ui.savedProfileId, 7);
	assert.equal(ui.selectedTables.has('INVOICES'), true);
	assert.equal(await ui.onNext(), true);
	assert.equal(ui.mapping.id, 20);
	assert.equal(state.get('mapping.mappingProfileId'), 20);
	assert.equal(state.normalizePlanInState().mappingProfileId, 20);
	assert.deepEqual(JSON.parse(mappings.get('20').mapping_json).tables, invoiceTables());
	assert.equal(mappings.get('3').name, 'Other mapping');
	assert.equal(requests.some(req => req.method === 'PUT' && req.url.endsWith('/3')), false);
	state.initialize();
	ui.mapping = state.get('mapping');
	assert.equal(await ui.onNext(), true);
	assert.equal(mappings.size, 2);
	assert.deepEqual(JSON.parse(JSON.stringify(ui.mapping.tables)), invoiceTables());
	assert.deepEqual(errors, []);
});

test('Next recovers a stale browser mapping ID without losing the invoice configuration', async t => {
	const { ui, state, mappings, requests, errors } = setup(t);
	ui.mapping = { id: 'deleted-mapping-uuid', name: 'INVOICES', tables: invoiceTables() };
	ui.selectedTables.add('INVOICES');
	state.updateMapping(ui.mapping);
	assert.equal(await ui.onNext(), true);
	assert.deepEqual(requests.map(req => req.method), ['PUT', 'POST']);
	assert.equal(state.get('mapping.id'), 20);
	assert.equal(state.get('mapping.mappingProfileId'), 20);
	assert.deepEqual(JSON.parse(mappings.get('20').mapping_json).tables, invoiceTables());
	assert.deepEqual(errors, []);
});

test('a server error blocks Next without creating a duplicate mapping', async t => {
	const { ui, mappings, requests, errors, setUpdateStatus } = setup(t);
	ui.mapping = { id: 3, name: 'INVOICES', tables: invoiceTables() };
	ui.selectedTables.add('INVOICES');
	setUpdateStatus(500);
	assert.equal(await ui.onNext(), false);
	assert.deepEqual(requests.map(req => req.method), ['PUT']);
	assert.equal(mappings.size, 0);
	assert.equal(ui.mapping.id, 3);
	assert.deepEqual(errors, ['Failed to save profile: Database unavailable']);
});

test('mapping reads and updates use the stored row ID instead of an embedded stale UUID', async t => {
	const { context, mappings } = setup(t);
	mappings.set('4', { id: 4, name: 'INVOICES', mapping_json: JSON.stringify({ id: 'old-uuid', name: 'INVOICES', tables: invoiceTables() }) });
	const loaded = await context.window.MappingAPI.getById(4);
	assert.equal(loaded.id, 4);
	const updated = await context.window.MappingAPI.update(4, loaded);
	assert.equal(updated.id, 4);
	assert.equal(JSON.parse(mappings.get('4').mapping_json).id, 4);
});
