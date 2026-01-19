const express = require("express");
const firebird = require("../db/firebird");
const mysql = require("../db/mysql");
const { state } = require("../config/state");

const router = express.Router();

const timeout = (ms) =>
	new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), ms));

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

async function checkFirebird() {
	const resolved = firebird.resolveFirebirdConfig(state.firebird, process.env);
	if (!isFirebirdConfigured(resolved)) {
		return {
			ok: false,
			status: "NOT_CONFIGURED",
			message: "Not configured yet",
			details: ""
		};
	}

	try {
		await Promise.race([
			firebird.query(resolved, "select 1 from rdb$database"),
			timeout(2500)
		]);
		return {
			ok: true,
			status: "CONNECTED",
			message: "Connected",
			details: resolved.database ? `DB: ${resolved.database}` : ""
		};
	} catch (err) {
		return {
			ok: false,
			status: "DISCONNECTED",
			message: "Not connected",
			details: resolved.database ? `DB: ${resolved.database}` : ""
		};
	}
}

async function checkMysql() {
	const schemaName = state.schemaName;
	if (!isMysqlConfigured(state.mysql, schemaName)) {
		return {
			ok: false,
			status: "NOT_CONFIGURED",
			message: "Not configured yet",
			details: ""
		};
	}

	let pool = null;
	try {
		pool = await mysql.connectToSchema(state.mysql, schemaName);
		await Promise.race([
			pool.query({ sql: "select 1 as ok", timeout: 2500 }),
			timeout(2500)
		]);
		return {
			ok: true,
			status: "CONNECTED",
			message: "Connected",
			details: `Schema: ${schemaName}${state.mysql?.host ? ` • Host: ${state.mysql.host}` : ""}`
		};
	} catch (err) {
		return {
			ok: false,
			status: "DISCONNECTED",
			message: "Not connected",
			details: `Schema: ${schemaName}${state.mysql?.host ? ` • Host: ${state.mysql.host}` : ""}`
		};
	} finally {
		if (pool) {
			try {
				await pool.end();
			} catch (e) {
				// ignore
			}
		}
	}
}

router.get("/health/connections", async (req, res) => {
	const [firebirdStatus, mysqlStatus] = await Promise.all([checkFirebird(), checkMysql()]);
	res.json({
		firebird: firebirdStatus,
		mysql: mysqlStatus,
		ts: new Date().toISOString()
	});
});

module.exports = router;
