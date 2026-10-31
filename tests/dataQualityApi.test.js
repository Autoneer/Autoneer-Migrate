const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { state } = require('../src/config/state');
const { createStore, ROOT } = require('../src/migrate/dataQuality/store');
const { router, startAuditJob } = require('../src/routes/api/dataQuality');
const auditService = require('../src/migrate/dataQuality/service');

test('group preview is read-only and confirmed decisions are scoped, saved and undoable', async t => {
	const previous = { mysql: state.mysql, schemaName: state.schemaName };
	state.mysql = { host: 'quality-group-api-test' }; state.schemaName = 'tenant-' + require('node:crypto').randomUUID();
	const scope = { mysqlConfig: state.mysql, schemaName: state.schemaName };
	const base = path.join(ROOT, require('../src/migrate/dataQuality/store').scopeKey(scope));
	t.after(async () => { state.mysql = previous.mysql; state.schemaName = previous.schemaName; assert.ok(path.resolve(base).startsWith(path.resolve(ROOT) + path.sep)); await fs.promises.rm(base, { recursive: true, force: true }); });
	const store = await createStore(scope);
	const report = { id: store.id, planId: 4, status: 'blocked', tables: [] };
	await store.save(report);
	await fs.promises.writeFile(path.join(store.dir, 'quarantine.ndjson'), JSON.stringify({ table: 'staff', ordinal: 0, action: 'review', source: { id: 1 }, reasons: [{ code: 'TARGET_KEY_CONFLICT', column: 'id', message: 'Already exists' }] }) + '\n');
	const data = await require('../src/migrate/dataQuality/groups').loadGroups(store.dir, report);
	const group = data.groups[0].id;
	const call = async (operation, body) => {
		const handler = router.stack.find(layer => layer.route?.path === '/quality-audits/:id/groups/' + operation).route.stack[0].handle;
		const res = { statusCode: 200, status(value) { this.statusCode = value; return this; }, type() { return this; }, send(value) { this.body = value; return this; }, redirect(value) { this.location = value; } };
		await handler({ params: { id: store.id }, body }, res); return res;
	};
	const { readDecisions } = require('../src/migrate/dataQuality/decisions');
	assert.match((await call('preview', { group, action: 'exclude' })).body, /Keep the destination records/);
	assert.deepEqual(await readDecisions(scope), {});
	assert.equal((await call('apply', { group: 'unknown', action: 'exclude' })).statusCode, 400);
	const applied = await call('apply', { group, action: 'exclude' });
	assert.match(applied.location, new RegExp(`/groups\\?group=${group}&saved=1$`));
	const decisions = await readDecisions(scope);
	assert.equal(Object.values(decisions)[0].records.length, 1);
	const undone = await call('undo', { decision: Object.keys(decisions)[0] });
	assert.match(undone.location, new RegExp(`/groups\\?group=${group}&undone=1$`));
	assert.deepEqual(await readDecisions(scope), {});
});

async function invoke(id, query = {}, stop = false) {
	const handler = router.stack.find(layer => layer.route?.path === (stop ? '/quality-audits/:id/stop' : id === 'active' ? '/quality-audits/active' : '/quality-audits/:id')).route.stack[0].handle;
	const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; },
		attachment(name) { this.filename = name; return this; }, download(file, name) { this.file = file; this.filename = name; return this; } };
	await handler({ params: { id }, query }, response);
	return response;
}

test('report and quarantine downloads are restricted to the selected target scope', async t => {
	const previous = { mysql: state.mysql, schemaName: state.schemaName };
	state.mysql = { host: 'quality-api-test', port: 3306 }; state.schemaName = 'tenant_one';
	t.after(() => { state.mysql = previous.mysql; state.schemaName = previous.schemaName; });
	const store = await createStore({ mysqlConfig: state.mysql, schemaName: state.schemaName });
	t.after(() => { assert.ok(path.resolve(store.dir).startsWith(path.resolve(ROOT) + path.sep)); return fs.promises.rm(store.dir, { recursive: true, force: true }); });
	await store.save({ id: store.id, status: 'ready', tables: [], totals: { quarantined: 1 } });
	await fs.promises.writeFile(path.join(store.dir, 'quarantine.ndjson'), '{"source":{"id":1}}\n');
	const report = await invoke(store.id);
	assert.equal(report.body.report.status, 'ready');
	assert.equal((await invoke(store.id, { download: 'quarantine' })).file, path.join(store.dir, 'quarantine.ndjson'));
	state.schemaName = 'tenant_two';
	assert.equal((await invoke(store.id)).statusCode, 404);
	assert.equal((await invoke('../outside')).statusCode, 400);
});

