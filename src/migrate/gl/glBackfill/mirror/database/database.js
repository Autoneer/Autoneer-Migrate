"use strict";

// Migrate's stand-in for AUTONEER-PWA src/database/database.js, used only by
// the mirrored GL backfill modules beside it.
//
// The PWA names the tenant schema inside each statement and runs every query
// on one shared pool. Here a pool is bound to a call chain with withPool(), so
// the mirrored code keeps calling query, tenantQuery and runInCompanyTx exactly
// as it does in the PWA. Kept from the PWA: rows-only results, blank string
// parameters sent as NULL, and transactions retried after any error. The PWA's
// tenant readiness guards are not mirrored; Migrate checks the tenant itself
// before a run starts.

const { AsyncLocalStorage } = require("async_hooks");

const boundPool = new AsyncLocalStorage();

function withPool(pool, work) {
	return boundPool.run(pool, work);
}

function currentPool() {
	const pool = boundPool.getStore();
	if (!pool) throw new Error("GL backfill database is not bound. Call it inside withPool().");
	return pool;
}

function sanitizeParams(params) {
	if (!Array.isArray(params)) return params;
	return params.map(p => (typeof p === "string" && p.trim() === "" ? null : p));
}

async function query(sql, params = []) {
	const [rows] = await currentPool().query(sql, sanitizeParams(params));
	return rows;
}

// companyDb only selects the PWA's readiness checks; the SQL names the schema.
async function tenantQuery(companyDb, sql, params = []) {
	return query(sql, params);
}

async function companyTransaction() {
	const conn = await currentPool().getConnection();
	await conn.beginTransaction();
	const txQuery = async (sql, params = []) => {
		const [rows] = await conn.query(sql, sanitizeParams(params));
		return rows;
	};
	const commit = async () => { await conn.commit(); conn.release(); };
	const rollback = async () => { try { await conn.rollback(); } finally { conn.release(); } };
	return { query: txQuery, commit, rollback };
}

async function runInCompanyTx(companyDbOrWorkFn, workFnOrOptions, optionsMaybe) {
	// Support legacy signature (companyDb, workFn, options) and newer (workFn, options)
	let workFn = workFnOrOptions;
	let options = optionsMaybe;
	if (typeof companyDbOrWorkFn === "function" && typeof workFnOrOptions !== "function") {
		workFn = companyDbOrWorkFn;
		options = workFnOrOptions;
	}
	const { maxRetries = 3, backoffMs = 120 } = options || {};

	if (typeof workFn !== "function") {
		throw new Error("workFn must be a function");
	}

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		const tx = await companyTransaction();
		try {
			const result = await workFn(tx);
			await tx.commit();
			return result;
		} catch (e) {
			try { await tx.rollback(); } catch (_) { }
			if (attempt === maxRetries) throw e;
			await new Promise(r => setTimeout(r, backoffMs * Math.pow(2, attempt)));
		}
	}
}

module.exports = {
	withPool,
	sanitizeParams,
	query,
	tenantQuery,
	companyTransaction,
	runInCompanyTx
};
