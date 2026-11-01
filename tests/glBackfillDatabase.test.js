const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../src/migrate/gl/glBackfill/mirror/database/database");

function fakePool(name, { failCommits = 0 } = {}) {
	const pool = { name, calls: [], connections: [] };
	pool.query = async (sql, params) => {
		pool.calls.push({ sql, params });
		return [[{ pool: name, sql }], [{ name: "fields" }]];
	};
	pool.getConnection = async () => {
		const conn = { log: [], released: 0 };
		conn.beginTransaction = async () => conn.log.push("begin");
		conn.query = async (sql, params) => {
			conn.log.push(["query", sql, params]);
			return [[{ sql }], []];
		};
		conn.commit = async () => {
			conn.log.push("commit");
			if (failCommits-- > 0) throw new Error("deadlock");
		};
		conn.rollback = async () => conn.log.push("rollback");
		conn.release = () => { conn.released++; };
		pool.connections.push(conn);
		return conn;
	};
	return pool;
}

test("query returns rows only and sends blank strings as NULL, as the PWA does", async () => {
	const pool = fakePool("a");
	const rows = await db.withPool(pool, () => db.query("SELECT ?", ["", "  ", "x", 0, null]));
	assert.deepEqual(rows, [{ pool: "a", sql: "SELECT ?" }]);
	assert.deepEqual(pool.calls[0].params, [null, null, "x", 0, null]);
	await db.withPool(pool, () => db.tenantQuery("tenant", "SELECT 2", [" "]));
	assert.deepEqual(pool.calls[1].params, [null]);
});

test("each call chain uses the pool it was bound to", async () => {
	const a = fakePool("a");
	const b = fakePool("b");
	const [ra, rb] = await Promise.all([
		db.withPool(a, async () => { await new Promise((r) => setTimeout(r, 5)); return db.query("SELECT 1"); }),
		db.withPool(b, () => new Promise((resolve) => setImmediate(() => resolve(db.query("SELECT 1")))))
	]);
	assert.equal(ra[0].pool, "a");
	assert.equal(rb[0].pool, "b");
	await assert.rejects(() => db.query("SELECT 1"), /not bound/);
});

test("runInCompanyTx commits, and retries after any error with a fresh connection", async () => {
	const pool = fakePool("a", { failCommits: 1 });
	let attempts = 0;
	const result = await db.withPool(pool, () => db.runInCompanyTx(async (tx) => {
		attempts++;
		await tx.query("INSERT ?", [""]);
		return "done";
	}, { backoffMs: 1 }));
	assert.equal(result, "done");
	assert.equal(attempts, 2);
	assert.equal(pool.connections.length, 2);
	assert.deepEqual(pool.connections[0].log.slice(-2), ["commit", "rollback"]);
	assert.deepEqual(pool.connections[1].log[1], ["query", "INSERT ?", [null]]);
	assert.equal(pool.connections[1].log.at(-1), "commit");
	assert.ok(pool.connections.every((conn) => conn.released >= 1));
});

test("runInCompanyTx gives up after four attempts and rethrows", async () => {
	const pool = fakePool("a");
	let attempts = 0;
	await assert.rejects(() => db.withPool(pool, () => db.runInCompanyTx("tenant", async () => {
		attempts++;
		throw new Error("refused");
	}, { backoffMs: 1 })), /refused/);
	assert.equal(attempts, 4);
	assert.ok(pool.connections.every((conn) => conn.log.at(-1) === "rollback" && conn.released === 1));
});
