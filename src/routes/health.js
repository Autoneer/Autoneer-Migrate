const express = require("express");
const firebird = require("../db/firebird");
const mysql = require("../db/mysql");
const { state } = require("../config/state");
const { isRunActive } = require("../migrate/runner");

const router = express.Router();

const timeout = (ms) =>
	new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), ms));

const CACHE_TTL_MS = 3000;
const mysqlPoolCache = new Map();
const healthCache = {
	firebird: { ts: 0, data: null },
	mysql: new Map()
};

const isFirebirdConfigured = (config) => {
	const validation = firebird.validateFirebirdConfig(config);
	return !validation;
};

const isMysqlConfigured = (config, schemaName) => {
	if (!schemaName) return false;
	if (!config?.host) return false;
	if (!config?.user) return false;
	return true;
};

async function checkFirebird(timeoutMs) {
	const now = Date.now();
	if (healthCache.firebird.data && now - healthCache.firebird.ts < CACHE_TTL_MS) {
		return healthCache.firebird.data;
	}
	const resolved = firebird.resolveFirebirdConfig(state.firebird, process.env);
	if (!isFirebirdConfigured(resolved)) {
		const data = {
			ok: false,
			status: "NOT_CONFIGURED",
			message: "Not configured yet",
			details: ""
		};
		healthCache.firebird = { ts: now, data };
		return data;
	}

	try {
		await Promise.race([
			firebird.query(resolved, "select 1 from rdb$database"),
			timeout(timeoutMs)
		]);
		const data = {
			ok: true,
			status: "CONNECTED",
			message: "Connected",
			details: resolved.database ? `DB: ${resolved.database}` : ""
		};
		healthCache.firebird = { ts: now, data };
		return data;
	} catch (err) {
		const data = {
			ok: false,
			status: "DISCONNECTED",
			message: "Not connected",
			details: resolved.database ? `DB: ${resolved.database}` : ""
		};
		healthCache.firebird = { ts: now, data };
		return data;
	}
}

async function getMysqlPool(schemaName) {
	if (!schemaName) return null;
	if (mysqlPoolCache.has(schemaName)) {
		return mysqlPoolCache.get(schemaName);
	}
	const pool = await mysql.connectToSchema(state.mysql, schemaName);
	mysqlPoolCache.set(schemaName, pool);
	return pool;
}

async function checkMysql(timeoutMs) {
	const schemaName = state.schemaName;
	if (!isMysqlConfigured(state.mysql, schemaName)) {
		const data = {
			ok: false,
			status: "NOT_CONFIGURED",
			message: "Not configured yet",
			details: ""
		};
		healthCache.mysql.set(schemaName || "default", { ts: Date.now(), data });
		return data;
	}

	const cacheKey = schemaName || "default";
	const cached = healthCache.mysql.get(cacheKey);
	if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
		return cached.data;
	}

	let pool = null;
	try {
		pool = await getMysqlPool(schemaName);
		await Promise.race([
			pool.query({ sql: "select 1 as ok", timeout: timeoutMs }),
			timeout(timeoutMs)
		]);
		const data = {
			ok: true,
			status: "CONNECTED",
			message: "Connected",
			details: `Schema: ${schemaName}${state.mysql?.host ? ` • Host: ${state.mysql.host}` : ""}`
		};
		healthCache.mysql.set(cacheKey, { ts: Date.now(), data });
		return data;
	} catch (err) {
		const data = {
			ok: false,
			status: "DISCONNECTED",
			message: "Not connected",
			details: `Schema: ${schemaName}${state.mysql?.host ? ` • Host: ${state.mysql.host}` : ""}`
		};
		healthCache.mysql.set(cacheKey, { ts: Date.now(), data });
		return data;
	}
}

router.get("/health/connections", async (req, res) => {
	const runId = req.query.runId || null;
	const runActive = isRunActive(runId);
	const timeoutMs = runActive ? 5000 : 2500;
	const [firebirdStatus, mysqlStatus] = await Promise.all([checkFirebird(timeoutMs), checkMysql(timeoutMs)]);
	res.json({
		firebird: firebirdStatus,
		mysql: mysqlStatus,
		ts: new Date().toISOString()
	});
});

module.exports = router;