test('preview stop is tenant scoped, idempotent, and waits for cleanup before reporting cancellation', async t => {
	const previous = { mysql: state.mysql, schemaName: state.schemaName };
	state.mysql = { host: 'quality-stop-test' }; state.schemaName = 'tenant_one';
	t.after(() => { state.mysql = previous.mysql; state.schemaName = previous.schemaName; });
	let release, releaseCleanup, started, ended, store;
	const work = new Promise(resolve => { release = resolve; });
	const cleanup = new Promise(resolve => { releaseCleanup = resolve; });
	const running = new Promise(resolve => { started = resolve; });
	const closed = new Promise(resolve => { ended = resolve; });
	t.mock.method(auditService, 'createAudit', async options => {
		store = options.auditStore;
		started();
		await work;
		try { options.checkAbort(); assert.fail('stop should abort'); }
		catch (err) { assert.equal(err.code, 'AUDIT_CANCELLED'); await store.save({ id: store.id, status: 'cancelled' }); }
	});
	const id = await startAuditJob({ mysqlConfig: state.mysql, schemaName: state.schemaName, pool: { end: async () => { await cleanup; ended(); } } });
	t.after(async () => { release(); releaseCleanup(); await closed; assert.ok(path.resolve(store.dir).startsWith(path.resolve(ROOT) + path.sep)); await fs.promises.rm(store.dir, { recursive: true, force: true }); });
	await running;
	assert.equal((await invoke('active')).body.report.id, id);
	await assert.rejects(startAuditJob({ mysqlConfig: state.mysql, schemaName: state.schemaName }), err => err.auditId === id);
	state.schemaName = 'tenant_two';
	assert.equal((await invoke('active')).body.report, null);
	assert.equal((await invoke(id, {}, true)).statusCode, 404);
	state.schemaName = 'tenant_one';
	assert.equal((await invoke(id, {}, true)).body.status, 'stopping');
	assert.equal((await invoke(id, {}, true)).body.status, 'stopping');
	assert.equal((await invoke(id)).body.report.status, 'stopping');
	release();
	// Pool cleanup is held open: cancellation must not be shown as finished yet.
	assert.equal((await invoke(id)).body.report.status, 'stopping');
	releaseCleanup();
	await closed;
	await new Promise(resolve => setImmediate(resolve));
	assert.equal((await invoke(id)).body.report.status, 'cancelled');
	assert.equal((await invoke('active')).body.report, null);
	assert.equal((await invoke(id, { download: 'quarantine' })).statusCode, 409);
	assert.equal((await invoke(id, {}, true)).body.status, 'cancelled');
});

test('an interrupted preview is reported as failed instead of polling forever', async t => {
	const previous = { mysql: state.mysql, schemaName: state.schemaName };
	state.mysql = { host: 'quality-api-test' }; state.schemaName = 'interrupted';
	t.after(() => { state.mysql = previous.mysql; state.schemaName = previous.schemaName; });
	const store = await createStore({ mysqlConfig: state.mysql, schemaName: state.schemaName });
	t.after(() => { assert.ok(path.resolve(store.dir).startsWith(path.resolve(ROOT) + path.sep)); return fs.promises.rm(store.dir, { recursive: true, force: true }); });
	await store.save({ id: store.id, status: 'running' });
	const response = await invoke(store.id);
	assert.equal(response.body.report.status, 'failed');
	assert.equal((await invoke(store.id, { download: 'quarantine' })).statusCode, 409);
});

