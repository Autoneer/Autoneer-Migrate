const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseStages, runConversion } = require('../src/migrate/gl/transactionalAccnrConversion');
const sql = fs.readFileSync(path.join(__dirname, '../data/sql/sp_convert_transactional_accnr.sql'), 'utf8');

test('stages use the canonical SQL in order, including all conversion overrides', () => {
	const { stages } = parseStages(sql);
	assert.equal(stages.length, 19);
	assert.equal(new Set(stages.map(stage => stage.table)).size, 11);
	assert.deepEqual(stages.filter(stage => stage.table === 'stock').map(stage => stage.field), ['siid', 'acc', 'accasset']);
	assert.deepEqual(stages.filter(stage => stage.table === 'payments_suppliers').map(stage => stage.field), ['accnr', 'acc']);
	const updates = sql.match(/UPDATE\s+\w+\s+t\b[\s\S]*?;/g);
	assert.deepEqual(stages.map(stage => stage.sql), updates.map(statement => statement.slice(0, -1)));
	for (const stage of stages) {
		assert.match(stage.sql, /1601200 THEN 6200/);
		assert.match(stage.sql, /1601300 THEN 6301/);
		assert.match(stage.sql, /6606300 THEN 6302/);
		assert.match(stage.sql, /a\.accclass <> 7/);
	}
});

test('unsupported SQL fails validation before conversion can start', () => {
	assert.throws(() => parseStages(sql.replace('UPDATE customers t', 'DELETE FROM customers t')), /Unsupported/);
	assert.throws(() => parseStages(sql.replace("SELECT 'OK' AS status", 'SELECT 1')), /summary/);
});

test('reports the active field before the query finishes, then each completed field', async () => {
	const events = [];
	const queries = [];
	let finishFirst;
	const pool = { query: async statement => {
		queries.push(statement);
		if (queries.length === 1) await new Promise(resolve => { finishFirst = resolve; });
		return [[{ status: 'OK' }]];
	} };
	const running = runConversion(pool, event => events.push(structuredClone(event)));
	while (!finishFirst) await new Promise(setImmediate);
	assert.equal(events.length, 2);
	assert.equal(events[1].completed, 0);
	assert.equal(events[1].stages[0].status, 'running');
	assert.ok(events[1].stages.slice(1).every(stage => stage.status === 'pending'));
	finishFirst();
	const result = await running;
	assert.equal(queries.length, 20); // 19 UPDATEs and the original summary SELECT.
	assert.equal(result.completed, 19);
	assert.ok(result.stages.every(stage => stage.status === 'completed'));
	for (let index = 0; index < 19; index++) {
		const before = events[1 + index * 2];
		const after = events[2 + index * 2];
		assert.equal(before.completed, index);
		assert.equal(before.stages[index].status, 'running');
		assert.equal(after.completed, index + 1);
		assert.equal(after.stages[index].status, 'completed');
	}
});

test('failed fields retain completed progress and leave later stages pending', async () => {
	const events = [];
	let queries = 0;
	await assert.rejects(runConversion({ query: async () => {
		if (++queries === 5) throw new Error('Database update failed');
		return [{}];
	} }, event => events.push(structuredClone(event))), /stock\.siid: Database update failed/);
	assert.equal(queries, 5);
	const last = events.at(-1);
	assert.equal(last.completed, 4);
	assert.ok(last.stages.slice(0, 4).every(stage => stage.status === 'completed'));
	assert.equal(last.stages[4].status, 'failed');
	assert.ok(last.stages.slice(5).every(stage => stage.status === 'pending'));
});

function routeFixture(t, pool) {
	const mysql = require('../src/db/mysql');
	t.mock.method(mysql, 'connectToSchema', async () => pool);
	const routePath = require.resolve('../src/routes/api/tools');
	delete require.cache[routePath];
	const router = require(routePath);
	const handler = router.stack.find(layer => layer.route?.path === '/tools/convert-transactional-accnr').route.stack[0].handle;
	const events = [];
	const headers = {};
	let close;
	const response = {
		setHeader: (key, value) => { headers[key] = value; }, flushHeaders() {},
		once: (event, callback) => { close = callback; },
		write: line => { events.push(JSON.parse(line)); },
		end() { this.writableEnded = true; close?.(); },
		status(code) { this.statusCode = code; return this; },
		json(value) { this.result = value; }
	};
	return { handler, events, headers, response };
}

test('streaming route delivers preparation, field updates, completion, and closes the pool', async t => {
	let closed = false;
	const { handler, events, headers, response } = routeFixture(t, { query: async () => [[{ status: 'OK' }]], end: async () => { closed = true; } });
	await handler({ get: () => 'application/x-ndjson' }, response);
	assert.equal(headers['Content-Type'], 'application/x-ndjson');
	assert.equal(events[0].type, 'preparing');
	assert.equal(events.at(-1).type, 'complete');
	assert.equal(events.at(-1).completed, 19);
	assert.equal(events.at(-1).success, true);
	assert.equal(response.writableEnded, true);
	assert.equal(closed, true);
});

test('streaming route sends a terminal error with the failing field and closes the pool', async t => {
	let closed = false;
	const { handler, events, response } = routeFixture(t, { query: async () => { throw new Error('Missing table'); }, end: async () => { closed = true; } });
	await handler({ get: () => 'application/x-ndjson' }, response);
	assert.equal(events.at(-2).stages[0].status, 'failed');
	assert.equal(events.at(-1).type, 'error');
	assert.match(events.at(-1).message, /customers\.acc: Missing table/);
	assert.equal(events.some(event => event.type === 'complete'), false);
	assert.equal(closed, true);
});

test('JSON clients keep the stored procedure and original response shape', async t => {
	const queries = [];
	const { handler, events, response } = routeFixture(t, { query: async statement => { queries.push(statement); return [[[{ status: 'OK' }]]]; }, end: async () => {} });
	await handler({ get: () => 'application/json' }, response);
	assert.equal(events.length, 0);
	assert.match(queries[1], /^CREATE PROCEDURE/);
	assert.equal(queries.at(-1), 'CALL sp_convert_transactional_accnr()');
	assert.equal(response.result.success, true);
	assert.deepEqual(response.result.result, [[{ status: 'OK' }]]);
});