test('single records can be left out or corrected from a repair group and return to that group', async t => {
	const previous = { mysql: state.mysql, schemaName: state.schemaName };
	state.mysql = { host: 'quality-record-api-test' }; state.schemaName = 'tenant-' + require('node:crypto').randomUUID();
	const scope = { mysqlConfig: state.mysql, schemaName: state.schemaName };
	const base = path.join(ROOT, require('../src/migrate/dataQuality/store').scopeKey(scope));
	t.after(async () => { state.mysql = previous.mysql; state.schemaName = previous.schemaName; assert.ok(path.resolve(base).startsWith(path.resolve(ROOT) + path.sep)); await fs.promises.rm(base, { recursive: true, force: true }); });
	const store = await createStore(scope);
	const report = { id: store.id, planId: 4, status: 'blocked', tables: [], mapping: { STOCK: { columns: { PARTNR: { target: 'partnr' } } } } };
	await store.save(report);
	const rows = [1, 2].map(ordinal => ({ table: 'stock', sourceTable: 'STOCK', ordinal, action: 'review', source: { partnr: 'OIL', n: ordinal }, reasons: [{ code: 'DUPLICATE_KEY', column: 'partnr', message: 'Duplicate' }] }));
	await fs.promises.writeFile(path.join(store.dir, 'quarantine.ndjson'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
	const group = (await require('../src/migrate/dataQuality/groups').loadGroups(store.dir, report)).groups[0].id;
	const call = async (route, body) => {
		const handler = router.stack.find(layer => layer.route?.path === route).route.stack[0].handle;
		const res = { statusCode: 200, status(value) { this.statusCode = value; return this; }, type() { return this; }, send(value) { this.body = value; return this; }, redirect(value) { this.location = value; } };
		await handler({ params: { id: store.id }, body }, res); return res;
	};
	const { readDecisions } = require('../src/migrate/dataQuality/decisions');
	const left = await call('/quality-audits/:id/groups/exclude-record', { group, table: 'stock', ordinal: '2' });
	assert.ok(left.location.endsWith(`/groups?group=${group}#records`));
	assert.equal(Object.values(await readDecisions(scope))[0].records.length, 1);
	await call('/quality-audits/:id/groups/exclude-record', { group, table: 'stock', ordinal: '2', undo: '1' });
	assert.deepEqual(await readDecisions(scope), {});
	const groupPage = `/api/quality-audits/${store.id}/groups?group=${group}#records`;
	// Saving the unchanged value would leave the record failing on every scan, so it is refused.
	assert.equal((await call('/quality-audits/:id/correct', { table: 'stock', ordinal: '1', field: 'partnr', value: 'OIL', returnTo: groupPage })).statusCode, 400);
	assert.equal((await call('/quality-audits/:id/correct', { table: 'stock', ordinal: '1', field: 'partnr', value: 'OIL-2', returnTo: groupPage })).location, groupPage);
	assert.match((await call('/quality-audits/:id/correct', { table: 'stock', ordinal: '1', field: 'partnr', value: 'OIL-2', returnTo: 'https://example.com/' })).location, /\/view\?table=stock&saved=1$/);
});

test('saving all suggested decisions skips groups without a safe suggestion unless asked', async t => {
	const previous = { mysql: state.mysql, schemaName: state.schemaName };
	state.mysql = { host: 'quality-bulk-api-test' }; state.schemaName = 'tenant-' + require('node:crypto').randomUUID();
	const scope = { mysqlConfig: state.mysql, schemaName: state.schemaName };
	const base = path.join(ROOT, require('../src/migrate/dataQuality/store').scopeKey(scope));
	t.after(async () => { state.mysql = previous.mysql; state.schemaName = previous.schemaName; assert.ok(path.resolve(base).startsWith(path.resolve(ROOT) + path.sep)); await fs.promises.rm(base, { recursive: true, force: true }); });
	const store = await createStore(scope);
	const report = { id: store.id, planId: 4, status: 'blocked', tables: [] };
	await store.save(report);
	const rows = [
		{ table: 'staff', ordinal: 0, action: 'review', source: { id: 1 }, reasons: [{ code: 'TARGET_KEY_CONFLICT', column: 'id', message: 'Already exists' }] },
		{ table: 'stock', ordinal: 0, action: 'review', source: { partnr: 'A' }, reasons: [{ code: 'DUPLICATE_KEY', column: 'partnr', message: 'Duplicate' }] }
	];
	await fs.promises.writeFile(path.join(store.dir, 'quarantine.ndjson'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
	const call = async body => {
		const handler = router.stack.find(layer => layer.route?.path === '/quality-audits/:id/groups/apply-all').route.stack[0].handle;
		const res = { statusCode: 200, status(value) { this.statusCode = value; return this; }, send(value) { this.body = value; return this; }, redirect(value) { this.location = value; } };
		await handler({ params: { id: store.id }, body }, res); return res;
	};
	const { readDecisions } = require('../src/migrate/dataQuality/decisions');
	const first = await call({});
	assert.ok(first.location.endsWith('/groups?bulk=1'));
	assert.deepEqual(Object.values(await readDecisions(scope)).map(item => item.description.split(':')[0]), ['staff']);
	// The staff group is already decided, so only the duplicate group is added when review groups are included.
	const second = await call({ includeReview: '1' });
	assert.ok(second.location.endsWith('/groups?bulk=1'));
	assert.deepEqual(Object.values(await readDecisions(scope)).map(item => item.description.split(':')[0]).sort(), ['staff', 'stock']);
});
